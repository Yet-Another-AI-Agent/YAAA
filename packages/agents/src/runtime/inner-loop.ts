import type { IBus, ModelRole, IMeshGateway } from "@yaaa/interfaces";
import { container, type Container, PermissionEngine, pauseController, agentControl } from "@yaaa/platform";
import { type ArtifactRef, type ToolCall, isInsufficientFundsError } from "@yaaa/shared";
import { AGENT_REGISTRY } from "../registry.js";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { AIMessage, HumanMessage, ToolMessage, isAIMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

/**
 * Upper bound on inner-loop turns before an agent is failed for not finishing.
 * With the ReAct agent this maps to a LangGraph recursion limit — it exists to
 * stop a stuck/looping agent from running up unbounded API cost, not as a
 * target. Overridable per-run (WorkerOptions) or globally via YAAA_MAX_TURNS.
 */
const DEFAULT_MAX_TURNS = 200;

function resolveMaxTurns(): number {
  const raw = Number(process.env.YAAA_MAX_TURNS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_TURNS;
}

/**
 * LangGraph's recursion limit only applies between completed model/tool turns.
 * A provider request that never resolves would otherwise leave the agent in
 * "working" forever, so wrap the whole ReAct invocation in a wall-clock timeout.
 */
// A realistic budget for a whole subtask attempt (multi-slide deck build,
// research + synthesis, image generation). The old 120s ceiling routinely
// timeboxed still-working agents into "incomplete" checkpoints, which the outer
// loop then churned into failures. Still env-tunable for tighter/looser runs.
const DEFAULT_AGENT_INVOKE_TIMEOUT_MS = 480_000;
const DEFAULT_AGENT_FIRST_PROGRESS_TIMEOUT_MS = 30_000;
const DEFAULT_AGENT_CHECKPOINT_TIMEOUT_MS = 15_000;

class AgentInvocationTimeoutError extends Error {
  constructor(readonly timeoutMs: number, reason = "before completing") {
    super(`Agent model invocation timed out after ${timeoutMs}ms ${reason}.`);
    this.name = "AgentInvocationTimeoutError";
  }
}

/**
 * Raised (deliberately, not as a failure) when the supervisor/UI posts a `stop`
 * directive to a running agent. It routes into the same checkpoint/handoff path
 * a timebox uses, so the worker winds up gracefully with its progress preserved.
 */
class AgentStopRequestedError extends Error {
  constructor(readonly reason?: string) {
    super(`Agent stop requested by supervisor${reason ? `: ${reason}` : "."}`);
    this.name = "AgentStopRequestedError";
  }
}

function isAgentStopRequestedError(err: unknown): err is AgentStopRequestedError {
  return err instanceof AgentStopRequestedError;
}

function resolveAgentInvokeTimeout(): number {
  const raw =
    Number(process.env.YAAA_AGENT_INVOKE_TIMEOUT_MS) ||
    Number(process.env.YAAA_TIMEOUT) ||
    Number(process.env.MESH_TIMEOUT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_AGENT_INVOKE_TIMEOUT_MS;
}

function resolveAgentFirstProgressTimeout(invokeTimeoutMs: number): number {
  const raw = Number(process.env.YAAA_AGENT_FIRST_PROGRESS_TIMEOUT_MS);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_AGENT_FIRST_PROGRESS_TIMEOUT_MS;
  return Math.min(configured, invokeTimeoutMs);
}

function resolveAgentCheckpointTimeout(): number {
  const raw = Number(process.env.YAAA_AGENT_CHECKPOINT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_AGENT_CHECKPOINT_TIMEOUT_MS;
}

function isAgentInvocationTimeoutError(err: unknown): err is AgentInvocationTimeoutError {
  return err instanceof AgentInvocationTimeoutError || /Agent model invocation timed out/i.test(err instanceof Error ? err.message : String(err));
}

function logInner(agentId: string, message: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[YAAA:InnerLoop:${agentId}] ${message}${suffix}`);
}

function warnInner(agentId: string, message: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.warn(`[YAAA:InnerLoop:${agentId}] ${message}${suffix}`);
}

/**
 * Upper bound on the characters of a single tool observation fed back to the
 * model. Tools like browser.content return full page HTML; left unbounded they
 * bloat the request until the provider rejects it with an HTTP 400. Overridable
 * via YAAA_MAX_TOOL_OUTPUT.
 */
const DEFAULT_MAX_TOOL_OUTPUT = 20_000;

function resolveMaxToolOutput(): number {
  const raw = Number(process.env.YAAA_MAX_TOOL_OUTPUT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_TOOL_OUTPUT;
}

/**
 * How many times an agent may issue the exact same (tool, arguments) call
 * before the loop refuses to run it again. Repeating an identical call yields
 * identical output — no new information — so past this count we return a
 * directive telling the agent to change approach or finish, which is what
 * breaks the search/navigate thrash a failing tool would otherwise cause.
 */
const MAX_REPEATED_CALLS = 3;

/** The runtime registers this factory so tests can inject a fake chat model. */
export type ChatModelFactory = (roleOrModel: string) => BaseChatModel;

export interface WorkerOptions {
  agentId: string;
  taskId: string;
  templateName: string;
  instruction: string;
  contextArtifacts?: string[];
  maxTurns?: number;
  model?: string;
}

interface ToolObservation {
  capability: string;
  method: string;
  argSummary: string;
  result: string;
  ok: boolean;
  path?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown", markdown: "text/markdown", txt: "text/plain",
  json: "application/json", csv: "text/csv", tsv: "text/tab-separated-values",
  html: "text/html", htm: "text/html", css: "text/css",
  js: "text/javascript", jsx: "text/javascript", ts: "text/typescript", tsx: "text/typescript",
  py: "text/x-python", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pdf: "application/pdf",
};
function inferMime(path: string): string {
  return MIME_BY_EXT[path.split(".").pop()?.toLowerCase() ?? ""] ?? "text/plain";
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "agent";
}

function formatArtifactList(artifacts: ArtifactRef[]): string {
  if (artifacts.length === 0) return "- None recorded.";
  return artifacts
    .map((artifact) => `- ${artifact.path} (${artifact.mimeType}): ${artifact.description}`)
    .join("\n");
}

function formatToolObservations(observations: ToolObservation[] = []): string {
  if (observations.length === 0) return "- None recorded.";
  return observations
    .map((observation) => {
      const args = observation.argSummary ? ` (${observation.argSummary})` : "";
      const status = observation.ok ? "ok" : "failed";
      return `- ${observation.capability}.${observation.method}${args}: ${status} - ${observation.result}`;
    })
    .join("\n");
}

function promoteReadableDeliverablesFromToolEvidence(
  observations: ToolObservation[],
  artifacts: ArtifactRef[],
  role: string,
): void {
  const existing = new Set(artifacts.map((artifact) => artifact.path));
  for (const observation of observations) {
    if (!observation.ok || observation.capability !== "files" || observation.method !== "readFile") continue;
    const path = observation.path;
    if (!path || existing.has(path)) continue;
    if (path.startsWith("agent-workspaces/")) continue;
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (!["md", "markdown", "txt", "json", "csv", "tsv", "html", "pptx", "xlsx", "pdf"].includes(ext)) continue;
    artifacts.push({
      path,
      mimeType: inferMime(path),
      description: `Existing deliverable inspected by ${role}.`,
    });
    existing.add(path);
  }
}

async function writeIncompleteWorkArtifact(
  filesProvider: any,
  agentWorkspace: string,
  templateName: string,
  observations: ToolObservation[],
  checkpointSummary?: string,
): Promise<ArtifactRef> {
  const path = `${agentWorkspace}/incompleteWork.md`;
  await filesProvider.writeFile(
    path,
    `# Incomplete Work Evidence

- Status: INCOMPLETE
- Role: ${templateName}
- Created: ${new Date().toISOString()}

## What Happened

The agent gathered tool evidence but did not produce the requested deliverable file before the timebox ended.

## Agent Checkpoint

${checkpointSummary?.trim() || "The agent did not produce a checkpoint response before the checkpoint timeout."}

## Tool Evidence

${formatToolObservations(observations)}

## Continuation Guidance

- Do not restart from a blank slate.
- Use the tool evidence above as context.
- Create or repair the requested deliverable artifact, then verify it with available tools before handing off.
`,
  );
  return {
    path,
    mimeType: "text/markdown",
    description: `Incomplete work evidence produced by ${templateName}.`,
  };
}

async function requestTimeoutCheckpoint(input: {
  model: BaseChatModel;
  agentId: string;
  templateName: string;
  originalInstruction: string;
  observations: ToolObservation[];
}): Promise<string | undefined> {
  const timeoutMs = resolveAgentCheckpointTimeout();
  const evidence = formatToolObservations(input.observations);
  logInner(input.agentId, "requesting timeout checkpoint", {
    templateName: input.templateName,
    timeoutMs,
    toolObservationCount: input.observations.length,
  });
  try {
    const response = await withTimeout(
      (signal) =>
        input.model.invoke(
          [
            new HumanMessage(
              `Your previous agent run reached its timebox after making tool progress. Do not call tools now. Wind up with a concise checkpoint for the orchestrator.\n\nInclude:\n- current status\n- work completed\n- remaining work\n- whether another agent should continue, retry with a fresh timer, or change approach\n- exact artifact paths or evidence already observed\n\nOriginal assignment:\n${input.originalInstruction}\n\nTool evidence:\n${evidence}`,
            ),
          ],
          { signal } as any,
        ),
      timeoutMs,
      `Agent checkpoint timed out after ${timeoutMs}ms.`,
    );
    const text = finalTextOf([response as BaseMessage]);
    return text || undefined;
  } catch (err) {
    warnInner(input.agentId, "timeout checkpoint failed", {
      error: err instanceof Error ? err.message : String(err),
      timeoutMs,
    });
    return undefined;
  }
}

async function withTimeout<T>(
  promiseFactory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(message));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promiseFactory(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withAgentProgressTimeout<T>(
  promiseFactory: (signal: AbortSignal) => Promise<T>,
  options: {
    agentId: string;
    invokeTimeoutMs: number;
    firstProgressTimeoutMs: number;
    hasToolProgress: () => boolean;
    /**
     * Additional wall-clock granted mid-run (e.g. by a supervisor `extend`
     * directive). Read live each tick so a still-working agent can be given more
     * time instead of being aborted at the original deadline.
     */
    getExtensionMs?: () => number;
  },
): Promise<T> {
  const controller = new AbortController();
  let watchdog: NodeJS.Timeout | undefined;
  let settled = false;
  const startedAt = Date.now();

  const timeout = new Promise<never>((_, reject) => {
    watchdog = setInterval(() => {
      if (settled) return;
      const elapsed = Date.now() - startedAt;
      const effectiveInvokeTimeout =
        options.invokeTimeoutMs + Math.max(0, options.getExtensionMs?.() ?? 0);
      if (!options.hasToolProgress() && elapsed >= options.firstProgressTimeoutMs) {
        settled = true;
        controller.abort();
        warnInner(options.agentId, "first progress watchdog fired", {
          elapsedMs: elapsed,
          firstProgressTimeoutMs: options.firstProgressTimeoutMs,
          invokeTimeoutMs: options.invokeTimeoutMs,
        });
        reject(
          new AgentInvocationTimeoutError(
            options.firstProgressTimeoutMs,
            "before producing first tool progress",
          ),
        );
        return;
      }
      if (elapsed >= effectiveInvokeTimeout) {
        settled = true;
        controller.abort();
        warnInner(options.agentId, "invoke watchdog fired", {
          elapsedMs: elapsed,
          invokeTimeoutMs: effectiveInvokeTimeout,
          hadToolProgress: options.hasToolProgress(),
        });
        reject(
          new AgentInvocationTimeoutError(
            effectiveInvokeTimeout,
            options.hasToolProgress()
              ? "before completing after tool progress"
              : "before producing model/tool progress",
          ),
        );
      }
    }, 250);
  });

  try {
    return await Promise.race([promiseFactory(controller.signal), timeout]);
  } finally {
    settled = true;
    if (watchdog) clearInterval(watchdog);
  }
}

/** A LangGraph recursion-limit blow-out surfaces as an error naming "recursion". */
function isRecursionLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /recursion limit|GraphRecursionError/i.test(message);
}

function finalTextOf(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isAIMessage(message)) {
      const content = message.content;
      if (typeof content === "string") return content.trim();
      if (Array.isArray(content)) {
        return content
          .map((part) => (typeof part === "string" ? part : "text" in part ? String(part.text ?? "") : ""))
          .join("")
          .trim();
      }
    }
  }
  return "";
}

function isSyntheticToolTranscript(text: string): boolean {
  return /^\[Assistant called tool .+\]\(no text content\)$/i.test(text.trim());
}

/**
 * Bedrock's Converse API (which Mesh routes several models to) rejects any text
 * content block that is empty — but the ReAct loop routinely produces exactly
 * that: an assistant turn that is *only* a tool call carries `content: ""`, and
 * a tool can legitimately return an empty result. Left untouched these come back
 * as `400 ... text content blocks must be non-empty` on the next turn. This
 * substitutes a minimal non-empty placeholder for any blank text content so the
 * transcript stays valid without altering tool calls or real content.
 */
const EMPTY_CONTENT_PLACEHOLDER = "(no text content)";

function isBlank(content: unknown): boolean {
  return typeof content === "string" && content.trim() === "";
}

function withNonEmptyContent(message: BaseMessage): BaseMessage {
  const content = message.content;

  // The common case: a string body that is empty/whitespace-only.
  if (isBlank(content)) {
    if (message.getType() === "ai") {
      const ai = message as AIMessage;
      return new AIMessage({
        content: EMPTY_CONTENT_PLACEHOLDER,
        tool_calls: ai.tool_calls,
        invalid_tool_calls: ai.invalid_tool_calls,
        additional_kwargs: ai.additional_kwargs,
        response_metadata: ai.response_metadata,
        id: ai.id,
        name: ai.name,
      });
    }
    if (message.getType() === "tool") {
      const tm = message as ToolMessage;
      return new ToolMessage({
        content: EMPTY_CONTENT_PLACEHOLDER,
        tool_call_id: tm.tool_call_id,
        additional_kwargs: tm.additional_kwargs,
        id: tm.id,
        name: tm.name,
      });
    }
    return message;
  }

  // Structured content: blank out no individual text block.
  if (Array.isArray(content)) {
    let mutated = false;
    const parts = content.map((part: any) => {
      if (part?.type === "text" && (!part.text || String(part.text).trim() === "")) {
        mutated = true;
        return { ...part, text: EMPTY_CONTENT_PLACEHOLDER };
      }
      return part;
    });
    if (mutated) {
      const Ctor = (message as any).constructor;
      return new Ctor({ ...message, content: parts });
    }
  }

  return message;
}

function truncateForLog(value: string, max = 140): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * A short, human-readable description of the salient argument of a tool call —
 * the search query, the URL, the file path, the command — so the activity feed
 * says *what* the agent is doing, not just which method it called.
 */
function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const salientKeys = ["query", "url", "command", "path", "pattern", "selector", "source", "id"];
  for (const key of salientKeys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return `${key}: ${truncateForLog(value)}`;
    }
  }
  return "";
}

/** A short description of what a tool call produced, for the completion line. */
function summarizeToolResult(output: unknown): string {
  if (Array.isArray(output)) return `${output.length} result${output.length === 1 ? "" : "s"}`;
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.title === "string" && record.title.trim()) return truncateForLog(record.title);
    if (typeof record.url === "string" && record.url.trim()) return truncateForLog(record.url);
    if (typeof record.text === "string" && record.text.trim()) return truncateForLog(record.text);
    return "done";
  }
  if (typeof output === "string" && output.trim()) return truncateForLog(output);
  return "done";
}

function previewText(value: unknown, max = 260): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function resultString(output: unknown, key: string): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const value = (output as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function screenshotDataUrl(screenshotPath: string | undefined): string | undefined {
  if (!screenshotPath || !/\.(?:png|jpe?g|webp)$/i.test(screenshotPath)) return undefined;
  try {
    const data = fs.readFileSync(screenshotPath);
    const mimeType = /\.jpe?g$/i.test(screenshotPath)
      ? "image/jpeg"
      : /\.webp$/i.test(screenshotPath)
        ? "image/webp"
        : "image/png";
    return `data:${mimeType};base64,${data.toString("base64")}`;
  } catch {
    return undefined;
  }
}

function buildToolMetadata(
  capability: string,
  method: string,
  args: unknown,
  output?: unknown,
): Record<string, unknown> {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const metadata: Record<string, unknown> = { capability, method };
  const command = previewText(record.command, 220);
  if (command) metadata.command = command;
  const query = previewText(record.query, 220);
  if (query) metadata.query = query;
  const url = previewText(record.url, 220);
  if (url) metadata.url = url;
  const pathArg = previewText(record.path, 220);
  if (pathArg) metadata.path = pathArg;
  const selector = previewText(record.selector, 160);
  if (selector) metadata.selector = selector;

  const screenshotPath =
    resultString(output, "screenshotPath") ??
    (Array.isArray(output) && typeof (output as any).screenshotPath === "string"
      ? (output as any).screenshotPath
      : undefined) ??
    (method === "screenshot" && typeof output === "string" ? output : undefined);
  if (screenshotPath) metadata.screenshotPath = screenshotPath;
  const dataUrl = screenshotDataUrl(screenshotPath);
  if (dataUrl) metadata.screenshotDataUrl = dataUrl;

  if (output && typeof output === "object") {
    const stdout = previewText((output as Record<string, unknown>).stdout, 360);
    const stderr = previewText((output as Record<string, unknown>).stderr, 360);
    if (stdout) metadata.stdout = stdout;
    if (stderr) metadata.stderr = stderr;
    if (typeof (output as Record<string, unknown>).exitCode !== "undefined") {
      metadata.exitCode = (output as Record<string, unknown>).exitCode;
    }
    const title = previewText((output as Record<string, unknown>).title, 180);
    if (title) metadata.title = title;
  }
  if (Array.isArray(output) && output.length > 0) {
    metadata.results = output.slice(0, 3).map((item) => {
      if (!item || typeof item !== "object") return String(item);
      const result = item as Record<string, unknown>;
      return {
        title: previewText(result.title, 120),
        url: previewText(result.url, 160),
        description: previewText(result.description, 180),
      };
    });
  }
  return metadata;
}

function parseVerifierResult(text: string): { status: "passed" | "failed"; reason: string; findings: string[]; evidence: string[] } {
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const raw = JSON.parse(fenced?.[1] ?? text);
    if (raw?.status !== "passed" && raw?.status !== "failed") throw new Error("status must be passed or failed");
    if (!Array.isArray(raw.findings) || !Array.isArray(raw.evidence)) throw new Error("findings and evidence must be arrays");
    if (raw.status === "passed" && raw.evidence.length === 0) throw new Error("a passing result requires evidence");
    return { status: raw.status, reason: String(raw.summary ?? "No summary provided."), findings: raw.findings.map(String), evidence: raw.evidence.map(String) };
  } catch (error) {
    return { status: "failed", reason: `Verifier returned invalid structured output: ${error instanceof Error ? error.message : String(error)}`, findings: ["The verifier response could not be validated."], evidence: [] };
  }
}

function safeSerialize(output: unknown): string {
  if (output === undefined || output === null) {
    return JSON.stringify({ status: "ok" });
  }

  if (typeof output === "string") {
    const trimmed = output.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return JSON.stringify({ results: parsed });
        }
        if (typeof parsed !== "object" || parsed === null) {
          return JSON.stringify({ value: parsed });
        }
        return output;
      } catch {
        return output;
      }
    }
    return output;
  }

  if (Array.isArray(output)) {
    return JSON.stringify({ results: output });
  }

  if (typeof output === "object") {
    return JSON.stringify(output);
  }

  return JSON.stringify({ value: String(output) });
}

/**
 * The worker inner loop. Each subtask runs one agent as a LangGraph ReAct agent:
 * the model calls native tools (file capability, permission-gated) until it stops
 * and returns a final message. Completion is the model's decision — no bespoke
 * JSON envelope to parse, and the turn cap is only a runaway safety net.
 */
export class InnerLoop {
  private bus: IBus;
  private permissions: PermissionEngine;
  private scope: Container;
  private modelFactory: ChatModelFactory;
  private maxTurns: number;

  constructor(scope: Container = container) {
    this.scope = scope;
    this.bus = scope.resolve<IBus>("IBus");
    this.permissions = scope.resolve<PermissionEngine>("PermissionEngine");
    this.modelFactory = scope.resolve<ChatModelFactory>("ChatModelFactory");
    this.maxTurns = resolveMaxTurns();
  }

  async run(options: WorkerOptions): Promise<any> {
    const template = AGENT_REGISTRY[options.templateName];
    if (!template) {
      throw new Error(`Agent template ${options.templateName} not found in registry.`);
    }

    const { agentId, taskId, instruction, contextArtifacts = [] } = options;
    const agentWorkspace = `agent-workspaces/${safePathSegment(agentId)}`;
    this.maxTurns = options.maxTurns ?? resolveMaxTurns();
    logInner(agentId, "starting worker", {
      taskId,
      templateName: options.templateName,
      requestedModel: options.model ?? null,
      maxTurns: this.maxTurns,
      contextArtifacts: contextArtifacts.length,
    });

    // Anchor the agent's file-permission scope to the task workspace the file
    // provider actually writes to. `workingDir` is registered by the runtime;
    // fall back to process.cwd() only when a bare test scope omits it.
    let workspaceRoot: string;
    try {
      workspaceRoot = this.scope.resolve<string>("workingDir");
    } catch {
      workspaceRoot = process.cwd();
    }
    this.permissions.grantScope(agentId, {
      capabilities: template.capabilities,
      allowedPaths: [workspaceRoot],
      riskCeiling: template.riskCeiling,
    });
    // Start this agent with a clean control mailbox; supervisor/UI directives
    // (extend / redirect / stop) posted during the run are drained in preModelHook.
    agentControl.clear(agentId);
    logInner(agentId, "permission scope granted", {
      capabilities: template.capabilities,
      riskCeiling: template.riskCeiling,
    });

    await this.bus.publish(`task.${taskId}.agent.${agentId}.started`, {
      kind: "status",
      from: agentId,
      taskId,
      state: "working",
      note: `Spawned ${options.templateName} to execute subtask.`,
    });

    const artifacts: ArtifactRef[] = [];
    const toolObservations: ToolObservation[] = [];
    let sawToolProgress = false;
    const tools = this.buildTools(template.capabilities, template.role, agentId, taskId, artifacts, toolObservations, workspaceRoot, () => {
      sawToolProgress = true;
    });
    const modelName = options.model ?? template.modelRole;
    const model = this.modelFactory(modelName);
    logInner(agentId, "model factory resolved", {
      modelName,
      templateRole: template.role,
      toolCount: tools.length,
    });

    // Wall-clock granted mid-run by supervisor `extend` directives. Read live by
    // the timeout watchdog so a still-working agent gets more time rather than
    // being aborted at the original deadline.
    let grantedExtensionMs = 0;

    const agent = createReactAgent({
      llm: model,
      tools,
      prompt: template.systemPrompt,
      // Honour a user-issued pause between model turns without polling, drain any
      // supervisor control directives (extend / redirect / stop), and sanitise
      // the model input so no empty text content block reaches a Bedrock-backed
      // model. `llmInputMessages` overrides only what is sent to the LLM this
      // turn — the persisted transcript in `messages` is untouched.
      preModelHook: async (state: { messages: BaseMessage[] }) => {
        await pauseController.waitIfPaused(agentId);
        const base = state.messages.map(withNonEmptyContent);
        const injected: BaseMessage[] = [];
        for (const directive of agentControl.drain(agentId)) {
          if (directive.type === "extend") {
            grantedExtensionMs += Math.max(0, directive.additionalMs);
            await this.bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
              kind: "thought",
              from: agentId,
              content: `⏱️ Supervisor granted +${Math.round(directive.additionalMs / 1000)}s more time.${directive.reason ? ` ${directive.reason}` : ""}`,
            });
          } else if (directive.type === "redirect") {
            injected.push(
              new HumanMessage(
                `Supervisor course-correction — follow this updated assignment now:\n\n${directive.handsOn}`,
              ),
            );
            await this.bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
              kind: "thought",
              from: agentId,
              content: `🧭 Supervisor redirected the agent.${directive.reason ? ` ${directive.reason}` : ""}`,
            });
          } else if (directive.type === "stop") {
            throw new AgentStopRequestedError(directive.reason);
          }
        }
        return { llmInputMessages: [...base, ...injected] };
      },
    });

    const userParts = [instruction];
    if (contextArtifacts.length > 0) {
      userParts.push(`Context artifacts available:\n${contextArtifacts.join("\n")}`);
    }

    let finalState: { messages: BaseMessage[] };
    try {
      const invokeTimeoutMs = resolveAgentInvokeTimeout();
      const firstProgressTimeoutMs = resolveAgentFirstProgressTimeout(invokeTimeoutMs);
      logInner(agentId, "invoking ReAct agent", {
        modelName,
        invokeTimeoutMs,
        firstProgressTimeoutMs,
        recursionLimit: Math.max(4, this.maxTurns * 2),
      });
      await this.bus.publish(`task.${taskId}.agent.${agentId}.tool_requested`, {
        kind: "thought",
        from: agentId,
        content: `${agentId}: model.invoke - ${options.templateName} using ${modelName}; first progress timeout ${firstProgressTimeoutMs}ms`,
      });
      await this.bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
        kind: "thought",
        from: agentId,
        content: `Waiting for ${options.templateName} model response (${modelName}).`,
      });
      finalState = (await withAgentProgressTimeout(
        (signal) =>
          agent.invoke(
            { messages: [new HumanMessage(userParts.join("\n\n"))] },
            {
              recursionLimit: Math.max(4, this.maxTurns * 2),
              configurable: { thread_id: agentId },
              signal,
            },
          ),
        {
          agentId,
          invokeTimeoutMs,
          firstProgressTimeoutMs,
          hasToolProgress: () => sawToolProgress,
          getExtensionMs: () => grantedExtensionMs,
        },
      )) as { messages: BaseMessage[] };
      logInner(agentId, "model invocation completed", {
        messageCount: finalState.messages.length,
        sawToolProgress,
      });
    } catch (err) {
      if (isInsufficientFundsError(err)) throw err;
      if (isRecursionLimitError(err)) {
        throw new Error(
          `Agent inner-loop exceeded max turns of ${this.maxTurns} without yielding a result.`,
        );
      }
      if (isAgentStopRequestedError(err)) {
        // A supervisor/UI stop is intentional, not a failure: wind the worker up
        // with a checkpoint handoff so its progress is preserved and the outer
        // loop can decide what happens next.
        const reasonSuffix = err.reason ? ` Reason: ${err.reason}` : "";
        await this.bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
          kind: "thought",
          from: agentId,
          content: `🛑 Supervisor requested stop.${reasonSuffix} Winding up with a checkpoint handoff.`,
        });
        const checkpointSummary =
          sawToolProgress && toolObservations.length > 0
            ? await requestTimeoutCheckpoint({
                model,
                agentId,
                templateName: options.templateName,
                originalInstruction: userParts.join("\n\n"),
                observations: toolObservations,
              })
            : undefined;
        const summary = `Agent stopped by supervisor.${reasonSuffix}${checkpointSummary?.trim() ? `\nCheckpoint:\n${checkpointSummary.trim()}` : ""}`;
        const filesProvider = this.scope.resolve<any>("capability:files");
        artifacts.push(await writeIncompleteWorkArtifact(filesProvider, agentWorkspace, options.templateName, toolObservations, checkpointSummary));
        const handoffArtifacts = await this.ensureHandoffArtifacts({
          agentId,
          taskId,
          templateName: options.templateName,
          agentWorkspace,
          artifacts,
          summary,
          status: "INCOMPLETE",
          toolObservations,
        });
        await this.publishResult(taskId, agentId, handoffArtifacts, summary);
        logInner(agentId, "stopped by supervisor with checkpoint handoff", {
          artifactCount: handoffArtifacts.length,
          toolObservationCount: toolObservations.length,
        });
        return { artifacts: handoffArtifacts, summary, incomplete: true };
      }
      if (!isAgentInvocationTimeoutError(err)) {
        warnInner(agentId, "worker failed; starting self-introspection recovery", {
          error: err instanceof Error ? err.message : String(err),
          sawToolProgress,
        });
        await this.bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
          kind: "thought",
          from: agentId,
          content: "Agent hit a recoverable failure. Starting self-introspection before handing off.",
        });
        const invokeTimeoutMs = resolveAgentInvokeTimeout();
        const firstProgressTimeoutMs = resolveAgentFirstProgressTimeout(invokeTimeoutMs);
        try {
          finalState = (await withAgentProgressTimeout(
            (signal) =>
              agent.invoke(
                {
                  messages: [
                    new HumanMessage(userParts.join("\n\n")),
                    new HumanMessage(
                      `Your previous attempt failed before handoff.\n\nFailure: ${err instanceof Error ? err.message : String(err)}\n\nSelf-introspect now: identify the likely cause, decide whether to retry or change approach, then immediately do the best recovery action. If you can recover, create or verify the required deliverable artifacts and return a concise final summary with concrete evidence. If you cannot recover, return a concise handoff explaining the blocker and what a future agent should do differently.`,
                    ),
                  ],
                },
                {
                  recursionLimit: Math.max(4, this.maxTurns * 2),
                  configurable: { thread_id: `${agentId}:introspection` },
                  signal,
                },
              ),
            {
              agentId,
              invokeTimeoutMs,
              firstProgressTimeoutMs,
              hasToolProgress: () => sawToolProgress,
              getExtensionMs: () => grantedExtensionMs,
            },
          )) as { messages: BaseMessage[] };
          logInner(agentId, "self-introspection recovery completed", {
            messageCount: finalState.messages.length,
            artifactCount: artifacts.length,
          });
        } catch (recoveryErr) {
          warnInner(agentId, "self-introspection recovery failed", {
            error: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
            timedOut: isAgentInvocationTimeoutError(recoveryErr),
            sawToolProgress,
          });
          await this.publishFailedHandoff({
            agentId,
            taskId,
            templateName: options.templateName,
            agentWorkspace,
            artifacts,
            error: err,
            timedOut: false,
            sawToolProgress,
            toolObservations,
          });
          throw err;
        }
      } else {
      if (sawToolProgress && toolObservations.length > 0) {
        await this.bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
          kind: "thought",
          from: agentId,
          content: "Timebox reached after tool progress. Asking agent for a checkpoint before handing off.",
        });
        const checkpointSummary = await requestTimeoutCheckpoint({
          model,
          agentId,
          templateName: options.templateName,
          originalInstruction: userParts.join("\n\n"),
          observations: toolObservations,
        });
        const summary = checkpointSummary?.trim()
          ? `Agent timebox reached after tool progress. Checkpoint:\n${checkpointSummary.trim()}`
          : `Agent timebox reached after tool progress. Preserved incomplete work evidence for orchestrator review:\n${formatToolObservations(toolObservations)}`;
        const filesProvider = this.scope.resolve<any>("capability:files");
        artifacts.push(await writeIncompleteWorkArtifact(filesProvider, agentWorkspace, options.templateName, toolObservations, checkpointSummary));
        const handoffArtifacts = await this.ensureHandoffArtifacts({
          agentId,
          taskId,
          templateName: options.templateName,
          agentWorkspace,
          artifacts,
          summary,
          status: "INCOMPLETE",
          toolObservations,
        });
        await this.publishResult(taskId, agentId, handoffArtifacts, summary);
        logInner(agentId, "timeout after progress completed with incomplete work artifact", {
          artifactCount: handoffArtifacts.length,
          toolObservationCount: toolObservations.length,
        });
        return { artifacts: handoffArtifacts, summary, incomplete: true };
      }
      warnInner(agentId, "worker failed before normal completion", {
        error: err instanceof Error ? err.message : String(err),
        timedOut: isAgentInvocationTimeoutError(err),
        sawToolProgress,
      });
      await this.publishFailedHandoff({
        agentId,
        taskId,
        templateName: options.templateName,
        agentWorkspace,
        artifacts,
        error: err,
        timedOut: isAgentInvocationTimeoutError(err),
        sawToolProgress,
        toolObservations,
      });
      throw err;
      }
    }

    let finalText = finalTextOf(finalState.messages);
    logInner(agentId, "final text extracted", {
      chars: finalText.length,
      verifier: template.modelRole === "verifier",
    });

    if (isSyntheticToolTranscript(finalText) && artifacts.length === 0) {
      warnInner(agentId, "model ended on synthetic tool transcript without artifacts; starting self-introspection recovery", {
        sawToolProgress,
      });
      await this.bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
        kind: "thought",
        from: agentId,
        content: "Agent stopped after tool inspection without producing artifacts. Starting self-introspection before handoff.",
      });
      const invokeTimeoutMs = resolveAgentInvokeTimeout();
      const firstProgressTimeoutMs = resolveAgentFirstProgressTimeout(invokeTimeoutMs);
      try {
        finalState = (await withAgentProgressTimeout(
          (signal) =>
            agent.invoke(
              {
                messages: [
                  ...finalState.messages,
                  new HumanMessage(
                    "You stopped after inspecting tools/files and did not produce the requested deliverable or final handoff. Self-introspect now: identify what went wrong, decide whether to retry or change approach, then immediately do the best recovery action. If recoverable, create the required artifact files, verify them with available tools, and return a concise final summary with concrete evidence. If not recoverable, return a concise handoff explaining the blocker and what should be tried next.",
                  ),
                ],
              },
              {
                recursionLimit: Math.max(4, this.maxTurns * 2),
                configurable: { thread_id: `${agentId}:continuation` },
                signal,
              },
            ),
          {
            agentId,
            invokeTimeoutMs,
            firstProgressTimeoutMs,
            hasToolProgress: () => sawToolProgress,
            getExtensionMs: () => grantedExtensionMs,
          },
        )) as { messages: BaseMessage[] };
        finalText = finalTextOf(finalState.messages);
        logInner(agentId, "continuation final text extracted", {
          chars: finalText.length,
          artifactCount: artifacts.length,
        });
      } catch (err) {
        if (isInsufficientFundsError(err)) throw err;
        warnInner(agentId, "continuation failed", {
          error: err instanceof Error ? err.message : String(err),
          timedOut: isAgentInvocationTimeoutError(err),
          sawToolProgress,
        });
      }
    }

    if (isSyntheticToolTranscript(finalText)) {
      promoteReadableDeliverablesFromToolEvidence(toolObservations, artifacts, template.role);
      if (artifacts.length === 0) {
        if (toolObservations.length === 0) {
          const err = new Error(
            `Agent inspected tools but produced no deliverable artifacts. Observed tool work:\n${formatToolObservations(toolObservations)}`,
          );
          await this.publishFailedHandoff({
            agentId,
            taskId,
            templateName: options.templateName,
            agentWorkspace,
            artifacts,
            error: err,
            timedOut: false,
            sawToolProgress,
            toolObservations,
          });
          throw err;
        }
        const filesProvider = this.scope.resolve<any>("capability:files");
        artifacts.push(await writeIncompleteWorkArtifact(filesProvider, agentWorkspace, options.templateName, toolObservations));
        warnInner(agentId, "model produced only tool evidence; completing with incomplete work artifact", {
          artifactCount: artifacts.length,
          toolObservationCount: toolObservations.length,
        });
      }
      warnInner(agentId, "model ended on synthetic tool transcript; completing from produced artifacts", {
        artifactCount: artifacts.length,
      });
    }

    if (template.modelRole === "verifier") {
      const verdict = parseVerifierResult(finalText);
      const handoffArtifacts = await this.ensureHandoffArtifacts({
        agentId,
        taskId,
        templateName: options.templateName,
        agentWorkspace,
        artifacts: [],
        summary: verdict.reason,
        verifier: {
          status: verdict.status,
          findings: verdict.findings,
          evidence: verdict.evidence,
        },
      });
      await this.publishResult(taskId, agentId, handoffArtifacts, verdict.reason);
      return { ...verdict, artifacts: handoffArtifacts, summary: verdict.reason };
    }

    const summary = isSyntheticToolTranscript(finalText)
      ? `Subtask completed with produced artifacts:\n${formatArtifactList(artifacts)}`
      : finalText || "Subtask completed.";
    const finalArtifacts = await this.ensureHandoffArtifacts({
      agentId,
      taskId,
      templateName: options.templateName,
      agentWorkspace,
      artifacts,
      summary,
      toolObservations,
    });
    await this.publishResult(taskId, agentId, finalArtifacts, summary);
    logInner(agentId, "worker completed", {
      artifactCount: finalArtifacts.length,
      summaryChars: summary.length,
    });
    return { artifacts: finalArtifacts, summary };
  }

  private async ensureHandoffArtifacts(input: {
    agentId: string;
    taskId: string;
    templateName: string;
    agentWorkspace: string;
    artifacts: ArtifactRef[];
    summary: string;
    verifier?: { status: string; findings: string[]; evidence: string[] };
    failure?: { message: string; timedOut?: boolean; sawToolProgress?: boolean };
    status?: "COMPLETED" | "FAILED" | "INCOMPLETE";
    toolObservations?: ToolObservation[];
  }): Promise<ArtifactRef[]> {
    const filesProvider = this.scope.resolve<any>("capability:files");
    const artifacts = [...input.artifacts];
    const now = new Date().toISOString();
    const proofPath = `${input.agentWorkspace}/proofOfWork.md`;
    const handOffPath = `${input.agentWorkspace}/handOff.md`;
    const alreadyProduced = new Set(artifacts.map((artifact) => artifact.path));
    const status = input.failure ? "FAILED" : input.status ?? "COMPLETED";

    if (!alreadyProduced.has(proofPath)) {
      const statusLine = status !== "COMPLETED" ? `- Status: ${status}\n` : "";
      const verifierBlock = input.verifier
        ? `\n## Verification\n\n- Status: ${input.verifier.status}\n- Findings:\n${input.verifier.findings.map((item) => `  - ${item}`).join("\n") || "  - None recorded."}\n- Evidence:\n${input.verifier.evidence.map((item) => `  - ${item}`).join("\n") || "  - None recorded."}\n`
        : "";
      const failureBlock = input.failure
        ? `\n## Failure\n\n- Error: ${input.failure.message}\n- Type: ${input.failure.timedOut ? "model invocation timeout before first progress" : "agent execution failure"}\n\nThe agent did not produce usable work before failing. Treat this file as failure evidence, not completed task proof.\n`
        : "";
      await filesProvider.writeFile(
        proofPath,
        `# Proof of Work\n\n${statusLine}- Task: ${input.taskId}\n- Agent: ${input.agentId}\n- Role: ${input.templateName}\n- Created: ${now}\n\n## Result Summary\n\n${input.summary.trim() || "No summary was provided."}\n${failureBlock}${verifierBlock}\n## Tool Evidence\n\n${formatToolObservations(input.toolObservations)}\n\n## Produced Artifacts\n\n${formatArtifactList(input.artifacts)}\n`,
      );
      logInner(input.agentId, "wrote proofOfWork.md", {
        path: proofPath,
        failed: Boolean(input.failure),
      });
      artifacts.push({
        path: proofPath,
        mimeType: "text/markdown",
        description: `Proof of work produced by ${input.templateName}.`,
      });
    }

    if (!alreadyProduced.has(handOffPath)) {
      const failureSection = input.failure
        ? `\n## Failure Details\n\n- Error: ${input.failure.message}\n- Timed out: ${input.failure.timedOut ? "Yes" : "No"}\n- Tool progress observed before failure: ${input.failure.sawToolProgress ? "Yes" : "No"}\n\n`
        : "";
      const residualRisks = input.failure
        ? `- The assigned work was not completed by this agent.\n- The next agent should retry with a different model, narrower scope, or smaller first step before doing expensive research/tool work.`
        : status === "INCOMPLETE"
          ? "- The assigned work reached a timebox before final completion.\n- The next agent should continue from the listed artifacts and only redo work when the evidence is insufficient."
        : "- None identified by the runtime. Review the proof of work for task-specific caveats.";
      await filesProvider.writeFile(
        handOffPath,
        `# Agent Handoff\n\n- Task: ${input.taskId}\n- Agent: ${input.agentId}\n- Role: ${input.templateName}\n- Created: ${now}\n- Status: ${status}\n\n## Work Done\n\n${input.summary.trim() || "No summary was provided."}\n${failureSection}## Observations\n\n- Review the proof of work and produced artifacts listed below before deciding whether to continue, revise, or spin another agent.\n\n## Tool Evidence\n\n${formatToolObservations(input.toolObservations)}\n\n## Suggestions\n\n- Continue from the concrete artifacts and evidence, not from assumptions.\n- If follow-up work is needed, create a fresh handsOn.md that cites this handOff.md and the relevant artifacts.\n\n## Asset Metadata\n\n${formatArtifactList(artifacts)}\n\n## Residual Risks\n\n${residualRisks}\n\n## Continuation Instructions\n\n- Start by reading this handOff.md and proofOfWork.md.\n- Inspect any listed artifacts before modifying them.\n- Preserve useful outputs from this agent and only redo work when evidence shows a gap.\n`,
      );
      logInner(input.agentId, "wrote handOff.md", {
        path: handOffPath,
        failed: Boolean(input.failure),
      });
      artifacts.push({
        path: handOffPath,
        mimeType: "text/markdown",
        description: `Continuation handoff produced by ${input.templateName}.`,
      });
    }

    return artifacts;
  }

  private async publishFailedHandoff(input: {
    agentId: string;
    taskId: string;
    templateName: string;
    agentWorkspace: string;
    artifacts: ArtifactRef[];
    error: unknown;
    timedOut: boolean;
    sawToolProgress: boolean;
    toolObservations?: ToolObservation[];
  }): Promise<void> {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    try {
      logInner(input.agentId, "writing failure handoff", {
        timedOut: input.timedOut,
        sawToolProgress: input.sawToolProgress,
        error: message,
      });
      const handoffArtifacts = await this.ensureHandoffArtifacts({
        agentId: input.agentId,
        taskId: input.taskId,
        templateName: input.templateName,
        agentWorkspace: input.agentWorkspace,
        artifacts: input.artifacts,
        summary: message,
        failure: { message, timedOut: input.timedOut, sawToolProgress: input.sawToolProgress },
        toolObservations: input.toolObservations,
      });
      await this.publishResult(input.taskId, input.agentId, handoffArtifacts, message);
      logInner(input.agentId, "published failure artifacts", {
        artifactCount: handoffArtifacts.length,
      });
    } catch (handoffError) {
      console.warn(
        `[InnerLoop] Failed to write failure handoff for ${input.agentId}:`,
        handoffError,
      );
    }
  }

  private async publishResult(
    taskId: string,
    agentId: string,
    artifacts: ArtifactRef[],
    summary: string,
  ): Promise<void> {
    await this.bus.publish(`task.${taskId}.agent_message`, {
      kind: "result",
      from: agentId,
      taskId,
      artifacts,
      summary,
    });
  }

  /**
   * Build permission-gated LangChain tools for the agent's capabilities. Every
   * call routes through PermissionEngine (so approval prompts still fire), emits
   * the same bus events the UI listens for, and — for writes — records the file
   * as a produced artifact. A thrown provider error is returned to the model as
   * text so it can recover, mirroring the old loop's behaviour.
   */
  private buildTools(
    capabilities: string[],
    role: string,
    agentId: string,
    taskId: string,
    artifacts: ArtifactRef[],
    toolObservations: ToolObservation[],
    workspaceRoot: string,
    markToolProgress: () => void,
  ): StructuredToolInterface[] {
    const filesProvider = capabilities.includes("files") ? this.scope.resolve<any>("capability:files") : undefined;
    const verifierFileReadOnly = ["VerifierAgent", "QaTesterAgent", "CvTesterAgent"].includes(role);
    const bus = this.bus;
    const permissions = this.permissions;
    const optionalProvider = (token: string) => { try { return this.scope.resolve<any>(token); } catch { return undefined; } };

    // Per-run guardrails. `callCounts` is scoped to this buildTools call (one
    // agent run), so counts never leak across agents. `maxToolOutput` caps how
    // much of any single observation reaches the model.
    const callCounts = new Map<string, number>();
    const maxToolOutput = resolveMaxToolOutput();
    const capOutput = (serialized: string): string =>
      serialized.length > maxToolOutput
        ? `${serialized.slice(0, maxToolOutput)}\n\n[output truncated: ${serialized.length} chars total, showing first ${maxToolOutput}]`
        : serialized;

    const gated = (
      name: string,
      method: string,
      description: string,
      schema: z.ZodTypeAny,
      invoke: (args: any) => Promise<unknown>,
      onSuccess?: (args: any) => void,
      capability = "files",
    ) =>
      tool(
        async (args: any) => {
          // An identical (tool, args) call can only reproduce the previous
          // observation, so once it has been attempted MAX_REPEATED_CALLS times
          // we stop executing it and steer the agent instead of letting it
          // thrash a failing tool up to the recursion limit.
          const signature = `${capability}.${method}:${JSON.stringify(args ?? {})}`;
          const priorAttempts = callCounts.get(signature) ?? 0;
          callCounts.set(signature, priorAttempts + 1);
          if (priorAttempts >= MAX_REPEATED_CALLS) {
            warnInner(agentId, "blocked repeated tool call", {
              capability,
              method,
              priorAttempts,
              signature,
            });
            return `This exact ${capability}.${method} call has already been attempted ${priorAttempts} times with the same arguments and produced no new progress. Do not call it again with these arguments. Either try a materially different approach (new arguments, a different tool) or, if you cannot make progress, stop and report what you have found so far.`;
          }
          markToolProgress();

          const call: ToolCall = {
            id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            capability,
            method,
            args,
          };
          const argSummary = summarizeToolArgs(args);
          await bus.publish(`task.${taskId}.agent.${agentId}.tool_requested`, {
            kind: "thought",
            from: agentId,
            content: `${capability}.${method}${argSummary ? ` — ${argSummary}` : ""}`,
            metadata: buildToolMetadata(capability, method, args),
          });
          logInner(agentId, "tool requested", {
            capability,
            method,
            argSummary,
            attempt: priorAttempts + 1,
          });
          try {
            const output = await permissions.executeWithApproval(agentId, call, () => invoke(args));
            onSuccess?.(args);
            const resultSummary = summarizeToolResult(output);
            toolObservations.push({
              capability,
              method,
              argSummary,
              result: resultSummary,
              ok: true,
              path: typeof args?.path === "string" ? args.path : undefined,
            });
            await bus.publish(`task.${taskId}.agent.${agentId}.tool_requested`, {
              kind: "thought",
              from: agentId,
              content: `✓ ${capability}.${method}: ${resultSummary}`,
              metadata: buildToolMetadata(capability, method, args, output),
            });
            logInner(agentId, "tool completed", {
              capability,
              method,
              result: resultSummary,
            });
            return capOutput(safeSerialize(output));
          } catch (err: any) {
            const errorSummary = truncateForLog(err?.message ?? String(err));
            toolObservations.push({
              capability,
              method,
              argSummary,
              result: errorSummary,
              ok: false,
              path: typeof args?.path === "string" ? args.path : undefined,
            });
            await bus.publish(`task.${taskId}.agent.${agentId}.tool_requested`, {
              kind: "thought",
              from: agentId,
              content: `✗ ${capability}.${method} failed: ${errorSummary}`,
              metadata: {
                ...buildToolMetadata(capability, method, args),
                error: errorSummary,
              },
            });
            warnInner(agentId, "tool failed", {
              capability,
              method,
              error: err?.message ?? String(err),
            });
            return capOutput(`Tool execution error: ${err?.message ?? String(err)}`);
          }
        },
        { name, description, schema },
      );

    let result: StructuredToolInterface[] = filesProvider ? [
      gated("read_file", "readFile", "Read the complete text contents of a file in the workspace.",
        z.object({ path: z.string().describe("Path to the file.") }),
        (a) => filesProvider.readFile(a.path)),
      gated("write_file", "writeFile", "Create or overwrite a file with specific text content.",
        z.object({ path: z.string().describe("Path to the file."), content: z.string().describe("Content to write.") }),
        (a) => filesProvider.writeFile(a.path, a.content),
        (a) => artifacts.push({ path: a.path, mimeType: inferMime(a.path), description: `File produced by ${role}.` })),
      gated("list_files", "listFiles", "List files and folders in a directory.",
        z.object({ path: z.string().describe("Directory path to list.") }),
        (a) => filesProvider.listFiles(a.path)),
      gated("search_files", "searchFiles", "Search for files matching a wildcard pattern in a directory.",
        z.object({ pattern: z.string().describe("Wildcard pattern, e.g. *.md."), path: z.string().describe("Directory to search.") }),
        (a) => filesProvider.searchFiles(a.pattern, a.path)),
      gated("read_file_lines", "readLines", "Read a selected inclusive line range from a text file.", z.object({ path: z.string(), startLine: z.number().int().positive().default(1), endLine: z.number().int().positive().optional() }), (a) => filesProvider.readLines(a.path, a.startLine, a.endLine)),
      gated("write_file_lines", "writeLines", "Replace an inclusive line range in a text file.", z.object({ path: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive(), content: z.string() }), (a) => filesProvider.writeLines(a.path, a.startLine, a.endLine, a.content)),
      gated("delete_path", "delete", "Delete a file or directory.", z.object({ path: z.string(), recursive: z.boolean().default(false) }), (a) => filesProvider.delete(a.path, a.recursive)),
      gated("delete_file_lines", "deleteLines", "Delete an inclusive range of lines.", z.object({ path: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive() }), (a) => filesProvider.deleteLines(a.path, a.startLine, a.endLine)),
      gated("create_directory", "createDirectory", "Create a directory and missing parents.", z.object({ path: z.string() }), (a) => filesProvider.createDirectory(a.path)),
      gated("move_path", "move", "Move or rename a file or directory.", z.object({ source: z.string(), destination: z.string() }), (a) => filesProvider.move(a.source, a.destination)),
      gated("copy_path", "copy", "Copy a file or directory recursively.", z.object({ source: z.string(), destination: z.string() }), (a) => filesProvider.copy(a.source, a.destination)),
      gated("path_metadata", "stat", "Get file or directory metadata.", z.object({ path: z.string() }), (a) => filesProvider.stat(a.path)),
      gated("file_screenshot", "screenshot", "Render a text file or line range to a PNG screenshot.", z.object({ path: z.string(), outputPath: z.string(), startLine: z.number().int().positive().default(1), endLine: z.number().int().positive().optional() }), (a) => filesProvider.screenshot(a.path, a.outputPath, a.startLine, a.endLine)),
      gated("generate_image", "generateImage", "Generate an image using AI from a text prompt and save it to a file path in the workspace. Returns the status.",
        z.object({
          prompt: z.string().describe("Detailed description of the image to generate, e.g. 'a beautiful drawing of a plant cell'."),
          outputPath: z.string().describe("Path to save the generated PNG image in the workspace, e.g. 'images/plant_cell.png'.")
        }),
        async (a) => {
          const gateway = this.scope.resolve<any>("IMeshGateway");
          if (!gateway.generateImage) {
            throw new Error("Image generation is not supported by the current gateway.");
          }
          const base64Data = await gateway.generateImage(a.prompt);
          const buffer = Buffer.from(base64Data, "base64");
          await filesProvider.writeFile(a.outputPath, buffer);
          return { status: "success", message: `Generated image saved to ${a.outputPath}` };
        },
        (a) => artifacts.push({ path: a.outputPath, mimeType: "image/png", description: `AI generated image: ${a.prompt}` })),
    ] : [];

    if (verifierFileReadOnly) {
      const blockedFileWriters = new Set([
        "write_file",
        "write_file_lines",
        "delete_path",
        "delete_file_lines",
        "create_directory",
        "move_path",
        "copy_path",
        "generate_image",
      ]);
      result = result.filter((tool) => !blockedFileWriters.has(tool.name));
    }

    if (capabilities.includes("shell")) {
      const shell = optionalProvider("capability:shell");
      if (shell) {
      const withWorkspaceCwd = <T extends { cwd?: string }>(args: T): T & { cwd: string } => ({
        ...args,
        cwd: args.cwd
          ? path.isAbsolute(args.cwd)
            ? args.cwd
            : path.resolve(workspaceRoot, args.cwd)
          : workspaceRoot,
      });
      result.push(
        gated("execute_command", "execute", "Run a command with timeout and separate stdout/stderr. Defaults to the task working directory.", z.object({ command: z.string(), cwd: z.string().optional(), timeoutMs: z.number().positive().optional() }), (a) => shell.execute(a.command, withWorkspaceCwd(a)), undefined, "shell"),
        gated("open_terminal", "open", "Open a durable interactive terminal session. Defaults to the task working directory.", z.object({ id: z.string().optional(), cwd: z.string().optional(), shell: z.string().optional() }), (a) => shell.open(withWorkspaceCwd(a)), undefined, "shell"),
        gated("write_terminal", "write", "Write input to an existing terminal; optionally press Enter.", z.object({ id: z.string(), input: z.string(), enter: z.boolean().default(false) }), (a) => shell.write(a.id, a.input, a.enter), undefined, "shell"),
        gated("read_terminal", "read", "Read buffered output and status from an existing terminal.", z.object({ id: z.string(), from: z.number().int().nonnegative().default(0), clear: z.boolean().default(false) }), (a) => shell.read(a.id, a.from, a.clear), undefined, "shell"),
        gated("list_terminals", "list", "List terminal sessions for reattachment.", z.object({}), () => shell.list(), undefined, "shell"),
        gated("navigate_terminal", "navigate", "Change an interactive terminal's working directory.", z.object({ id: z.string(), cwd: z.string() }), (a) => shell.navigate(a.id, a.cwd), undefined, "shell"),
        gated("resize_terminal", "resize", "Resize an interactive terminal.", z.object({ id: z.string(), cols: z.number().int().positive(), rows: z.number().int().positive() }), (a) => shell.resize(a.id, a.cols, a.rows), undefined, "shell"),
        gated("terminate_terminal", "terminate", "Terminate an interactive terminal.", z.object({ id: z.string(), signal: z.string().default("SIGTERM") }), (a) => shell.terminate(a.id, a.signal), undefined, "shell"),
        gated("terminal_screenshot", "screenshot", "Capture terminal output as a PNG.", z.object({ id: z.string(), outputPath: z.string() }), (a) => shell.screenshot(a.id, a.outputPath), undefined, "shell"),
      );
      }
    }
    if (capabilities.includes("web")) {
      const web = optionalProvider("capability:web");
      if (web) {
      result.push(
        gated("web_search", "search", "Search the web and return titled result URLs and snippets.", z.object({ query: z.string(), limit: z.number().int().positive().max(30).default(10), safeSearch: z.enum(["strict", "moderate", "off"]).default("moderate") }), (a) => web.search(a.query, a), undefined, "web"),
        gated("fetch_web_page", "fetch", "Fetch and parse a web page into clean text and links.", z.object({ url: z.string().url(), selector: z.string().optional(), timeoutMs: z.number().positive().optional(), maxChars: z.number().positive().optional() }), (a) => web.fetch(a.url, a), undefined, "web"),
        gated("web_results_screenshot", "screenshot", "Render search or parsed data as a PNG screenshot.", z.object({ results: z.unknown(), outputPath: z.string() }), (a) => web.screenshot(a.results, a.outputPath), undefined, "web"),
      );
      }
    }
    if (capabilities.includes("browser")) {
      const browser = optionalProvider("capability:browser");
      if (browser) {
      result.push(
        gated("open_browser", "open", "Open a persistent Chromium browser session.", z.object({ id: z.string().optional(), headless: z.boolean().default(true) }), (a) => browser.open(a), undefined, "browser"),
        gated("browser_navigate", "navigate", "Navigate a browser session to a URL.", z.object({ id: z.string(), url: z.string().url(), timeoutMs: z.number().positive().default(30000) }), (a) => browser.navigate(a.id, a.url, a.timeoutMs), undefined, "browser"),
        gated("browser_click", "click", "Click an element selected with CSS or Playwright syntax.", z.object({ id: z.string(), selector: z.string() }), (a) => browser.click(a.id, a.selector), undefined, "browser"),
        gated("browser_type", "type", "Type into an element, optionally clearing and submitting.", z.object({ id: z.string(), selector: z.string(), text: z.string(), clear: z.boolean().default(false), submit: z.boolean().default(false) }), (a) => browser.type(a.id, a.selector, a.text, a), undefined, "browser"),
        gated("browser_fill_form", "fill", "Fill multiple form fields by selector.", z.object({ id: z.string(), values: z.record(z.string(), z.union([z.string(), z.boolean()])) }), (a) => browser.fill(a.id, a.values), undefined, "browser"),
        gated("browser_select", "select", "Select one or more options.", z.object({ id: z.string(), selector: z.string(), values: z.union([z.string(), z.array(z.string())]) }), (a) => browser.select(a.id, a.selector, a.values), undefined, "browser"),
        gated("browser_press", "press", "Press a keyboard key on an element.", z.object({ id: z.string(), selector: z.string(), key: z.string() }), (a) => browser.press(a.id, a.selector, a.key), undefined, "browser"),
        gated("browser_hover", "hover", "Hover over an element.", z.object({ id: z.string(), selector: z.string() }), (a) => browser.hover(a.id, a.selector), undefined, "browser"),
        gated("browser_reload", "reload", "Reload the current page.", z.object({ id: z.string() }), (a) => browser.reload(a.id), undefined, "browser"),
        gated("browser_back", "back", "Navigate backward.", z.object({ id: z.string() }), (a) => browser.back(a.id), undefined, "browser"),
        gated("browser_forward", "forward", "Navigate forward.", z.object({ id: z.string() }), (a) => browser.forward(a.id), undefined, "browser"),
        gated("browser_wait", "waitFor", "Wait for an element to appear.", z.object({ id: z.string(), selector: z.string(), timeoutMs: z.number().positive().default(30000) }), (a) => browser.waitFor(a.id, a.selector, a.timeoutMs), undefined, "browser"),
        gated("browser_content", "content", "Get rendered text and HTML from an element.", z.object({ id: z.string(), selector: z.string().default("body") }), (a) => browser.content(a.id, a.selector), undefined, "browser"),
        gated("browser_screenshot", "screenshot", "Capture a page, full page, or element screenshot.", z.object({ id: z.string(), outputPath: z.string(), fullPage: z.boolean().default(false), selector: z.string().optional() }), (a) => browser.screenshot(a.id, a.outputPath, a), undefined, "browser"),
        gated("close_browser", "close", "Close a Chromium session.", z.object({ id: z.string() }), (a) => browser.close(a.id), undefined, "browser"),
      );
      }
    }
    return result;
  }
}
