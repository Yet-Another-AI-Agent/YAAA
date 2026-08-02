import type { IBus, ModelRole, ModelResolver, IMeshGateway } from "@yaaa/interfaces";
import type { ExecutionSessionManagerLike } from "@yaaa/interfaces";
import { container, type Container, PermissionEngine, pauseController, agentControl, orchestratorMailbox, type IEventQueue } from "@yaaa/platform";
import { type ArtifactRef, type ToolCall, type SubSubtask, type ExecutionContract, deriveSubSubtasksFromSubtask, getSkill, isInsufficientFundsError, resolveFileRoots } from "@yaaa/shared";
import { AGENT_REGISTRY } from "../registry.js";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { AIMessage, HumanMessage, ToolMessage, isAIMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { CodeReviewPreflightTool } from "../tools/code-review-preflight.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

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
const DEFAULT_AGENT_INVOKE_TIMEOUT_MS = 1_440_000;
// Do not kill a model merely because it has not called a tool yet. Reasoning,
// structured output, and provider-side queueing can all legitimately precede
// the first tool observation. Operators may still opt into a shorter watchdog
// with YAAA_AGENT_FIRST_PROGRESS_TIMEOUT_MS.
const DEFAULT_AGENT_FIRST_PROGRESS_TIMEOUT_MS = 1_440_000;
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

function isUnavailableModelError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /(?:model|provider|service).*(?:unavailable|not found|not supported)|(?:temporarily|currently) unavailable|\b(?:404|503)\b.*(?:model|unavailable|provider|service)/i.test(message);
}

function logInner(agentId: string, message: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[YAAA:InnerLoop:${agentId}] ${message}${suffix}`);
}

const LLM_CONSOLE_PREVIEW_LIMIT = 4_000;

function truncateLlmConsole(value: unknown, max = LLM_CONSOLE_PREVIEW_LIMIT): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} chars]` : text;
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
const DEFAULT_MAX_TOOL_OUTPUT = 6_000;

function messageContentChars(message: BaseMessage): number {
  return typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length;
}

function truncateProviderMessage(message: BaseMessage, maxChars: number): BaseMessage {
  if (messageContentChars(message) <= maxChars) return message;
  const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  const bounded = `${content.slice(0, Math.max(0, maxChars - 80))}\n[…message content truncated by the assignment context budget]`;
  if (message.getType() === "tool") {
    const toolMessage = message as ToolMessage;
    return new ToolMessage({
      content: bounded,
      tool_call_id: toolMessage.tool_call_id,
      name: toolMessage.name,
    });
  }
  if (message.getType() === "human") return new HumanMessage(bounded);
  return message;
}

function compactToolResultMessages(messages: BaseMessage[], keepLeading = 2, keepRecent = 4, maxChars?: number): BaseMessage[] {
  if (messages.length <= keepLeading + keepRecent && !maxChars) return messages;
  // Compact whole conversational units. An AI tool-call message and all of
  // its immediately following ToolMessages must travel together; slicing by
  // raw message index can leave an orphaned function response or function call
  // in the provider-facing history, which Gemini rejects with a 400 count
  // mismatch.
  const units: BaseMessage[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    const toolCalls = message.getType() === "ai" ? (message as AIMessage).tool_calls : undefined;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const unit = [message];
      let cursor = index + 1;
      while (cursor < messages.length && messages[cursor].getType() === "tool") {
        unit.push(messages[cursor]);
        cursor += 1;
      }
      units.push(unit);
      index = cursor - 1;
    } else {
      units.push([message]);
    }
  }
  if (units.length <= 2) {
    if (!maxChars) return messages;
    const bounded = messages.map((message, index) => truncateProviderMessage(message, index === 0 ? Math.max(800, Math.floor(maxChars * 0.6)) : Math.max(400, Math.floor(maxChars / 2))));
    return bounded.reduce((total, message) => total + messageContentChars(message), 0) <= maxChars
      ? bounded
      : [truncateProviderMessage(bounded[0], Math.max(400, maxChars - 300)), new HumanMessage("[context omitted to satisfy the planner-selected input budget]")].filter((message): message is BaseMessage => Boolean(message));
  }
  const leading: BaseMessage[][] = [];
  let leadingCount = 0;
  while (leading.length < units.length && leadingCount < keepLeading) {
    leading.push(units[leading.length]);
    leadingCount += units[leading.length - 1].length;
  }
  const trailing: BaseMessage[][] = [];
  let trailingCount = 0;
  for (let index = units.length - 1; index >= leading.length && trailingCount < keepRecent; index -= 1) {
    trailing.unshift(units[index]);
    trailingCount += units[index].length;
  }
  const trailingStart = units.length - trailing.length;
  const middle = units.slice(leading.length, trailingStart).flat();
  if (middle.length === 0) {
    if (!maxChars) return messages;
    const bounded = messages.map((message, index) => truncateProviderMessage(
      message,
      index === 0 ? Math.max(800, Math.floor(maxChars * 0.6)) : Math.max(400, Math.floor(maxChars / Math.max(2, messages.length))),
    ));
    return bounded.reduce((total, message) => total + messageContentChars(message), 0) <= maxChars
      ? bounded
      : [truncateProviderMessage(bounded[0], Math.max(400, maxChars - 300)), new HumanMessage("[context omitted to satisfy the planner-selected input budget]")].filter((message): message is BaseMessage => Boolean(message));
  }
  const middleChars = middle.reduce((total, msg) => {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    return total + content.length;
  }, 0);
  // Do not retain an unbounded sequence of small AI/tool messages. Keeping
  // their objects was the remaining source of context growth after large
  // result elision was added. A single human summary preserves the fact that
  // history was omitted while the leading frame and recent tool-call pair
  // remain available to the model.
  const compactedMiddle = new HumanMessage(
    `[earlier tool result elided; ${middle.length} earlier messages compacted (${middleChars} chars); re-run a tool if an omitted observation is needed]`,
  );
  const compacted = [...leading.flat(), compactedMiddle, ...trailing.flat()];
  if (!maxChars) return compacted;

  let bounded = compacted;
  const totalChars = () => bounded.reduce((total, message) => total + messageContentChars(message), 0);
  if (totalChars() <= maxChars) return bounded;

  // Preserve the initial assignment and the most recent tool-call unit, then
  // shrink only tool/human payloads. Never slice an AI tool call away from its
  // ToolMessage response: provider protocols require those parts to remain
  // paired.
  const leadingBudget = Math.min(Math.max(800, Math.floor(maxChars * 0.35)), maxChars);
  bounded = bounded.map((message, index) => {
    const budget = index === 0 ? leadingBudget : Math.max(400, Math.floor(maxChars / Math.max(2, bounded.length)));
    return truncateProviderMessage(message, budget);
  });
  if (totalChars() <= maxChars) return bounded;

  // A final compact marker is safe because it is a human message and does not
  // introduce an unmatched function response. The durable transcript still
  // contains the complete unbounded messages for replay/audit.
  const first = bounded[0] ? truncateProviderMessage(bounded[0], Math.max(400, Math.floor(maxChars * 0.6))) : undefined;
  const recent = bounded.slice(-2).filter((message) => message !== bounded[0]);
  const marker = new HumanMessage("[older context omitted to satisfy the planner-selected input budget; request the needed file range again]");
  return [first, marker, ...recent].filter((message): message is BaseMessage => Boolean(message));
}

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
const MAX_IDENTICAL_PROGRESS = 2;

/** The runtime registers this factory so tests can inject a fake chat model. */
export type ChatModelFactory = (roleOrModel: string) => BaseChatModel;

export interface WorkerOptions {
  agentId: string;
  taskId: string;
  templateName: string;
  roleNames?: string[];
  capabilities?: string[];
  instruction: string;
  subtaskId?: string;
  subSubtasks?: SubSubtask[];
  contextArtifacts?: string[];
  maxTurns?: number;
  model?: string;
  executionContract?: ExecutionContract;
  skillIds?: string[];
  contextSections?: {
    skillChars?: number;
    dependencyChars?: number;
    fileExcerptChars?: number;
    included?: string[];
    omitted?: string[];
  };
}

interface ToolObservation {
  capability: string;
  method: string;
  argSummary: string;
  result: string;
  ok: boolean;
  path?: string;
  metadata?: Record<string, unknown>;
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

function fileEvidence(pathname: string, content: string, startLine = 1, endLine?: number): Record<string, any> {
  const lines = content.split(/\r?\n/);
  return {
    path: pathname,
    startLine,
    endLine: endLine ?? Math.max(startLine, startLine + lines.length - 1),
    totalLines: lines.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    content,
  };
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
      const metadata = formatToolObservationMetadata(observation.metadata);
      return `- ${observation.capability}.${observation.method}${args}: ${status} - ${observation.result}${metadata}`;
    })
    .join("\n");
}

function formatToolObservationMetadata(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) return "";
  const details: string[] = [];
  const keys = ["path", "screenshotPath", "command", "url", "query", "title", "stdout", "stderr", "exitCode", "timedOut", "durationMs"];
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      details.push(`${key}: ${value.trim()}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      details.push(`${key}: ${String(value)}`);
    }
  }
  if (Array.isArray(metadata.results) && metadata.results.length > 0) {
    const resultTitles = metadata.results
      .slice(0, 3)
      .map((item) => {
        if (!item || typeof item !== "object") return String(item);
        const record = item as Record<string, unknown>;
        return [record.title, record.url].filter((part) => typeof part === "string" && part).join(" ");
      })
      .filter(Boolean);
    if (resultTitles.length > 0) details.push(`results: ${resultTitles.join(" | ")}`);
  }
  return details.length > 0 ? ` [${details.join("; ")}]` : "";
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

/**
 * Shell commands can create binary deliverables without going through the
 * write_file tool, so tool callbacks alone are not a complete artifact ledger.
 * Reconcile the ledger with the task workspace immediately before publishing
 * the result. Agent-private handoff files stay private to that agent's record.
 */
function collectWorkspaceArtifacts(
  workspaceRoot: string,
  artifacts: ArtifactRef[],
  role: string,
  currentAgentWorkspace?: string,
  createdAfterMs = 0,
): void {
  const existing = new Set(artifacts.map((artifact) => path.normalize(artifact.path)));
  const ignoredDirectories = new Set(["agent-workspaces", "node_modules", ".git", ".yaaa"]);
  const deliverableExtensions = new Set([
    "pptx", "pdf", "png", "jpg", "jpeg", "webp", "gif", "svg",
    "md", "markdown", "txt", "json", "csv", "tsv", "html", "xlsx", "xls",
    "js", "mjs", "cjs",
  ]);
  const walk = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || ignoredDirectories.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      const extension = path.extname(entry.name).slice(1).toLowerCase();
      if (!deliverableExtensions.has(extension)) continue;
      if (/^(?:hands?on|hands?_off|handoff|proofofwork|incompletework)\.md$/i.test(entry.name)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absolute);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size === 0) continue;
      // Do not turn the task workspace (which may contain the user's existing
      // repository and build output) into the worker's artifact list. Files
      // explicitly written through a tool are already tracked above; this
      // reconciliation pass is only for files created by this run's shell
      // commands.
      if (createdAfterMs > 0 && stat.mtimeMs < createdAfterMs) continue;
      const relative = path.relative(workspaceRoot, absolute).split(path.sep).join("/");
      if (relative.startsWith("agent-workspaces/") || existing.has(path.normalize(relative))) continue;
      artifacts.push({
        path: relative,
        mimeType: inferMime(relative),
        description: `Workspace artifact discovered after ${role} execution.`,
      });
      existing.add(path.normalize(relative));
    }
  };
  walk(workspaceRoot);
  // Shell-created deliverables are often written beside the agent's
  // handsOn/proof files. The task root scan intentionally hides all
  // agent-workspaces to avoid leaking sibling-private files, so scan only the
  // current agent's workspace explicitly and expose its real deliverables.
  if (currentAgentWorkspace) walk(currentAgentWorkspace);
}

/** A producer must never hand an empty required deliverable to verification. */
function findEmptyRequiredArtifact(workspaceRoot: string, requiredArtifacts: string[]): string | undefined {
  for (const artifactPath of requiredArtifacts) {
    if (!artifactPath || artifactPath.startsWith("agent-workspaces/")) continue;
    const absolute = path.resolve(workspaceRoot, artifactPath);
    try {
      const stat = fs.statSync(absolute);
      if (stat.isFile() && stat.size === 0) return artifactPath;
    } catch {
      // Missing artifacts are handled by the normal completion/verification
      // path; this guard is specifically for an artifact that exists but is
      // provably invalid.
    }
  }
  return undefined;
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

## Why This Was Not Completed

The deliverable was not completed before the timebox. The checkpoint above and the tool evidence below are the blocker evidence. A future agent must confirm the blocker before repeating any expensive or unsuccessful approach.

## Tool Evidence

${formatToolObservations(observations)}

## Continuation Guidance

- Do not restart from a blank slate.
- Use the tool evidence above as context.
- Do not repeat an approach shown by the evidence to be blocked or unsuccessful; record the reason before trying an alternative.
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
              `Your previous agent run reached its timebox after making tool progress. Do not call tools now. Wind up with a concise checkpoint for the orchestrator.\n\nInclude:\n- current status\n- work completed\n- remaining work\n- exactly what could not be completed and why\n- approaches already attempted and what failed or was blocked\n- whether another agent should continue, retry with a fresh timer, or change approach\n- exact artifact paths or evidence already observed\n- explicit instructions about what the next agent should not repeat\n\nOriginal assignment:\n${input.originalInstruction}\n\nTool evidence:\n${evidence}`,
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
    consumeLiveControl?: () => { additionalMs: number; stopReason?: string };
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
      const liveControl = options.consumeLiveControl?.() ?? { additionalMs: 0 };
      if (liveControl.stopReason !== undefined) {
        settled = true;
        controller.abort();
        reject(new AgentStopRequestedError(liveControl.stopReason));
        return;
      }
      const elapsed = Date.now() - startedAt;
      const effectiveInvokeTimeout =
        options.invokeTimeoutMs
        + Math.max(0, options.getExtensionMs?.() ?? 0)
        + Math.max(0, liveControl.additionalMs);
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

/**
 * Keep the provider-facing transcript internally consistent. Some
 * OpenAI-compatible gateways occasionally return a parsed `tool_calls` array
 * that differs from the raw `additional_kwargs.tool_calls`, or a partial set
 * of ToolMessages after a model turn is interrupted. Gemini rejects that
 * history instead of attempting to recover from it.
 *
 * Only the input copy is repaired. The LangGraph state remains untouched so
 * debugging and handoff artifacts still contain the original evidence.
 */
function repairToolCallTranscript(messages: BaseMessage[]): BaseMessage[] {
  const repaired: BaseMessage[] = [];
  let repairedCalls = 0;
  let collapsedBatches = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.getType() !== "ai") {
      // A ToolMessage without an immediately preceding AI tool-call turn is
      // invalid for Gemini and cannot be meaningfully paired later.
      if (message.getType() !== "tool") repaired.push(message);
      continue;
    }

    const ai = message as AIMessage;
    const calls = Array.isArray(ai.tool_calls) ? ai.tool_calls : [];
    if (calls.length === 0) {
      const { tool_calls: rawToolCalls, ...additionalKwargs } = ai.additional_kwargs ?? {};
      if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
        repaired.push(new AIMessage({
          content: isBlank(ai.content) ? EMPTY_CONTENT_PLACEHOLDER : ai.content,
          tool_calls: [],
          invalid_tool_calls: [],
          additional_kwargs: additionalKwargs,
          response_metadata: ai.response_metadata,
          id: ai.id,
          name: ai.name,
        }));
      } else {
        repaired.push(message);
      }
      continue;
    }

    const followingTools: ToolMessage[] = [];
    const seenResponseIds = new Set<string>();
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor].getType() === "tool") {
      const toolMessage = messages[cursor] as ToolMessage;
      // A retry/interruption can leave the same tool response in the
      // LangGraph transcript more than once. Gemini counts response parts,
      // so forwarding duplicates causes its 400 mismatch error.
      if (typeof toolMessage.tool_call_id === "string" && !seenResponseIds.has(toolMessage.tool_call_id)) {
        followingTools.push(toolMessage);
        seenResponseIds.add(toolMessage.tool_call_id);
      }
      cursor += 1;
    }
    const responseIds = new Set(followingTools.map((toolMessage) => toolMessage.tool_call_id));
    const seenCallIds = new Set<string>();
    const validCalls = calls.filter((call) => {
      if (typeof call.id !== "string" || !responseIds.has(call.id) || seenCallIds.has(call.id)) return false;
      seenCallIds.add(call.id);
      return true;
    });
    if (validCalls.length !== calls.length) repairedCalls += calls.length - validCalls.length;

    // Do not carry raw provider tool calls alongside the normalized LangChain
    // calls. Keeping both is what creates the function-call/function-response
    // count mismatch on the next Gemini request.
    // Gemini's function-response protocol is stricter than the generic
    // LangChain tool protocol: a model turn containing several calls can be
    // rejected by some Mesh routes even when the IDs technically pair. Keep
    // the provider-facing history conservative. The calls already ran and
    // their durable action events remain the source of truth, so retaining
    // one completed pair is safer than sending a multi-call turn that can
    // strand the entire agent with a 400 request error.
    const providerCalls = validCalls.slice(0, 1);
    const providerCallIds = new Set(providerCalls.map((call) => call.id));
    if (validCalls.length > providerCalls.length) {
      collapsedBatches += validCalls.length - providerCalls.length;
    }
    const { tool_calls: _rawToolCalls, ...additionalKwargs } = ai.additional_kwargs ?? {};
    repaired.push(new AIMessage({
      content: isBlank(ai.content) ? EMPTY_CONTENT_PLACEHOLDER : ai.content,
      tool_calls: providerCalls,
      invalid_tool_calls: [],
      additional_kwargs: additionalKwargs,
      response_metadata: ai.response_metadata,
      id: ai.id,
      name: ai.name,
    }));
    for (const toolMessage of followingTools) {
      if (providerCallIds.has(toolMessage.tool_call_id)) {
        repaired.push(toolMessage);
      }
    }
    if (validCalls.length > providerCalls.length) {
      repaired.push(new HumanMessage(
        `[runtime preserved one provider-safe tool result and elided ${validCalls.length - providerCalls.length} additional results from this model turn; durable action events remain recorded]`,
      ));
    }
    index = cursor - 1;
  }

  if (repairedCalls > 0) {
    // Keep this visible in the agent log without exposing tool arguments.
    console.warn("[YAAA] Repaired incomplete tool-call transcript before Gemini request", {
      droppedToolCalls: repairedCalls,
    });
  }
  if (collapsedBatches > 0) {
    console.warn("[YAAA] Collapsed multi-call tool turn for provider-safe replay", {
      elidedCalls: collapsedBatches,
    });
  }
  return repaired;
}

function getAutoCourseCorrection(messages: BaseMessage[]): string | null {
  // 1. Check for a real web-search loop. Three searches alone are normal for
  // research. Warn only when the latest three search results all show no
  // useful result, which is evidence of no progress rather than mere activity.
  const searchMessages = messages.filter(
    (m) => m.getType() === "tool" && (m as ToolMessage).name === "web_search"
  ) as ToolMessage[];
  const latestSearches = searchMessages.slice(-3);
  if (latestSearches.length === 3 && latestSearches.every((message) => isEmptySearchResult(message.content))) {
    const hasWarned = messages.some(
      (m) =>
        m.getType() === "human" &&
        m.content.toString().includes("System Notice: You have performed")
    );
    if (!hasWarned) {
      return `System Notice: The last ${latestSearches.length} web searches returned no useful results. Pause and change the query/tool or synthesize from the evidence already gathered. Do not repeat a no-progress search loop.`;
    }
  }

  // 2. Check for repeated tool failures or identical calls
  const toolMessages = messages.filter((m) => m.getType() === "tool") as ToolMessage[];
  if (toolMessages.length >= 3) {
    const lastThree = toolMessages.slice(-3);
    const first = lastThree[0];
    const allSameName = lastThree.every((tm) => tm.name === first.name);
    if (allSameName) {
      const allFailed = lastThree.every((tm) => isFailedToolResult(tm.content));
      if (allFailed) {
        const hasWarned = messages.some(
          (m) =>
            m.getType() === "human" &&
            m.content.toString().includes("System Notice: The tool has repeatedly failed")
        );
        if (!hasWarned) {
          return `System Notice: The tool "${first.name}" has repeatedly failed or returned empty/error results. Please pause, re-evaluate your inputs/parameters, and try a different tool or strategy instead of repeating this call.`;
        }
      }
    }
  }

  return null;
}

function isEmptySearchResult(content: unknown): boolean {
  const text = typeof content === "string" ? content.trim() : String(content ?? "").trim();
  if (!text) return true;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (Array.isArray(parsed)) return parsed.length === 0;
    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.results)) return parsed.results.length === 0;
      if (Array.isArray(parsed.items)) return parsed.items.length === 0;
      if (typeof parsed.error === "string" || parsed.error === true) return true;
    }
  } catch {
    // Plain text is useful unless it explicitly says there were no results.
  }
  return /^(?:no results?|0 results?|empty|not found)\.?$/i.test(text);
}

/**
 * Tool results are not failures merely because they are short. In particular,
 * files.writeFile returns void and is normalized by safeSerialize to
 * {"status":"ok"}. The old length heuristic misclassified that successful
 * result as an empty/error result and injected a false course correction after
 * three ordinary writes.
 */
function isFailedToolResult(content: unknown): boolean {
  const text = typeof content === "string" ? content.trim() : String(content ?? "").trim();
  if (!text) return true;

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      const status = typeof parsed.status === "string" ? parsed.status.toLowerCase() : "";
      if (["ok", "success", "completed", "done"].includes(status)) return false;
      if (["error", "failed", "failure"].includes(status)) return true;
      if (typeof parsed.error === "string" || parsed.error === true) return true;
      if (typeof parsed.message === "string" && /\b(?:error|failed|failure|permission denied)\b/i.test(parsed.message)) return true;
    }
  } catch {
    // Plain-text tool responses are handled by the conservative checks below.
  }

  return /\b(?:error|failed|failure|permission denied)\b/i.test(text);
}

/** Group failures caused by the same contract/provider defect even when the
 * model changes a command, path, or runtime language between attempts. */
function normalizeFailureClass(value: string): string {
  const text = value.toLowerCase();
  if (text.includes("unknown action in file_multi execution")) return "file_multi unsupported non-file action";
  if (text.includes("function response parts") && text.includes("function call parts")) return "provider function-call transcript mismatch";
  if (/\b(?:503|temporarily unavailable|provider request error|model provider)\b/.test(text)) return "model provider unavailable";
  return value.replace(/(?:command|path|url)\s*[:=]\s*[^,;]+/gi, "$1:<variable>");
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
  const salientKeys = ["query", "url", "command", "script", "path", "pattern", "selector", "source", "id"];
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
    if (typeof record.status === "string") {
      const detail = typeof record.message === "string" ? ` — ${record.message}` : "";
      return truncateForLog(`${record.status}${detail}`);
    }
    if (typeof record.title === "string" && record.title.trim()) return truncateForLog(record.title);
    if (typeof record.url === "string" && record.url.trim()) return truncateForLog(record.url);
    if (typeof record.text === "string" && record.text.trim()) return truncateForLog(record.text);
    if (record.timedOut === true) return `timed out after ${typeof record.durationMs === "number" ? `${record.durationMs}ms` : "the command deadline"}`;
    if (typeof record.exitCode === "number" && record.exitCode !== 0) return `exited with code ${record.exitCode}`;
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

function screenshotLogPath(workspaceRoot: string, agentId: string, requestedPath: string): { relative: string; absolute: string } {
  const requestedName = path.basename(requestedPath || "browser.png");
  const safeName = safePathSegment(requestedName) || "browser.png";
  const relative = `agent-workspaces/${safePathSegment(agentId)}/logs/${safeName}`;
  return { relative, absolute: path.resolve(workspaceRoot, relative) };
}

function buildToolMetadata(
  capability: string,
  method: string,
  args: unknown,
  output?: unknown,
): Record<string, unknown> {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const metadata: Record<string, unknown> = { capability, method };
  const queuedActions = record.actions;
  if (Array.isArray(queuedActions)) {
    metadata.actionQueue = {
      count: queuedActions.length,
      actions: queuedActions.slice(0, 16).map((item: any) => typeof item?.action === "string" ? item.action : "unknown"),
      truncated: queuedActions.length > 16,
    };
  }
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
  const script = previewText(record.script, 500);
  if (script) metadata.script = script;

  const screenshotPath =
    resultString(output, "screenshotPath") ??
    (Array.isArray(output) && typeof (output as any).screenshotPath === "string"
      ? (output as any).screenshotPath
      : undefined) ??
    (method === "screenshot" && typeof output === "string" ? output : undefined);
  if (screenshotPath) metadata.screenshotPath = screenshotPath;
  const screencastPath = resultString(output, "screencastPath") ?? resultString(output, "videoPath");
  if (screencastPath) metadata.screencastPath = screencastPath;
  const screenshotAbsolutePath = resultString(output, "screenshotAbsolutePath");
  const dataUrl = screenshotDataUrl(screenshotAbsolutePath ?? screenshotPath);
  if (dataUrl) metadata.screenshotDataUrl = dataUrl;

  if (output && typeof output === "object") {
    const stdout = previewText((output as Record<string, unknown>).stdout, 360);
    const stderr = previewText((output as Record<string, unknown>).stderr, 360);
    if (stdout) metadata.stdout = stdout;
    if (stderr) metadata.stderr = stderr;
    if (typeof (output as Record<string, unknown>).exitCode !== "undefined") {
      metadata.exitCode = (output as Record<string, unknown>).exitCode;
    }
    if (typeof (output as Record<string, unknown>).timedOut === "boolean") {
      metadata.timedOut = (output as Record<string, unknown>).timedOut;
    }
    if (typeof (output as Record<string, unknown>).durationMs === "number") {
      metadata.durationMs = (output as Record<string, unknown>).durationMs;
    }
    const title = previewText((output as Record<string, unknown>).title, 180);
    if (title) metadata.title = title;
  }
  if (Array.isArray(output) && output.length > 0) {
    metadata.results = output.slice(0, 3).map((item) => {
      if (!item || typeof item !== "object") return String(item);
      const result = item as Record<string, unknown>;
      const resultPath = result.path ?? result.relativePath ?? result.filePath ?? result.name;
      return {
        title: previewText(result.title ?? result.name ?? result.path ?? result.relativePath ?? result.filePath, 120),
        path: previewText(resultPath, 220),
        url: previewText(result.url, 160),
        description: previewText(result.description, 180),
      };
    });
  }
  return metadata;
}

function parseVerifierResult(text: string): { status: "passed" | "failed"; reason: string; findings: string[]; evidence: string[]; limitations: string[] } {
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const raw = JSON.parse(fenced?.[1] ?? text);
    if (raw?.status !== "passed" && raw?.status !== "failed") throw new Error("status must be passed or failed");
    if (!Array.isArray(raw.findings) || !Array.isArray(raw.evidence)) throw new Error("findings and evidence must be arrays");
    if (raw.status === "passed" && raw.evidence.length === 0) throw new Error("a passing result requires evidence");
    return { status: raw.status, reason: String(raw.summary ?? "No summary provided."), findings: raw.findings.map(String), evidence: raw.evidence.map(String), limitations: Array.isArray(raw.limitations) ? raw.limitations.map(String) : [] };
  } catch (error) {
    return { status: "failed", reason: `Verifier returned invalid structured output: ${error instanceof Error ? error.message : String(error)}`, findings: ["The verifier response could not be validated."], evidence: [], limitations: [] };
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
  private modelResolver?: ModelResolver;
  private durableQueue?: IEventQueue;
  private executionSessions?: ExecutionSessionManagerLike;

  constructor(scope: Container = container) {
    this.scope = scope;
    this.bus = scope.resolve<IBus>("IBus");
    this.permissions = scope.resolve<PermissionEngine>("PermissionEngine");
    this.modelFactory = scope.resolve<ChatModelFactory>("ChatModelFactory");
    this.maxTurns = resolveMaxTurns();
    try {
      this.modelResolver = scope.resolve<ModelResolver>("modelResolver");
    } catch {
      // Alternate/test runtimes may not expose Mesh model discovery.
    }
    try {
      this.durableQueue = scope.resolve<IEventQueue>("IEventQueue");
    } catch {
      // Lightweight unit-test scopes may intentionally omit durable queues.
    }
    try {
      this.executionSessions = scope.resolve<ExecutionSessionManagerLike>("ExecutionSessionManager");
    } catch {
      // Optional for lightweight unit-test scopes.
    }
  }

  async run(options: WorkerOptions): Promise<any> {
    const template = AGENT_REGISTRY[options.templateName];
    if (!template) {
      throw new Error(`Agent template ${options.templateName} not found in registry.`);
    }
    const roleNames = Array.from(new Set([options.templateName, ...(options.roleNames ?? [])]));
    const capabilities = Array.from(new Set([...template.capabilities, ...(options.capabilities ?? [])]));

    const { agentId, taskId, instruction, contextArtifacts = [] } = options;
    const contextSections = options.contextSections ?? {};
    const contextPolicy = options.executionContract?.contextPolicy;
    const contextKeepLeading = 2;
    const contextKeepRecent = Math.max(1, contextPolicy?.maxHistoryTurns ?? 4);
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
    // The workspace is always reachable; the configured roots (full disk by
    // default) are what let an agent act on the user's own files instead of
    // failing with a permission error the user cannot do anything about.
    const fileRoots = resolveFileRoots();
    this.permissions.grantScope(agentId, {
      capabilities,
      allowedPaths: [workspaceRoot, ...fileRoots],
      riskCeiling: template.riskCeiling,
      workspacePath: workspaceRoot,
    });
    // Start this agent with a clean control mailbox; supervisor/UI directives
    // (extend / redirect / stop) posted during the run are drained in preModelHook.
    agentControl.clear(agentId);
    logInner(agentId, "permission scope granted", {
      capabilities,
      riskCeiling: template.riskCeiling,
      fileRoots,
    });

    await this.bus.publish(`task.${taskId}.agent.${agentId}.started`, {
      kind: "status",
      from: agentId,
      taskId,
      state: "working",
      note: `Spawned ${options.templateName} to execute subtask.`,
    });

    const artifacts: ArtifactRef[] = [];
    const runStartedAtMs = Date.now();
    const toolObservations: ToolObservation[] = [];
    let sawToolProgress = false;
    let noProgressStopRequested = false;
    // Preserve permission/capability denials across model turns. A denied
    // operation is a blocked assignment, not a reason to spawn an identical
    // replacement agent.
    let permissionBlocked = false;
    const permissionBlockReasons: string[] = [];

    const currentSubSubtasks = options.subSubtasks && options.subSubtasks.length > 0
      ? options.subSubtasks
      : deriveSubSubtasksFromSubtask({ id: options.subtaskId || "subtask-1", title: options.instruction, capabilities });

    const completeSubSubtask = async (subSubtaskId: string, result?: string) => {
      const requestedId = subSubtaskId.trim();
      // Models often copy the visible `id: title` row instead of only the id.
      // Accept that harmless formatting error, but resolve against the exact
      // runtime id so the UI and checkpoint ledger remain canonical.
      const normalizedId = requestedId.split(/\s*:\s*/, 1)[0];
      const step = currentSubSubtasks.find((candidate) => candidate.id === normalizedId);
      if (!step) throw new Error(`Unknown sub-subtask: ${subSubtaskId}`);
      if (step.state === "completed") return { status: "already_completed", subSubtaskId };
      step.result = result?.trim() || step.result;
      await this.triggerSubSubtaskCheckpoint({
        taskId,
        agentId,
        subtaskId: options.subtaskId,
        templateName: options.templateName,
        agentWorkspace: `agent-workspaces/${safePathSegment(agentId)}`,
        subSubtask: step,
        allSubSubtasks: currentSubSubtasks,
      });
      return { status: "completed", subSubtaskId: step.id, title: step.title };
    };

    const addSubSubtask = async (title: string, result?: string) => {
      const parentId = options.subtaskId || "subtask-1";
      // Do not let an LLM-generated display label such as
      // `subtask-1.4: Verify index.html` become the stored title. The runtime
      // owns ids; the agent supplies only the actionable title.
      const cleanTitle = title.trim().replace(new RegExp(`^${parentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+\\s*:\\s*`, "i"), "").trim();
      if (!cleanTitle) throw new Error("A new sub-subtask needs a non-empty title.");
      let ordinal = currentSubSubtasks.length + 1;
      while (currentSubSubtasks.some((step) => step.id === `${parentId}.${ordinal}`)) ordinal += 1;
      const step: SubSubtask = {
        id: `${parentId}.${ordinal}`,
        title: cleanTitle,
        state: "pending",
        result: result?.trim() || undefined,
      };
      currentSubSubtasks.push(step);
      await this.triggerSubSubtaskAdded({
        taskId,
        agentId,
        subtaskId: options.subtaskId || "subtask-1",
        templateName: options.templateName,
        agentWorkspace: `agent-workspaces/${safePathSegment(agentId)}`,
        subSubtask: step,
        allSubSubtasks: currentSubSubtasks,
      });
      return { status: "added", subSubtaskId: step.id, title: step.title };
    };

    const tools = this.buildTools(capabilities, roleNames.join(" + "), agentId, taskId, artifacts, toolObservations, workspaceRoot, () => {
      sawToolProgress = true;
    }, currentSubSubtasks, completeSubSubtask, addSubSubtask, contextArtifacts, /code-generation-skill/i.test(instruction), () => {
      noProgressStopRequested = true;
    }, () => noProgressStopRequested, options.executionContract, options.skillIds, instruction, (reason) => {
      permissionBlocked = true;
      if (!permissionBlockReasons.includes(reason)) permissionBlockReasons.push(reason);
    });
    // Resolve against Mesh's catalog again at the final model-factory boundary,
    // so an agent reaching the inner loop by any path still runs on a model Mesh
    // offers. Resolution is idempotent and catalog-cached: a requested model
    // that is available resolves to itself, so this preserves the planner's
    // choice rather than overriding it.
    let resolvedModel: string | undefined;
    if (this.modelResolver) {
      try {
        resolvedModel = (await this.modelResolver(options.model)).model;
      } catch (error) {
        warnInner(agentId, "Mesh model lookup failed; preserving requested model", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!resolvedModel) {
        warnInner(agentId, "Mesh returned no eligible model; using configured fallback", {
          fallbackModel: options.model ?? template.modelRole,
        });
      }
    }
    let modelName = resolvedModel || options.model || template.modelRole;
    const rawModel = this.modelFactory(modelName);
    const toolSchemaChars = tools.reduce((total, candidate: any) => {
      let schemaChars = 0;
      try { schemaChars = JSON.stringify(candidate.schema ?? {}).length; } catch { /* best effort telemetry */ }
      return total + schemaChars + String(candidate.description ?? "").length;
    }, 0);
    // Reserve the planner's input budget for both the message packet and the
    // tool declarations. If declarations alone exceed the budget, the packet
    // still gets a small emergency floor and telemetry reports the violation;
    // the planner must then narrow the allowlist rather than the runtime
    // guessing which task-specific tools to remove.
    const providerContextChars = contextPolicy
      ? Math.max(1_200, contextPolicy.maxInputTokens * 4 - toolSchemaChars)
      : undefined;
    const enforceProviderSafeInvoke = (candidate: any): any => {
      if (!candidate || typeof candidate.invoke !== "function" || candidate.__yaaaSafeInvoke) return candidate;
      const originalInvoke = candidate.invoke.bind(candidate);
      candidate.invoke = ((input: unknown, config?: unknown) => {
        const providerInput = Array.isArray(input)
          ? compactToolResultMessages(repairToolCallTranscript(input as BaseMessage[]), contextKeepLeading, contextKeepRecent, providerContextChars)
          : input;
        return originalInvoke(providerInput as any, config as any);
      }) as typeof candidate.invoke;
      candidate.__yaaaSafeInvoke = true;
      return candidate;
    };
    if (typeof rawModel.bindTools === "function") {
      const originalBindTools = rawModel.bindTools.bind(rawModel);
      rawModel.bindTools = (tools: any[], kwargs?: any) => {
        return enforceProviderSafeInvoke(originalBindTools(tools, {
          ...kwargs,
          parallel_tool_calls: false,
        }));
      };
    }
    // `preModelHook` documents and compacts the state, but LangGraph versions
    // differ in whether they honor a custom `llmInputMessages` return value.
    // Enforce the same repair at the actual ChatModel boundary so no provider
    // can receive the raw multi-call transcript that caused Gemini's 400.
    const model = enforceProviderSafeInvoke(rawModel);
    const userParts = [instruction];
    if (contextArtifacts.length > 0) {
      userParts.push(`Context artifacts available:\n${contextArtifacts.join("\n")}`);
    }
    const instructionChars = userParts.join("\n\n").length;
    logInner(agentId, "model factory resolved", {
      modelName,
      templateRole: template.role,
      toolCount: tools.length,
      instructionChars,
      toolSchemaChars,
    });

    // Wall-clock granted mid-run by supervisor `extend` directives. Read live by
    // the timeout watchdog so a still-working agent gets more time rather than
    // being aborted at the original deadline.
    let grantedExtensionMs = 0;
    let llmTurn = 0;
    const consumeLiveControl = () => {
      const control = agentControl.takeLive(agentId);
      if (control.additionalMs > 0) {
        grantedExtensionMs += control.additionalMs;
        void this.bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
          kind: "thought",
          from: agentId,
          taskId,
          content: `⏱️ YAAA granted +${Math.round(control.additionalMs / 1000)}s more time while the agent was running.`,
        });
      }
      return { additionalMs: 0, stopReason: control.stopReason };
    };

    const agent = createReactAgent({
      llm: model,
      tools,
      prompt: `${template.systemPrompt}

Assignment interpretation contract: the first HumanMessage contains a complete assignment summary with the mission, deliverable, acceptance criteria, and current micro-step. Read that summary before responding. If a micro-step is terse or procedural, use the mission and acceptance criteria to resolve its meaning; do not answer that you lack context when those fields are present.

Sub-subtask contract: sub-subtasks represent real micro-steps, not model turns. Keep the current step running while you work, and call complete_sub_subtask only after that step is genuinely complete with evidence. Never mark steps complete merely because you produced a response or made a tool call.

Provider-safe tool contract: issue at most one tool call in each assistant response. Wait for its result before requesting another tool. Do not batch independent calls in one response; YAAA serializes and records each action individually so provider function-call and function-response parts stay aligned.

Progress and observation contract: before every tool call, include a concise "progress" argument (maximum 240 characters) explaining what you are doing and what this step will determine. This is shown directly to the user while the tool runs. If the next tool may take time, make the progress message specific enough to explain the wait; do not use generic text such as "working" or "processing". Also provide expectedDurationMs when you can estimate it. For long-running shell or browser sessions, provide observationPlan with waitForMs, capture (for example stdout, stderr, browser-state, screenshot, or network), and detachWhen. These are user-facing execution estimates and evidence instructions; the runtime's deterministic deadline and cleanup rules always take precedence.`,
      // Honour a user-issued pause between model turns without polling, drain any
      // supervisor control directives (extend / redirect / stop / switch_model), and sanitise
      // the model input so no empty text content block reaches a Bedrock-backed
      // model. `llmInputMessages` overrides only what is sent to the LLM this
      // turn — the persisted transcript in `messages` is untouched.
      preModelHook: async (state: { messages: BaseMessage[] }) => {
        await pauseController.waitIfPaused(taskId);
        await pauseController.waitIfPaused(agentId);
        if (agentControl.isStopped(agentId) || agentControl.isStopped(taskId)) {
          throw new AgentStopRequestedError(`Agent ${agentId} stopped on user/supervisor directive.`);
        }
        if (noProgressStopRequested) {
          throw new AgentStopRequestedError("No progress budget exhausted for this assignment.");
        }
        const base = repairToolCallTranscript(state.messages.map(withNonEmptyContent));
        const injected: BaseMessage[] = [];

      // LangGraph invokes this hook once per model turn. Persist the exact
        // sanitized context sent to the model for replay and auditability.
        llmTurn += 1;
        // The event stream is also consumed by the main UI. Publish the same
        // bounded context that is sent to the model, never the raw transcript;
        // otherwise every tool result is duplicated in the orchestrator/UI
        // history even after runtime compaction.
        const contextForModel = compactToolResultMessages(base, contextKeepLeading, contextKeepRecent, providerContextChars);
        const contextChars = contextForModel.reduce((total, message) => {
          const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
          return total + content.length;
        }, 0);
        const estimatedInputTokens = Math.ceil((contextChars + toolSchemaChars) / 4);
        const historyChars = Math.max(0, contextChars - instructionChars);
        const contextBudgetExceeded = contextPolicy
          ? estimatedInputTokens > contextPolicy.maxInputTokens
          : false;
        const activeStep = currentSubSubtasks.find((step) => step.state === "running");
        const latestEvidence = toolObservations[toolObservations.length - 1];
        const displaySummary = [
          `Context: ${contextForModel.length} messages / ${contextChars.toLocaleString()} chars (~${estimatedInputTokens.toLocaleString()} input tokens)${contextForModel.some((message) => String(message.content).startsWith("[earlier tool result elided")) ? " (compacted)" : ""}`,
          `Active step: ${activeStep ? `${activeStep.id} — ${activeStep.title}` : "not assigned"}`,
          latestEvidence ? `Latest evidence: ${latestEvidence.ok ? "✓" : "✗"} ${latestEvidence.capability}.${latestEvidence.method} — ${latestEvidence.result}` : "Latest evidence: none yet",
          "Next decision: continue the active step, complete it with evidence, or add a newly discovered sub-step.",
        ].join("\n");
        const llmContext = {
          kind: "llm_context",
          from: agentId,
          taskId,
          turn: llmTurn,
          model: modelName,
          templateName: options.templateName,
          messageCount: contextForModel.length,
          contextChars,
          estimatedInputTokens,
          instructionChars,
          skillChars: contextSections.skillChars ?? 0,
          dependencyChars: contextSections.dependencyChars ?? 0,
          fileExcerptChars: contextSections.fileExcerptChars ?? 0,
          historyChars,
          toolSchemaChars,
          contextBudgetExceeded,
          contextPolicy: contextPolicy ?? null,
          includedSections: contextSections.included ?? ["assignment", "active-step", "recent-evidence", "tool-schemas"],
          omittedSections: contextSections.omitted ?? ["older-tool-history", "unselected-skills", "unrelated-dependencies"],
          messageTypes: contextForModel.map((message) => message.constructor.name),
          displaySummary,
        };
        console.log(`[YAAA:LLM:${agentId}] request turn ${llmTurn} (${modelName})\n${displaySummary}`);
        await this.bus.publish(`task.${taskId}.agent.${agentId}.llm_context`, llmContext);

        // Automated Loop and Tool Failure Course Correction
        const autoCorrection = getAutoCourseCorrection(base);
        if (autoCorrection) {
          injected.push(new HumanMessage(autoCorrection));
          await this.bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
            kind: "thought",
            from: agentId,
            content: `🛡️ Course correction injected by YAAA:\n\n${autoCorrection}`,
          });
          warnInner(agentId, "injected loop guard warning", { autoCorrection });
        }

        // Periodic Turn Checkpointing (every 5 turns)
        if (llmTurn > 1 && llmTurn % 5 === 0) {
          const checkpointDocPath = `agent-workspaces/${agentId}/checkpoint.md`;
          const completedSteps = currentSubSubtasks.filter((step) => step.state === "completed");
          const activeSteps = currentSubSubtasks.filter((step) => step.state === "running");
          const pendingSteps = currentSubSubtasks.filter((step) => step.state === "pending");
          const recentTools = toolObservations.slice(-4).map((observation) =>
            `- ${observation.ok ? "✓" : "✗"} ${observation.capability}.${observation.method}${observation.path ? ` (${observation.path})` : ""}: ${observation.result}`,
          );
          const progressSummary = [
            `Status: IN PROGRESS`,
            `Turn: ${llmTurn} / ${this.maxTurns}`,
            `Active step: ${activeSteps.map((step) => `${step.id} — ${step.title}`).join("; ") || "No step marked running"}`,
            `Completed: ${completedSteps.length}/${currentSubSubtasks.length}`,
            `Next pending: ${pendingSteps[0] ? `${pendingSteps[0].id} — ${pendingSteps[0].title}` : "None"}`,
            `Recent tool evidence:\n${recentTools.join("\n") || "- No tool evidence recorded yet"}`,
            `Artifacts observed: ${artifacts.map((artifact) => artifact.path).slice(-8).join(", ") || "none"}`,
            `Next action: Continue the active step, then call complete_sub_subtask with evidence; add a new sub-subtask if new required work is discovered.`,
          ].join("\n");
          try {
            const filesProvider = this.scope.resolve<any>("capability:files");
            if (filesProvider) {
              const checkpointContent = `# Sub-Agent Periodic Checkpoint\n\n- **Agent**: ${agentId} (${options.templateName})\n- **Timestamp**: ${new Date().toISOString()}\n\n## Structured Progress\n\n${progressSummary}\n`;
              await filesProvider.writeFile(checkpointDocPath, checkpointContent);
            }
          } catch {
            // DI capability not available in bare test scope
          }

          const summary = `Periodic checkpoint turn ${llmTurn}: ${activeSteps[0] ? `working on ${activeSteps[0].id} — ${activeSteps[0].title}` : "no active step recorded"}; ${completedSteps.length}/${currentSubSubtasks.length} sub-subtasks completed. Recent evidence: ${toolObservations.slice(-2).map((item) => `${item.method}=${item.result}`).join("; ") || "none"}`;
          await this.bus.publish(`task.${taskId}.agent.${agentId}.checkpoint`, {
            kind: "checkpoint",
            taskId,
            agentId,
            turn: llmTurn,
            checkpointPath: checkpointDocPath,
            summary,
          });
          // The agent-scoped event drives the activity feed; this mission-level
          // event is the durable bridge consumed by OuterLoop's supervisor.
          await this.bus.publish(`task.${taskId}.agent_checkpoint`, {
            kind: "checkpoint",
            taskId,
            agentId,
            turn: llmTurn,
            checkpointPath: checkpointDocPath,
            summary,
          });
        }

        for (const directive of agentControl.drain(agentId)) {
          if (directive.type === "extend") {
            grantedExtensionMs += Math.max(0, directive.additionalMs);
            await this.bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
              kind: "thought",
              from: agentId,
              content: `⏱️ Supervisor granted +${Math.round(directive.additionalMs / 1000)}s more time.${directive.reason ? ` ${directive.reason}` : ""}`,
            });
          } else if (directive.type === "switch_model") {
            modelName = directive.newModel;
            await this.bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
              kind: "thought",
              from: agentId,
              content: `⚡ Dynamically upgraded model to '${directive.newModel}' on the fly.${directive.reason ? ` Rationale: ${directive.reason}` : ""}`,
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
              content: `🧭 Supervisor course correction injected${directive.reason ? `: ${directive.reason}` : "."}\n\nCorrection:\n${directive.handsOn}`,
            });
          } else if (directive.type === "stop") {
            throw new AgentStopRequestedError(directive.reason);
          }
        }
        if (this.durableQueue) {
          await this.durableQueue.recoverExpired("agent");
          const claims = await this.durableQueue.claim("agent", taskId, agentId, 20, 10 * 60_000);
          for (const claim of claims) {
            const directive = claim.item.payload as { type?: string; handsOn?: string; newModel?: string; reason?: string };
            if (directive?.type === "switch_model" && directive.newModel) {
              modelName = directive.newModel;
              await this.bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
                kind: "thought",
                from: agentId,
                content: `⚡ Dynamically upgraded model to '${directive.newModel}' on the fly via durable queue.`,
              });
            }
            if (directive?.type === "redirect" && directive.handsOn) {
              await this.bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
                kind: "thought",
                from: agentId,
                content: `📥 ${agentId} pulled a message from its queue: ${directive.handsOn}`,
              });
              injected.push(new HumanMessage(
                `Worker queue message from YAAA — follow this updated assignment now:\n\n${directive.handsOn}`,
              ));
            }
            await this.durableQueue.acknowledge(claim);
          }
        }
        const totalBaseChars = base.reduce((acc, msg) => acc + (typeof msg.content === "string" ? msg.content.length : JSON.stringify(msg.content).length), 0);
        if (totalBaseChars > 20_000) {
          const compactedBase = compactToolResultMessages(base, contextKeepLeading, contextKeepRecent, providerContextChars);
          logInner(agentId, "compacted sub-agent message history past 20k threshold", {
            beforeChars: totalBaseChars,
            afterChars: compactedBase.reduce((acc, msg) => acc + (typeof msg.content === "string" ? msg.content.length : JSON.stringify(msg.content).length), 0),
          });
          state.messages.length = 0;
          state.messages.push(...compactedBase);

          try {
            const dbEngineProvider = (this.scope as any).resolve ? (this.scope as any).resolve("DBEngine") : undefined;
            if (dbEngineProvider) {
              const agentDb = dbEngineProvider.getAgentDb(taskId, agentId);
              const seq = dbEngineProvider.getLastWALSequence(agentDb, agentId);
              const checkpoint = {
                id: `compaction-${agentId}-${llmTurn}-${Date.now()}`,
                agentId,
                taskId,
                sequence: seq,
                summary: `Turn ${llmTurn} compaction checkpoint: message history compacted past 20k token ceiling.`,
                factsExtracted: [`Compacted ${base.length} messages down to ${compactedBase.length} active messages.`],
                filesTouched: artifacts.map((a) => a.path),
                timestamp: new Date().toISOString(),
              };
              dbEngineProvider.saveCompactionCheckpoint(agentDb, checkpoint);
            }
          } catch {
            // Optional in bare unit test scopes
          }
        }

        const workingBase = state.messages.map(withNonEmptyContent);
          return { llmInputMessages: compactToolResultMessages([...workingBase, ...injected], contextKeepLeading, contextKeepRecent, providerContextChars) };
      },
    });

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
          consumeLiveControl,
        },
      )) as { messages: BaseMessage[] };
      const llmResponse = {
        kind: "llm_response",
        from: agentId,
        taskId,
        turn: llmTurn,
        model: modelName,
        content: finalTextOf(finalState.messages),
      };
      console.log(`[YAAA:LLM:${agentId}] response turn ${llmTurn} (${modelName}) ${truncateLlmConsole(llmResponse.content)}`);
      await this.bus.publish(`task.${taskId}.agent.${agentId}.llm_response`, llmResponse);
      logInner(agentId, "model invocation completed", {
        messageCount: finalState.messages.length,
        sawToolProgress,
      });
    } catch (err) {
      const llmErrorResponse = {
        kind: "llm_response",
        from: agentId,
        taskId,
        turn: llmTurn,
        model: modelName,
        content: `[request failed] ${err instanceof Error ? err.message : String(err)}`,
      };
      console.log(`[YAAA:LLM:${agentId}] response turn ${llmTurn} (${modelName}) ${truncateLlmConsole(llmErrorResponse.content)}`);
      await this.bus.publish(`task.${taskId}.agent.${agentId}.llm_response`, llmErrorResponse);
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
        await this.publishResult(taskId, agentId, handoffArtifacts, summary, true);
        logInner(agentId, "stopped by supervisor with checkpoint handoff", {
          artifactCount: handoffArtifacts.length,
          toolObservationCount: toolObservations.length,
        });
        return {
          artifacts: handoffArtifacts,
          summary,
          incomplete: true,
          stopReason: noProgressStopRequested ? "no-progress" : "supervisor",
          ...(permissionBlocked ? { permissionBlocked: true, permissionBlockReasons } : {}),
          runtimeEvidence: formatToolObservations(toolObservations),
        };
      }
      if (!isAgentInvocationTimeoutError(err) && !isUnavailableModelError(err)) {
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
              consumeLiveControl,
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
        await this.publishResult(taskId, agentId, handoffArtifacts, summary, true);
        logInner(agentId, "timeout after progress completed with incomplete work artifact", {
          artifactCount: handoffArtifacts.length,
          toolObservationCount: toolObservations.length,
        });
        return {
          artifacts: handoffArtifacts,
          summary,
          incomplete: true,
          ...(permissionBlocked ? { permissionBlocked: true, permissionBlockReasons } : {}),
          runtimeEvidence: formatToolObservations(toolObservations),
        };
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
              consumeLiveControl,
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

    // Reconcile shell-created files before the verifier or orchestrator sees
    // the result. This is what makes a generated PPTX count even when it was
    // produced by `node create_presentation.js` rather than write_file.
    collectWorkspaceArtifacts(workspaceRoot, artifacts, template.role, agentWorkspace, runStartedAtMs);
    const emptyRequiredArtifact = findEmptyRequiredArtifact(
      workspaceRoot,
      options.executionContract?.requiredArtifacts ?? [],
    );
    if (emptyRequiredArtifact) {
      throw new Error(`EMPTY_ARTIFACT: Required deliverable ${emptyRequiredArtifact} exists but is zero bytes. Stop and report the producer failure; do not continue looping or regenerate it without a corrected approach.`);
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
      return {
        ...verdict,
        artifacts: handoffArtifacts,
        summary: verdict.reason,
        ...(permissionBlocked ? { permissionBlocked: true, permissionBlockReasons } : {}),
        runtimeEvidence: formatToolObservations(toolObservations),
      };
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
    return {
      artifacts: finalArtifacts,
      summary,
      ...(permissionBlocked ? { permissionBlocked: true, permissionBlockReasons } : {}),
      runtimeEvidence: formatToolObservations(toolObservations),
    };
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
    const artifacts = input.artifacts.filter((artifact, index, all) =>
      all.findIndex((candidate) => candidate.path === artifact.path) === index,
    );
    const now = new Date().toISOString();
    const handOffPath = `${input.agentWorkspace}/handOff.md`;
    const checkpointPath = `${input.agentWorkspace}/checkpoint.md`;
    const alreadyProduced = new Set(artifacts.map((artifact) => artifact.path));
    const status = input.failure ? "FAILED" : input.status ?? "COMPLETED";

    // Delete transient checkpoint.md upon work completion
    try {
      let workingDir = ".";
      try {
        workingDir = this.scope.resolve<string>("workingDir");
      } catch {
        // fallback
      }
      const absCheckpoint = path.resolve(workingDir, checkpointPath);
      if (fs.existsSync(absCheckpoint)) {
        fs.unlinkSync(absCheckpoint);
      }
    } catch {
      // Ignore cleanup error in bare unit test scopes
    }

    if (!alreadyProduced.has(handOffPath)) {
      const failureSection = input.failure
        ? `\n## Failure Details\n\n- Error: ${input.failure.message}\n- Timed out: ${input.failure.timedOut ? "Yes" : "No"}\n- Tool progress observed before failure: ${input.failure.sawToolProgress ? "Yes" : "No"}\n\n`
        : "";
      const verifierBlock = input.verifier
        ? `\n## Verification Findings\n\n- Status: ${input.verifier.status}\n- Findings:\n${input.verifier.findings.map((item) => `  - ${item}`).join("\n") || "  - None recorded."}\n- Evidence:\n${input.verifier.evidence.map((item) => `  - ${item}`).join("\n") || "  - None recorded."}\n`
        : "";
      const residualRisks = input.failure
        ? `- The assigned work was not completed by this agent.\n- The next agent should retry with a different model, narrower scope, or smaller first step.`
        : status === "INCOMPLETE"
          ? "- The assigned work reached a timebox before final completion.\n- The next agent should continue from the listed artifacts."
          : "- None identified by the runtime.";
      const blockerSection = input.failure
        ? `\n## Why This Could Not Be Completed\n\n- Blocker: ${input.failure.message}\n- Timeout before first progress: ${input.failure.timedOut ? "Yes" : "No"}\n- Tool progress observed: ${input.failure.sawToolProgress ? "Yes" : "No"}\n\n## Do Not Repeat\n\n- Do not repeat the same approach without addressing the blocker above.\n`
        : status === "INCOMPLETE"
          ? `\n## Why This Was Not Completed\n\n- The agent reached its timebox before producing a final deliverable.\n- The exact remaining work and blocker evidence are recorded in the summary and tool evidence below.\n\n## Do Not Repeat\n\n- Do not restart from a blank slate without addressing the recorded blocker.\n`
          : "";

      const handOffContent = `# Agent Handoff & Proof of Work

- **Task**: ${input.taskId}
- **Agent**: ${input.agentId}
- **Role**: ${input.templateName}
- **Created**: ${now}
- **Status**: ${status}
- Status: ${status}

## Work Done & Result Summary

${input.summary.trim() || "No summary was provided."}
${failureSection}${blockerSection}${verifierBlock}
## Proof of Work & Tool Evidence

${formatToolObservations(input.toolObservations)}

## Asset Metadata & Artifact List

${formatArtifactList(artifacts)}

## Residual Risks & Continuation Instructions

- **Residual Risks**: ${residualRisks}
- **Continuation Instructions**: Start by reading this consolidated \`handOff.md\`. Inspect any listed artifacts before modifying them. Preserve useful outputs and only redo work when evidence shows a gap.
`;

      await filesProvider.writeFile(handOffPath, handOffContent);
      logInner(input.agentId, "wrote consolidated handOff.md", {
        path: handOffPath,
        failed: Boolean(input.failure),
      });
      artifacts.push({
        path: handOffPath,
        mimeType: "text/markdown",
        description: `Consolidated handoff and proof of work produced by ${input.templateName}.`,
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

  /**
   * Records an explicit sub-subtask completion across handsOn.md and
   * checkpoint.md. The final durable evidence remains consolidated in handOff.md.
   * called by the completion tool (or a trusted test/integration), never by
   * model-turn counting.
   */
  public async triggerSubSubtaskCheckpoint(input: {
    taskId: string;
    agentId: string;
    subtaskId?: string;
    templateName: string;
    agentWorkspace: string;
    subSubtask: SubSubtask;
    allSubSubtasks: SubSubtask[];
  }): Promise<void> {
    input.subSubtask.state = "completed";
    input.subSubtask.completedAt = new Date().toISOString();
    const completedIndex = input.allSubSubtasks.findIndex((step) => step.id === input.subSubtask.id);
    // Completion is evidence-based, not turn-order-based: a worker may finish
    // a later checklist item early. Only advance the active lane when the
    // currently running item itself was completed; otherwise leave it running
    // and preserve the out-of-order completion.
    const runningIndex = input.allSubSubtasks.findIndex((step) => step.state === "running");
    const canAdvance = runningIndex < 0 || runningIndex === completedIndex;
    const nextStep = canAdvance
      ? input.allSubSubtasks.slice(Math.max(runningIndex, completedIndex) + 1).find((step) => step.state === "pending")
      : undefined;
    if (nextStep) nextStep.state = "running";

    const subSubtaskLines = input.allSubSubtasks.map(
      (st) => `- [${st.state === "completed" ? "x" : " "}] **${st.id}**: ${st.title}${st.result ? ` — *${st.result}*` : ""}`
    ).join("\n");

    const handsOnPath = `${input.agentWorkspace}/handsOn.md`;
    const checkpointPath = `${input.agentWorkspace}/checkpoint.md`;

    try {
      const filesProvider = this.scope.resolve<any>("capability:files");
      if (filesProvider) {
        const handsOnContent = `# Hands-On Assignment\n\n- **Agent**: ${input.agentId} (${input.templateName})\n- **Updated**: ${new Date().toISOString()}\n\n## Sub-subtasks Breakdown\n${subSubtaskLines}\n`;
        await filesProvider.writeFile(handsOnPath, handsOnContent);

        const progress = `## Sub-subtasks Breakdown\n${subSubtaskLines}\n\n## Latest Evidence\n${input.subSubtask.result || "The step was explicitly completed by the agent after verification."}\n`;
        const checkpointContent = `# Active Sub-Agent Checkpoint\n\n- **Completed Sub-subtask**: ${input.subSubtask.id} (${input.subSubtask.title})\n- **Timestamp**: ${new Date().toISOString()}\n\n${progress}`;
        await filesProvider.writeFile(checkpointPath, checkpointContent);
      }
    } catch {
      // DI capability not available in bare test scope
    }

    const note = `✅ Sub-agent @${input.agentId} completed sub-subtask ${input.subSubtask.id}: ${input.subSubtask.title}`;
    logInner(input.agentId, "sub-subtask completed", { subSubtaskId: input.subSubtask.id });

    await this.bus.publish(`task.${input.taskId}.sub_subtask_completed`, {
      kind: "sub_subtask_completed",
      taskId: input.taskId,
      agentId: input.agentId,
      subtaskId: input.subtaskId,
      subSubtask: input.subSubtask,
      allSubSubtasks: input.allSubSubtasks,
      checkpointPath,
      note,
    });

    await this.bus.publish(`task.${input.taskId}.agent.${input.agentId}.sub_subtask_completed`, {
      kind: "sub_subtask_completed",
      taskId: input.taskId,
      agentId: input.agentId,
      subtaskId: input.subtaskId,
      subSubtask: input.subSubtask,
      allSubSubtasks: input.allSubSubtasks,
      checkpointPath,
      note,
    });

    await this.bus.publish(`task.${input.taskId}.agent_checkpoint`, {
      kind: "checkpoint",
      taskId: input.taskId,
      agentId: input.agentId,
      turn: 1,
      checkpointPath,
      summary: note,
    });
  }

  /** Persist and announce a micro-step discovered by the worker at runtime. */
  public async triggerSubSubtaskAdded(input: {
    taskId: string;
    agentId: string;
    subtaskId: string;
    templateName: string;
    agentWorkspace: string;
    subSubtask: SubSubtask;
    allSubSubtasks: SubSubtask[];
  }): Promise<void> {
    const lines = input.allSubSubtasks.map((step) =>
      `- [${step.state === "completed" ? "x" : step.state === "running" ? ">" : " "}] **${step.id}**: ${step.title}${step.result ? ` — *${step.result}*` : ""}`,
    ).join("\n");
    const progress = `# Runtime Sub-Subtask Update\n\n- **Added**: ${input.subSubtask.id} — ${input.subSubtask.title}\n- **Agent**: ${input.agentId} (${input.templateName})\n- **Timestamp**: ${new Date().toISOString()}\n\n## Current Breakdown\n${lines}\n`;
    const checkpointPath = `${input.agentWorkspace}/checkpoint.md`;
    try {
      const filesProvider = this.scope.resolve<any>("capability:files");
      await filesProvider.writeFile(`${input.agentWorkspace}/handsOn.md`, progress);
      await filesProvider.writeFile(checkpointPath, progress);
    } catch {
      // Bare test scopes may not register the files capability.
    }
    const note = `➕ Sub-agent @${input.agentId} added sub-subtask ${input.subSubtask.id}: ${input.subSubtask.title}`;
    await this.bus.publish(`task.${input.taskId}.sub_subtask_added`, {
      kind: "sub_subtask_added",
      taskId: input.taskId,
      agentId: input.agentId,
      subtaskId: input.subtaskId,
      subSubtask: input.subSubtask,
      allSubSubtasks: input.allSubSubtasks,
      checkpointPath,
      note,
    });
    await this.bus.publish(`task.${input.taskId}.agent_checkpoint`, {
      kind: "checkpoint",
      taskId: input.taskId,
      agentId: input.agentId,
      turn: 0,
      checkpointPath,
      summary: note,
    });
  }

  private async publishResult(
    taskId: string,
    agentId: string,
    artifacts: ArtifactRef[],
    summary: string,
    incomplete = false,
  ): Promise<void> {
    await this.bus.publish(`task.${taskId}.agent_message`, {
      kind: "result",
      from: agentId,
      taskId,
      artifacts,
      summary,
      ...(incomplete ? { incomplete: true } : {}),
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
    subSubtasks: SubSubtask[],
    completeSubSubtask: (subSubtaskId: string, result?: string) => Promise<unknown>,
    addSubSubtask: (title: string, result?: string) => Promise<unknown>,
    protectedExistingPaths: string[] = [],
    requireGraphPreflight = false,
    requestNoProgressStop?: () => void,
    isNoProgressStopRequested?: () => boolean,
    executionContract?: ExecutionContract,
    selectedSkillIds: string[] = [],
    assignmentInstruction = "",
    onPermissionDenied?: (reason: string) => void,
  ): StructuredToolInterface[] {
    const filesProvider = capabilities.includes("files") ? this.scope.resolve<any>("capability:files") : undefined;
    const graphPreflight = new CodeReviewPreflightTool();
    const agentWorkspace = `agent-workspaces/${safePathSegment(agentId)}`;
    const verifierFileReadOnly = ["VerifierAgent", "QaTesterAgent", "CvTesterAgent"].includes(role);
    const bus = this.bus;
    const permissions = this.permissions;
    const optionalProvider = (token: string) => { try { return this.scope.resolve<any>(token); } catch { return undefined; } };

    // Per-run guardrails. `callCounts` is scoped to this buildTools call (one
    // agent run), so counts never leak across agents. `maxToolOutput` caps how
    // much of any single observation reaches the model.
    const callCounts = new Map<string, number>();
    const failureCounts = new Map<string, number>();
    const noProgressThreshold = Math.max(1, executionContract?.noProgress.stopAfter ?? MAX_IDENTICAL_PROGRESS);
    const maxActionQueueDepth = Math.max(1, executionContract?.actionQueue.maxDepth ?? 8);
    const maxActionQueueActions = Math.max(1, executionContract?.actionQueue.maxActions ?? 64);
    const validateActionQueue = (actions: unknown[], depth = 0): void => {
      if (depth > maxActionQueueDepth) {
        throw new Error(`Action queue nesting exceeds the execution contract depth of ${maxActionQueueDepth}.`);
      }
      if (actions.length > maxActionQueueActions) {
        throw new Error(`Action queue contains ${actions.length} actions; the execution contract allows ${maxActionQueueActions}.`);
      }
      for (const action of actions) {
        if (action && typeof action === "object" && Array.isArray((action as any).actions)) {
          validateActionQueue((action as any).actions, depth + 1);
        }
      }
    };
    // Count normalized argument+result signatures as well as exact call
    // signatures. This catches repeated successful work without incorrectly
    // treating two legitimate reads with different paths or ranges as the
    // same progress.
    const progressCounts = new Map<string, number>();
    const protectedPaths = new Set(protectedExistingPaths.map((value) => path.normalize(value)));
    const recentlyReadPaths = new Set<string>();
    const recentlyWrittenPaths = new Set<string>();
    let graphPreflightCompleted = !requireGraphPreflight;
    const normalizeWorkspacePath = (value: string): string => path.normalize(value);
    const normalizeProgressArgs = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(normalizeProgressArgs);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalizeProgressArgs(item)]));
      }
      return value;
    };
    const markRead = (value: string): void => {
      recentlyReadPaths.add(normalizeWorkspacePath(value));
    };
    const assertWritablePath = async (value: string, targetedEdit = false): Promise<void> => {
      if (!graphPreflightCompleted) {
        throw new Error("Run code_review_graph_preflight before writing code. Use its result to establish the affected files and dependency scope first.");
      }
      const normalized = normalizeWorkspacePath(value);
      if (recentlyWrittenPaths.has(normalized) && !targetedEdit) {
        throw new Error(`Refusing to rewrite ${value} in full after it was already written by this agent. Use read_file_lines followed by write_file_lines for a targeted edit.`);
      }
      if (recentlyWrittenPaths.has(normalized) && !recentlyReadPaths.has(normalized)) {
        throw new Error(`Refusing to edit ${value} without reading it first. Inspect the current file, then make a targeted edit.`);
      }
      if (!protectedPaths.has(normalized) || recentlyReadPaths.has(normalized)) return;
      try {
        const existing = await filesProvider?.stat(value);
        if (existing?.isFile && existing.size > 0) {
          throw new Error(`Refusing to overwrite existing artifact ${value} before reading it. Read the file first and preserve valid content.`);
        }
      } catch (error) {
        if (error instanceof Error && /Refusing to/.test(error.message)) throw error;
        // A missing path is a valid first-write case.
      }
    };
    const markWritten = (value: string): void => {
      const normalized = normalizeWorkspacePath(value);
      recentlyWrittenPaths.add(normalized);
      recentlyReadPaths.delete(normalized);
    };
    const completeImplementationStepsFor = async (value: string, evidence: string): Promise<void> => {
      for (const step of subSubtasks) {
        const isVerificationStep = /\b(?:verify|validate|test|confirm|render|inspect)\b/i.test(step.title);
        const namesThisFile = step.title.toLowerCase().includes(value.toLowerCase())
          || step.title.toLowerCase().includes(path.basename(value).toLowerCase());
        if (!isVerificationStep && namesThisFile && step.state !== "completed") {
          await completeSubSubtask(step.id, evidence);
        }
      }
    };
    const writeFullFile = async (value: string, content: string): Promise<Record<string, string>> => {
      const normalized = normalizeWorkspacePath(value);
      if (recentlyWrittenPaths.has(normalized)) {
        await completeImplementationStepsFor(
          value,
          `Confirmed ${value}; the implementation artifact was already created earlier in this run and is ready for verification.`,
        );
        return {
          status: "unchanged",
          path: value,
          message: `No write was needed: ${value} was already created successfully in this run. Treat this as successful evidence, do not call write_file again for this path, and continue with the next scoped file or verification.`,
        };
      }
      await assertWritablePath(value);
      await filesProvider.writeFile(value, content);
      markWritten(value);
      await completeImplementationStepsFor(value, `Created ${value}; the implementation artifact is now present for verification.`);
      const reference = fileEvidence(value, content);
      return {
        status: "created",
        path: value,
        startLine: reference.startLine,
        endLine: reference.endLine,
        totalLines: reference.totalLines,
        sha256: reference.sha256,
        message: `Full write completed for ${value}. Continue with the next scoped file; do not regenerate this file.`,
      };
    };
    const maxToolOutput = resolveMaxToolOutput();
    const capOutput = (serialized: string): string =>
      serialized.length > maxToolOutput
        ? `${serialized.slice(0, maxToolOutput)}\n\n[output truncated: ${serialized.length} chars total, showing first ${maxToolOutput}]`
        : serialized;

    // LangGraph can execute multiple tool calls from one model turn
    // concurrently even when the provider-side `parallel_tool_calls: false`
    // hint is ignored. Serialize the complete permission/tool lifecycle per
    // agent so subprocesses, browser sessions, approvals, and event ordering
    // cannot race each other or leave one call permanently unresolved.
    let toolQueue: Promise<void> = Promise.resolve();
    const serializeToolCall = <T>(operation: () => Promise<T>): Promise<T> => {
      const queued = toolQueue.then(operation, operation);
      toolQueue = queued.then(() => undefined, () => undefined);
      return queued;
    };

    const gated = (
      name: string,
      method: string,
      description: string,
      schema: z.ZodTypeAny,
      invoke: (args: any) => Promise<unknown>,
      onSuccess?: (args: any) => void,
      capability = "files",
    ) => {
      // Bedrock Converse requires every tool input schema to have a root
      // `type: "object"`. Zod intersections serialize as `allOf` and Mesh's
      // Converse route rejects that shape, even when both sides are objects.
      // All built-in gated tools use object schemas, so merge the metadata
      // fields into the object shape instead of creating an intersection.
      const progressSchema = z.object({
        progress: z.string().max(240).optional().describe("A concise user-facing message explaining what this tool call is doing."),
        expectedDurationMs: z.number().int().positive().max(600_000).optional().describe("LLM estimate for this tool call in milliseconds."),
        observationPlan: z.object({
          waitForMs: z.number().int().positive().max(600_000).optional(),
          capture: z.array(z.string()).max(8).optional().describe("Evidence to capture before detaching, such as stdout, stderr, browser-state, screenshot, or network."),
          detachWhen: z.string().max(240).optional().describe("Condition that makes it safe to stop observing."),
        }).optional().describe("Evidence and detach instructions for a long-running execution."),
      });
      const toolSchema = schema instanceof z.ZodObject
        ? schema.extend(progressSchema.shape)
        : schema.and(progressSchema);
      return tool(
        (args: any) => serializeToolCall(async () => {
          if (agentControl.isStopped(agentId)) {
            warnInner(agentId, "aborted tool execution: agent is stopped/exited", { capability, method });
            throw new AgentStopRequestedError(`Agent ${agentId} was stopped/exited; tool execution aborted.`);
          }
          if (isNoProgressStopRequested?.()) {
            throw new AgentStopRequestedError("No progress budget exhausted for this assignment.");
          }

          // The model supplies a short user-facing progress key with every
          // tool call. It describes why this step is running and becomes the
          // visible Thought update while the provider is busy. Keep it out of
          // the provider arguments and out of duplicate-call signatures.
          const progressHint = typeof args?.progress === "string"
            ? truncateForLog(args.progress, 240)
            : undefined;
          const expectedDurationMs = typeof args?.expectedDurationMs === "number"
            ? Math.min(600_000, Math.max(1, Math.floor(args.expectedDurationMs)))
            : undefined;
          const observationPlan = args?.observationPlan && typeof args.observationPlan === "object"
            ? args.observationPlan as Record<string, unknown>
            : undefined;
          const observationWaitMs = observationPlan && typeof observationPlan.waitForMs === "number"
            ? Math.min(600_000, Math.max(1, Math.floor(observationPlan.waitForMs)))
            : undefined;
          args = args && typeof args === "object" ? { ...args } : {};
          delete args.progress;
          delete args.expectedDurationMs;
          delete args.observationPlan;

          await pauseController.waitIfPaused(taskId);
          await pauseController.waitIfPaused(agentId);
          if (agentControl.isStopped(agentId) || agentControl.isStopped(taskId)) {
            throw new AgentStopRequestedError(`Agent ${agentId} is in terminal stopped state.`);
          }
          // Let the LLM's observation contract configure a persistent session
          // when the provider exposes a compatible observation-window field.
          if (observationWaitMs && method === "observe" && typeof args.windowMs !== "number") {
            args.windowMs = observationWaitMs;
          }
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
            content: progressHint || `${capability}.${method}${argSummary ? ` — ${argSummary}` : ""}`,
            metadata: {
              ...buildToolMetadata(capability, method, args),
              ...(progressHint ? { progress: progressHint } : {}),
              ...(expectedDurationMs ? { expectedDurationMs } : {}),
              ...(observationPlan ? { observationPlan } : {}),
            },
          });
          await bus.publish(`task.${taskId}.agent.${agentId}.action_requested`, {
            kind: "action_requested",
            actionId: call.id,
            agentId,
            taskId,
            capability,
            method,
            args,
            ...(progressHint ? { progress: progressHint } : {}),
            ...(expectedDurationMs ? { expectedDurationMs } : {}),
            ...(observationPlan ? { observationPlan } : {}),
            timestamp: new Date().toISOString(),
          });
          await bus.publish(`task.${taskId}.agent.${agentId}.action_started`, {
            kind: "action_started",
            actionId: call.id,
            agentId,
            taskId,
            capability,
            method,
            args,
            ...(progressHint ? { progress: progressHint } : {}),
            ...(expectedDurationMs ? { expectedDurationMs } : {}),
            ...(observationPlan ? { observationPlan } : {}),
            timestamp: new Date().toISOString(),
          });
          logInner(agentId, "tool requested", {
            capability,
            method,
            argSummary,
            attempt: priorAttempts + 1,
          });
          try {
            const output = await permissions.executeWithApproval(agentId, call, () => invoke(args));
            const outputRecord = output && typeof output === "object" ? output as Record<string, unknown> : {};
            const sessionId = typeof args?.id === "string" ? args.id : typeof outputRecord.id === "string" ? outputRecord.id : undefined;
            if (this.executionSessions && sessionId && ["open", "observe", "attach", "detach", "close", "terminate", "read"].includes(method)) {
              if (method === "open") {
                await this.executionSessions.create({
                  id: sessionId,
                  taskId,
                  agentId,
                  kind: capability === "browser" ? "browser" : "shell",
                  backendId: sessionId,
                  cwd: typeof outputRecord.cwd === "string" ? outputRecord.cwd : undefined,
                  url: typeof outputRecord.url === "string" ? outputRecord.url : undefined,
                  pid: typeof outputRecord.pid === "number" ? outputRecord.pid : undefined,
                });
                await bus.publish(`task.${taskId}.agent.${agentId}.execution-attached`, { sessionId, kind: capability, method, state: "attached", timeoutMs: observationWaitMs ?? expectedDurationMs ?? args.timeoutMs ?? args.windowMs, ...(progressHint ? { progress: progressHint } : {}), ...(observationPlan ? { observationPlan } : {}), ...outputRecord });
              } else if (method === "detach") {
                await this.executionSessions.detach(sessionId);
                await bus.publish(`task.${taskId}.agent.${agentId}.execution-detached`, { sessionId, kind: capability, method, state: "detached", timeoutMs: observationWaitMs ?? expectedDurationMs ?? args.timeoutMs ?? args.windowMs, ...(progressHint ? { progress: progressHint } : {}), ...(observationPlan ? { observationPlan } : {}) });
              } else if (method === "attach") {
                await this.executionSessions.reattach(sessionId);
                await bus.publish(`task.${taskId}.agent.${agentId}.execution-attached`, { sessionId, kind: capability, method, state: "attached", timeoutMs: observationWaitMs ?? expectedDurationMs ?? args.timeoutMs ?? args.windowMs, ...(progressHint ? { progress: progressHint } : {}), ...(observationPlan ? { observationPlan } : {}) });
              } else if (method === "observe" || method === "read") {
                await this.executionSessions.observe(sessionId, {
                  kind: capability === "browser" ? "browser-state" : outputRecord.running === false ? "exit" : "stdout",
                  summary: previewText(outputRecord.output ?? outputRecord.visibleText ?? output, 1_000),
                  outputPath: typeof outputRecord.screenshotPath === "string" ? outputRecord.screenshotPath : undefined,
                  exitCode: typeof outputRecord.exitCode === "number" ? outputRecord.exitCode : undefined,
                  timedOut: outputRecord.timedOut === true,
                });
                await bus.publish(`task.${taskId}.agent.${agentId}.execution-output`, { sessionId, kind: capability, method, timeoutMs: observationWaitMs ?? expectedDurationMs ?? args.timeoutMs ?? args.windowMs, ...(progressHint ? { progress: progressHint } : {}), ...(observationPlan ? { observationPlan } : {}), ...outputRecord });
                if (outputRecord.running === false) {
                  await this.executionSessions.setState(sessionId, "exited", { lastObservedAt: new Date().toISOString() });
                  await bus.publish(`task.${taskId}.agent.${agentId}.execution-exited`, { sessionId, kind: capability, method, timeoutMs: observationWaitMs ?? expectedDurationMs ?? args.timeoutMs ?? args.windowMs, ...(progressHint ? { progress: progressHint } : {}), ...(observationPlan ? { observationPlan } : {}), ...outputRecord });
                }
                if (typeof outputRecord.screenshotPath === "string") {
                  await bus.publish(`task.${taskId}.agent.${agentId}.execution-screenshot`, { sessionId, kind: capability, method, screenshotPath: outputRecord.screenshotPath, timeoutMs: observationWaitMs ?? expectedDurationMs ?? args.timeoutMs ?? args.windowMs, ...(progressHint ? { progress: progressHint } : {}), ...(observationPlan ? { observationPlan } : {}) });
                }
              } else if (method === "close" || method === "terminate") {
                await this.executionSessions.setState(sessionId, "exited");
                await bus.publish(`task.${taskId}.agent.${agentId}.execution-exited`, { sessionId, kind: capability, method, timeoutMs: observationWaitMs ?? expectedDurationMs ?? args.timeoutMs ?? args.windowMs, ...(progressHint ? { progress: progressHint } : {}), ...(observationPlan ? { observationPlan } : {}), ...outputRecord });
              }
            }
            onSuccess?.(args);
            const resultSummary = summarizeToolResult(output);
            const progressSignature = `${capability}.${method}:${JSON.stringify(normalizeProgressArgs(args))}:${resultSummary}`;
            const priorEquivalentResults = progressCounts.get(progressSignature) ?? 0;
            progressCounts.set(progressSignature, priorEquivalentResults + 1);
            const noProgressDetected = priorEquivalentResults >= 1;
            const metadata = buildToolMetadata(capability, method, args, output);
            if (progressHint) metadata.progress = progressHint;
            if (noProgressDetected) {
              metadata.noProgress = {
                repeatedEquivalentResult: priorEquivalentResults + 1,
                maxEquivalentResults: noProgressThreshold,
              };
            }
            toolObservations.push({
              capability,
              method,
              argSummary,
              result: resultSummary,
              ok: true,
              path: typeof args?.path === "string" ? args.path : undefined,
              metadata,
            });
            await bus.publish(`task.${taskId}.agent.${agentId}.tool_requested`, {
              kind: "thought",
              from: agentId,
              content: `✓ ${capability}.${method}: ${resultSummary}`,
              metadata,
            });
            await bus.publish(`task.${taskId}.agent.${agentId}.action_approved`, {
              kind: "action_approved",
              actionId: call.id,
              agentId,
              taskId,
              capability,
              method,
              args,
              timestamp: new Date().toISOString(),
            });
            await bus.publish(`task.${taskId}.agent.${agentId}.action_completed`, {
              kind: "action_completed",
              actionId: call.id,
              agentId,
              taskId,
              capability,
              method,
              args,
              result: output,
              timestamp: new Date().toISOString(),
            });
            if (noProgressDetected) {
              const notice = priorEquivalentResults + 1 >= noProgressThreshold
                ? `No progress detected: ${method} returned equivalent evidence ${priorEquivalentResults + 1} times. The agent is stopping this assignment so YAAA can reassess instead of spending more LLM turns.`
                : `No progress detected: ${method} returned equivalent evidence again. Choose a materially different action or complete the current step.`;
              await bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
                kind: "thought",
                from: agentId,
                content: `🛡️ ${notice}`,
                metadata: { capability, method, repeatedEquivalentResult: priorEquivalentResults + 1 },
              });
              if (priorEquivalentResults + 1 >= noProgressThreshold) {
                // Stop cooperatively at the next model boundary. Throwing from
                // a LangGraph tool node is serialized as a tool error and can
                // otherwise cause LangGraph to ask the model for yet another
                // turn. The mailbox makes the stop visible to preModelHook.
                requestNoProgressStop?.();
                throw new AgentStopRequestedError(notice);
              }
            }
            logInner(agentId, "tool completed", {
              capability,
              method,
              result: resultSummary,
            });
            return capOutput(safeSerialize(output));
          } catch (err: any) {
            if (err instanceof AgentStopRequestedError) throw err;
            const errorSummary = truncateForLog(err?.message ?? String(err));
            const failureSignature = `${capability}.${method}:${normalizeFailureClass(errorSummary)}`;
            const priorEquivalentFailures = failureCounts.get(failureSignature) ?? 0;
            failureCounts.set(failureSignature, priorEquivalentFailures + 1);
            const metadata = {
              ...buildToolMetadata(capability, method, args),
              error: errorSummary,
              ...(priorEquivalentFailures > 0 ? {
                noProgress: {
                  repeatedEquivalentFailure: priorEquivalentFailures + 1,
                  maxEquivalentFailures: noProgressThreshold,
                },
              } : {}),
            };
            toolObservations.push({
              capability,
              method,
              argSummary,
              result: errorSummary,
              ok: false,
              path: typeof args?.path === "string" ? args.path : undefined,
              metadata,
            });
            await bus.publish(`task.${taskId}.agent.${agentId}.tool_requested`, {
              kind: "thought",
              from: agentId,
              content: `✗ ${capability}.${method} failed: ${errorSummary}`,
              metadata,
            });
            const denied = /approval|denied|not approved/i.test(errorSummary);
            if (denied) {
              onPermissionDenied?.(errorSummary);
            }
            await bus.publish(`task.${taskId}.agent.${agentId}.${denied ? "action_denied" : "action_failed"}`, {
              kind: denied ? "action_denied" : "action_failed",
              actionId: call.id,
              agentId,
              taskId,
              capability,
              method,
              args,
              error: errorSummary,
              timestamp: new Date().toISOString(),
            });
            warnInner(agentId, "tool failed", {
              capability,
              method,
              error: err?.message ?? String(err),
              repeatedEquivalentFailure: priorEquivalentFailures + 1,
            });
            if (priorEquivalentFailures + 1 >= noProgressThreshold) {
              const notice = `No progress detected: ${method} returned the same failure ${priorEquivalentFailures + 1} times. The agent is stopping this assignment so YAAA can reassess instead of repeating the failed action.`;
              await bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
                kind: "thought",
                from: agentId,
                content: `🛡️ ${notice}`,
                metadata: { capability, method, repeatedEquivalentFailure: priorEquivalentFailures + 1 },
              });
              requestNoProgressStop?.();
              throw new AgentStopRequestedError(notice);
            }
            return capOutput(`Tool execution error: ${err?.message ?? String(err)}`);
          }
        }),
        {
          name,
          description: `${description} Include a concise progress string (max 240 characters) in the progress argument explaining what this step is doing for the user while it runs. Provide expectedDurationMs when possible. For long-running work, include observationPlan with waitForMs, capture, and detachWhen.`,
          schema: toolSchema,
        },
      );
    };

    let result: StructuredToolInterface[] = [];
    if (selectedSkillIds.length > 0) {
      result.push(
      tool(
        async ({ skillId }: { skillId: string }) => {
          if (!selectedSkillIds.includes(skillId)) {
            return `Skill ${skillId} was not selected for this assignment. Use only the skills named in the assignment brief.`;
          }
          const selectedSkill = getSkill(skillId);
          if (!selectedSkill) return `Selected skill ${skillId} was not found in the local skill registry.`;
          return `## ${selectedSkill.name}\n${selectedSkill.description}\n\n${selectedSkill.content}`;
        },
        {
          name: "read_skill",
          description: "Read one selected skill's technical instructions once during assignment preflight. Do not read unselected skills.",
          schema: z.object({ skillId: z.string().min(1) }),
        },
      ),
      );
    }
    if (filesProvider) result.push(
      gated("code_review_graph_preflight", "preflightCheck", "Inspect the repository code/dependency graph before modifying code. Return only concise affected-node and dependency evidence; do this before the first code write.",
        z.object({
          targetFiles: z.array(z.string()).max(32).optional().describe("Files the assignment may modify."),
          searchQuery: z.string().max(240).optional().describe("Target symbol or narrow code-area query."),
        }),
        async (a) => {
          if (graphPreflightCompleted) {
            return {
              status: "cached",
              summary: "Graph preflight already completed for this assignment; reuse the existing evidence.",
            };
          }
          const output = await graphPreflight.execute(a);
          graphPreflightCompleted = true;
          return output;
        }),
      gated("read_file", "readFile", "Read the complete text contents of a file in the workspace.",
        z.object({ path: z.string().describe("Path to the file.") }),
        async (a) => {
          const output = await filesProvider.readFile(a.path);
          markRead(a.path);
          return fileEvidence(a.path, output);
        }),
      gated("write_file", "writeFile", "Create a new file or update an existing file after reading it. Do not repeatedly overwrite the same path; use targeted line tools for focused edits.",
        z.object({ path: z.string().describe("Path to the file."), content: z.string().describe("Content to write.") }),
        (a) => {
          if (!a.content.length) throw new Error(`EMPTY_ARTIFACT: Refusing to create zero-byte deliverable ${a.path}.`);
          return writeFullFile(a.path, a.content);
        },
        (a) => artifacts.push({ path: a.path, mimeType: inferMime(a.path), description: `File produced by ${role}.` })),
      gated("download_file", "downloadFile", "Download an original binary asset from an HTTP(S) URL into the task workspace. Use this for website logos, photographs, PDFs, and other source assets; do not replace an original asset with generated content.",
        z.object({
          url: z.string().url().describe("HTTP(S) URL of the original asset."),
          outputPath: z.string().describe("Workspace-relative destination path, including the real extension."),
          timeoutMs: z.number().int().positive().max(120_000).optional(),
          maxBytes: z.number().int().positive().max(100 * 1024 * 1024).optional(),
        }),
        (a) => filesProvider.downloadFile(a.url, a.outputPath, { timeoutMs: a.timeoutMs, maxBytes: a.maxBytes }),
        (a) => artifacts.push({ path: a.outputPath, mimeType: inferMime(a.outputPath), description: `Downloaded original asset from ${a.url}.` })),
      gated("list_files", "listFiles", "List files and folders in a directory.",
        z.object({ path: z.string().describe("Directory path to list.") }),
        (a) => filesProvider.listFiles(a.path)),
      gated("search_files", "searchFiles", "Search for files matching a wildcard pattern in a directory.",
        z.object({ pattern: z.string().describe("Wildcard pattern, e.g. *.md."), path: z.string().describe("Directory to search.") }),
        (a) => filesProvider.searchFiles(a.pattern, a.path)),
      gated("read_file_lines", "readLines", "Read a selected inclusive line range from a text file.", z.object({ path: z.string(), startLine: z.number().int().positive().default(1), endLine: z.number().int().positive().optional() }), async (a) => {
        const maxFileExcerptLines = executionContract?.contextPolicy?.maxFileExcerptLines ?? 200;
        const boundedEndLine = a.endLine === undefined
          ? a.startLine + maxFileExcerptLines - 1
          : Math.min(a.endLine, a.startLine + maxFileExcerptLines - 1);
        const output = await filesProvider.readLines(a.path, a.startLine, boundedEndLine);
        markRead(a.path);
        if (output && typeof output === "object" && typeof output.content === "string") {
          return {
            ...fileEvidence(a.path, output.content, output.startLine ?? a.startLine, output.endLine ?? boundedEndLine),
            totalLines: output.totalLines ?? output.content.split(/\r?\n/).length,
            truncatedByContextPolicy: a.endLine !== undefined && a.endLine > boundedEndLine,
          };
        }
        return output;
      }),
      gated("write_file_lines", "writeLines", "Replace an inclusive line range in a text file after reading it. Use this for targeted edits instead of rewriting the whole file.", z.object({ path: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive(), content: z.string() }), async (a) => {
        await assertWritablePath(a.path, true);
        const output = await filesProvider.writeLines(a.path, a.startLine, a.endLine, a.content);
        markWritten(a.path);
        for (const step of subSubtasks) {
          const isVerificationStep = /\b(?:verify|validate|test|confirm|render|inspect)\b/i.test(step.title);
          const namesThisFile = step.title.toLowerCase().includes(a.path.toLowerCase())
            || step.title.toLowerCase().includes(path.basename(a.path).toLowerCase());
          if (!isVerificationStep && namesThisFile && step.state !== "completed") {
            await completeSubSubtask(step.id, `Updated ${a.path}; the implementation artifact is ready for verification.`);
          }
        }
        return output;
      }),
      gated("delete_path", "delete", "Delete a file or directory.", z.object({ path: z.string(), recursive: z.boolean().default(false) }), (a) => filesProvider.delete(a.path, a.recursive)),
      gated("delete_file_lines", "deleteLines", "Delete an inclusive range of lines.", z.object({ path: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive() }), (a) => filesProvider.deleteLines(a.path, a.startLine, a.endLine)),
      gated("create_directory", "createDirectory", "Create a directory and missing parents.", z.object({ path: z.string() }), (a) => filesProvider.createDirectory(a.path)),
      gated("move_path", "move", "Move or rename a file or directory.", z.object({ source: z.string(), destination: z.string() }), (a) => filesProvider.move(a.source, a.destination)),
      gated("copy_path", "copy", "Copy a file or directory recursively.", z.object({ source: z.string(), destination: z.string() }), (a) => filesProvider.copy(a.source, a.destination)),
      gated("path_metadata", "stat", "Get file or directory metadata.", z.object({ path: z.string() }), (a) => filesProvider.stat(a.path)),
      gated("file_screenshot", "screenshot", "Render a text file or line range to a PNG screenshot.", z.object({ path: z.string(), outputPath: z.string(), startLine: z.number().int().positive().default(1), endLine: z.number().int().positive().optional() }), (a) => filesProvider.screenshot(a.path, a.outputPath, a.startLine, a.endLine)),
      gated("generate_image", "generateImage", "Generate an image using AI only when a required matching asset is missing. Before calling, inspect/list existing assets and reuse a suitable existing file; do not create variants or extra images just because the task is visual. If outputPath already exists and is non-empty, keep and reuse it instead of overwriting it.",
        z.object({
          prompt: z.string().describe("Detailed description of the image to generate, e.g. 'a beautiful drawing of a plant cell'."),
          outputPath: z.string().describe("Path to save the generated PNG image in the workspace, e.g. 'images/plant_cell.png'."),
          background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Use transparent for logos, stickers, icons, cutouts, overlays, sprites, or assets placed over other content; opaque for full scenes, posters, and backgrounds; auto only when either is acceptable.")
        }),
        async (a) => {
          try {
            const existing = await filesProvider.stat(a.outputPath);
            if (existing.isFile && existing.size > 0) {
              return { status: "existing", message: `Existing image retained at ${a.outputPath}; reuse it instead of generating another image.` };
            }
          } catch {
            // A missing path is the normal generation case.
          }
          const gateway = this.scope.resolve<any>("IMeshGateway");
          if (!gateway.generateImage) {
            throw new Error("Image generation is not supported by the current gateway.");
          }
          const base64Data = await gateway.generateImage(a.prompt, { background: a.background });
          const buffer = Buffer.from(base64Data, "base64");
          await filesProvider.writeFile(a.outputPath, buffer);
          return { status: "success", message: `Generated image saved to ${a.outputPath}` };
        },
        (a) => artifacts.push({ path: a.outputPath, mimeType: "image/png", description: `AI generated image: ${a.prompt}` })),
      );

    if (filesProvider) {
      type FileBatchAction = { action: string; params?: Record<string, any>; actions?: FileBatchAction[] };
      const maxBatchDepth = maxActionQueueDepth;
      const maxBatchActions = maxActionQueueActions;
      const executeFileBatch = async (actions: FileBatchAction[], depth = 0): Promise<any[]> => {
        if (depth > maxBatchDepth) throw new Error(`file_multi nesting exceeds the maximum depth of ${maxBatchDepth}.`);
        if (actions.length > maxBatchActions) throw new Error(`file_multi accepts at most ${maxBatchActions} actions per level.`);
        const results: any[] = [];
        for (let index = 0; index < actions.length; index += 1) {
          const item = actions[index] ?? {};
          const params = item.params ?? {};
          const actionAliases: Record<string, string> = {
            list: "list_files",
            read: "read_file",
            write: "write_file",
            read_lines: "read_file_lines",
            write_lines: "write_file_lines",
            create_dir: "create_directory",
            stat: "path_metadata",
            delete: "delete_path",
            move: "move_path",
            copy: "copy_path",
            download: "download_file",
            screenshot: "file_screenshot",
            generateImage: "generate_image",
          };
          const action = actionAliases[item.action] ?? item.action;
          let value: unknown;
          switch (action) {
            case "read_file":
              value = await filesProvider.readFile(params.path);
              markRead(params.path);
              break;
            case "read_file_lines":
              value = await filesProvider.readLines(params.path, params.startLine ?? 1, params.endLine);
              markRead(params.path);
              break;
            case "write_file":
              value = await writeFullFile(params.path, params.content);
              artifacts.push({ path: params.path, mimeType: inferMime(params.path), description: `File produced by ${role}.` });
              break;
            case "write_file_lines":
              await assertWritablePath(params.path, true);
              value = await filesProvider.writeLines(params.path, params.startLine, params.endLine, params.content);
              markWritten(params.path);
              for (const step of subSubtasks) {
                const isVerificationStep = /\b(?:verify|validate|test|confirm|render|inspect)\b/i.test(step.title);
                const namesThisFile = step.title.toLowerCase().includes(String(params.path).toLowerCase())
                  || step.title.toLowerCase().includes(path.basename(String(params.path)).toLowerCase());
                if (!isVerificationStep && namesThisFile && step.state !== "completed") {
                  await completeSubSubtask(step.id, `Updated ${params.path}; the implementation artifact is ready for verification.`);
                }
              }
              artifacts.push({ path: params.path, mimeType: inferMime(params.path), description: `Line-range update produced by ${role}.` });
              value = { status: "ok", path: params.path, startLine: params.startLine, endLine: params.endLine };
              break;
            case "delete_file_lines": value = await filesProvider.deleteLines(params.path, params.startLine, params.endLine); break;
            case "list_files": value = await filesProvider.listFiles(params.path); break;
            case "search_files": value = await filesProvider.searchFiles(params.pattern, params.path); break;
            case "path_metadata": value = await filesProvider.stat(params.path); break;
            case "delete_path": value = await filesProvider.delete(params.path, params.recursive ?? false); break;
            case "create_directory": value = await filesProvider.createDirectory(params.path); break;
            case "move_path": value = await filesProvider.move(params.source, params.destination); break;
            case "copy_path": value = await filesProvider.copy(params.source, params.destination); break;
            case "download_file":
              value = await filesProvider.downloadFile(params.url, params.outputPath, {
                timeoutMs: params.timeoutMs,
                maxBytes: params.maxBytes,
              });
              artifacts.push({ path: params.outputPath, mimeType: inferMime(params.outputPath), description: `Downloaded asset produced by ${role}.` });
              break;
            case "file_screenshot":
              value = await filesProvider.screenshot(params.path, params.outputPath, params.startLine, params.endLine);
              artifacts.push({ path: params.outputPath, mimeType: "image/png", description: `File screenshot produced by ${role}.` });
              break;
            case "generate_image": {
              const existing = await filesProvider.stat(params.outputPath).catch(() => undefined);
              if (existing?.isFile && existing.size > 0) {
                value = { status: "existing", message: `Existing image retained at ${params.outputPath}.` };
                break;
              }
              const gateway = this.scope.resolve<any>("IMeshGateway");
              if (!gateway.generateImage) throw new Error("Image generation is not supported by the current gateway.");
              const base64Data = await gateway.generateImage(params.prompt, { background: params.background ?? "auto" });
              await filesProvider.writeFile(params.outputPath, Buffer.from(base64Data, "base64"));
              artifacts.push({ path: params.outputPath, mimeType: "image/png", description: `AI generated image produced by ${role}.` });
              value = { status: "success", message: `Generated image saved to ${params.outputPath}` };
              break;
            }
            case "multi": value = await executeFileBatch(item.actions ?? [], depth + 1); break;
            default: throw new Error(`Unknown action in file_multi execution: ${item.action}`);
          }
          results.push({ index, action, result: value === undefined ? { status: "ok" } : value });
        }
        return results;
      };

      result.push(gated(
        "file_multi",
        "multi",
        "Execute sequential file operations from array index 0. Supports bounded recursive multi actions and common aliases (list/read/write/create_directory/stat/delete/move/copy/download/screenshot/generateImage). Never place shell, browser, or web actions here. Use read_file_lines, write_file_lines, and delete_file_lines for targeted line-range work instead of loading or rewriting whole files.",
        z.object({
          actions: z.array(z.object({
            action: z.string(),
            params: z.record(z.string(), z.any()).optional(),
            actions: z.array(z.any()).optional(),
          })).max(maxBatchActions).describe("File operations executed sequentially from index 0 to N-1."),
        }),
        (args) => executeFileBatch(args.actions),
        undefined,
        "files",
      ));
    }

    // A model turn is not evidence that a micro-step finished. Completion is
    // therefore explicit and evidence-backed, via this dedicated tool.
    result.push(gated(
      "complete_sub_subtask",
      "completeSubSubtask",
      `Mark any listed sub-subtask complete when its work is actually finished with evidence, even if it is not the currently running step. The active step remains running until explicitly completed: ${subSubtasks.map((step) => `${step.id}: ${step.title}`).join("; ")}`,
      z.object({
        subSubtaskId: z.string().describe("Exact runtime id only, for example subtask-1.1. Do not include the title or a colon."),
        result: z.string().max(1_000).optional().describe("Short evidence-backed completion note."),
      }),
      (args) => completeSubSubtask(args.subSubtaskId, args.result),
      undefined,
      "files",
    ));
    result.push(gated(
      "add_sub_subtask",
      "addSubSubtask",
      "Add a genuinely new required micro-step discovered while doing this assignment. Do not use this for ordinary tool calls or model turns.",
      z.object({
        title: z.string().min(10).max(240).describe("Clear actionable title for the newly discovered micro-step."),
        result: z.string().max(1_000).optional().describe("Why this step is needed or evidence already known.")
      }),
      (args) => addSubSubtask(args.title, args.result),
      undefined,
      "files",
    ));

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
        "file_multi",
      ]);
      result = result.filter((tool) => !blockedFileWriters.has(tool.name));
    }

    // A worker can explicitly ask the orchestrator for clarification without
    // leaving LangGraph or spawning a replacement agent. The request is
    // queued for the outer event loop and surfaced to the UI immediately.
    result.push(
      tool(
        async ({ question }: { question: string }) => {
          orchestratorMailbox.post({
            id: `agent-question-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            taskId,
            from: "agent",
            agentId,
            content: question,
            createdAt: new Date().toISOString(),
          });
          await bus.publish(`task.${taskId}.agent_message`, {
            kind: "help_request",
            from: agentId,
            to: "orchestrator",
            problem: question,
          });
          return "queued";
        },
        {
          name: "ask_orchestrator",
          description: "Queue one concise, self-contained question or blocker for the orchestrator and continue with safe work. The question must make sense without prior conversation: name the subject, state the exact decision or missing information, avoid fragments or vague references, and do not assume multiple-choice options unless you list and explain every option.",
          schema: z.object({ question: z.string().min(1) }),
        },
      ),
      tool(
        async ({ additionalMs, reason }: { additionalMs: number; reason: string }) => {
          orchestratorMailbox.post({
            id: `agent-extension-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            taskId,
            from: "agent",
            agentId,
            kind: "extension_request",
            additionalMs,
            content: reason,
            createdAt: new Date().toISOString(),
          });
          await bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
            kind: "thought",
            from: agentId,
            taskId,
            content: `⏳ Requested +${Math.round(additionalMs / 1000)}s from YAAA: ${reason}`,
          });
          return "Extension request queued. Continue with the current work; YAAA will approve or deny it asynchronously. If denied, save a checkpoint and stop starting new expensive work.";
        },
        {
          name: "request_extension",
          description: "Ask YAAA for bounded additional wall-clock time when the current work is making real progress but cannot finish within the current timebox. This is a request, not a guarantee; state the exact remaining work and why the extra time is needed.",
          schema: z.object({
            additionalMs: z.number().int().min(30_000).max(300_000),
            reason: z.string().min(1).max(500),
          }),
        },
      ),
    );

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
        gated("execute_command", "execute", "Run a short command with a hard timeout and separate stdout/stderr. Use open_terminal for installs, builds, dev servers, migrations, docker compose, or any process expected to run longer than 30 seconds.", z.object({ command: z.string(), cwd: z.string().optional(), timeoutMs: z.number().int().positive().max(300_000).default(30_000) }), (a) => shell.execute(a.command, withWorkspaceCwd(a)), undefined, "shell"),
        gated("open_terminal", "open", "Open a durable interactive terminal session for installs, builds, dev servers, migrations, docker compose, and other long-running work. Detaching stops observation but does not kill the process.", z.object({ id: z.string().optional(), cwd: z.string().optional(), shell: z.string().optional() }), (a) => shell.open(withWorkspaceCwd(a)), undefined, "shell"),
        gated("write_terminal", "write", "Write input to an existing terminal; optionally press Enter.", z.object({ id: z.string(), input: z.string(), enter: z.boolean().default(false) }), (a) => shell.write(a.id, a.input, a.enter), undefined, "shell"),
        gated("read_terminal", "read", "Read buffered output and status from an existing terminal.", z.object({ id: z.string(), from: z.number().int().nonnegative().default(0), clear: z.boolean().default(false) }), (a) => shell.read(a.id, a.from, a.clear), undefined, "shell"),
        gated("observe_terminal", "observe", "Observe a bounded tail of a durable terminal session for 15–60 seconds without killing it.", z.object({ id: z.string(), windowMs: z.number().int().positive().max(60_000).default(15_000), from: z.number().int().nonnegative().optional(), maxLines: z.number().int().positive().max(200).default(200) }), (a) => shell.observe(a.id, a), undefined, "shell"),
        gated("detach_terminal", "detach", "Stop observing a terminal while leaving its process alive.", z.object({ id: z.string() }), (a) => shell.detach(a.id), undefined, "shell"),
        gated("attach_terminal", "attach", "Reattach observation to an existing terminal session.", z.object({ id: z.string() }), (a) => shell.attach(a.id), undefined, "shell"),
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
        gated("open_browser", "open", "Open a persistent Chromium browser session. If the target URL is known, provide it so the session navigates before returning; otherwise call browser_navigate immediately after this tool. Do not inspect or screenshot the initial blank page as if it were the target. Observation screenshots are saved under the agent workspace.", z.object({ id: z.string().optional(), url: z.string().url().optional().describe("Target page URL to navigate to before returning."), timeoutMs: z.number().positive().default(30_000), headless: z.boolean().default(true) }), async (a) => {
          const opened = await browser.open({ ...a, agentId });
          if (!a.url) return opened;
          return { ...opened, ...(await browser.navigate(opened.id, a.url, a.timeoutMs)) };
        }, undefined, "browser"),
        gated("browser_navigate", "navigate", "Navigate a browser session to a URL.", z.object({ id: z.string(), url: z.string().url(), timeoutMs: z.number().positive().default(30000) }), (a) => browser.navigate(a.id, a.url, a.timeoutMs), undefined, "browser"),
        gated("browser_navigate_and_wait", "navigateAndWait", "Navigate a browser session to a URL and wait for a selector or network idle state before returning.", z.object({ id: z.string(), url: z.string().url(), waitForSelector: z.string().optional(), waitUntil: z.enum(["domcontentloaded", "load", "networkidle"]).default("networkidle"), timeoutMs: z.number().positive().default(30000) }), (a) => browser.navigateAndWait(a.id, a.url, a), undefined, "browser"),
        gated("browser_click", "click", "Click an element selected with CSS or Playwright syntax.", z.object({ id: z.string(), selector: z.string() }), (a) => browser.click(a.id, a.selector), undefined, "browser"),
        gated("browser_type", "type", "Type into an element, optionally clearing and submitting.", z.object({ id: z.string(), selector: z.string(), text: z.string(), clear: z.boolean().default(false), submit: z.boolean().default(false) }), (a) => browser.type(a.id, a.selector, a.text, a), undefined, "browser"),
        gated("browser_fill_form", "fill", "Fill multiple form fields by selector.", z.object({ id: z.string(), values: z.record(z.string(), z.union([z.string(), z.boolean()])) }), (a) => browser.fill(a.id, a.values), undefined, "browser"),
        gated("browser_select", "select", "Select one or more options.", z.object({ id: z.string(), selector: z.string(), values: z.union([z.string(), z.array(z.string())]) }), (a) => browser.select(a.id, a.selector, a.values), undefined, "browser"),
        gated("browser_press", "press", "Press a keyboard key on an element.", z.object({ id: z.string(), selector: z.string(), key: z.string() }), (a) => browser.press(a.id, a.selector, a.key), undefined, "browser"),
        gated("browser_hover", "hover", "Hover over an element.", z.object({ id: z.string(), selector: z.string() }), (a) => browser.hover(a.id, a.selector), undefined, "browser"),
        gated("browser_reload", "reload", "Reload the current page.", z.object({ id: z.string() }), (a) => browser.reload(a.id), undefined, "browser"),
        gated("browser_refresh", "refresh", "Refresh the current page.", z.object({ id: z.string() }), (a) => browser.refresh(a.id), undefined, "browser"),
        gated("browser_back", "back", "Navigate backward in session history.", z.object({ id: z.string() }), (a) => browser.back(a.id), undefined, "browser"),
        gated("browser_go_back", "goBack", "Go back one step in browser history.", z.object({ id: z.string() }), (a) => browser.goBack(a.id), undefined, "browser"),
        gated("browser_go_back_times", "goBackTimes", "Go back N steps in browser history.", z.object({ id: z.string(), times: z.number().int().min(1).max(20).default(1) }), (a) => browser.goBackTimes(a.id, a.times), undefined, "browser"),
        gated("browser_forward", "forward", "Navigate forward in session history.", z.object({ id: z.string() }), (a) => browser.forward(a.id), undefined, "browser"),
        gated("browser_go_front", "goFront", "Go front (forward) one step in browser history.", z.object({ id: z.string() }), (a) => browser.goFront(a.id), undefined, "browser"),
        gated("browser_go_front_times", "goFrontTimes", "Go front (forward) N steps in browser history.", z.object({ id: z.string(), times: z.number().int().min(1).max(20).default(1) }), (a) => browser.goFrontTimes(a.id, a.times), undefined, "browser"),
        gated("browser_wait", "waitFor", "Wait for an element to appear.", z.object({ id: z.string(), selector: z.string(), timeoutMs: z.number().positive().default(30000) }), (a) => browser.waitFor(a.id, a.selector, a.timeoutMs), undefined, "browser"),
        gated("browser_content", "content", "Get rendered text and HTML from an element.", z.object({ id: z.string(), selector: z.string().default("body") }), (a) => browser.content(a.id, a.selector), undefined, "browser"),
        gated("observe_browser", "observe", "Collect a bounded browser snapshot: URL, title, visible text, readiness, console errors, network failures, and a durable screenshot.", z.object({ id: z.string() }), (a) => browser.observe(a.id), undefined, "browser"),
        gated("attach_browser", "attach", "Reattach observation to a persistent browser session.", z.object({ id: z.string() }), (a) => browser.attachBrowser(a.id), undefined, "browser"),
        gated("detach_browser", "detach", "Stop observing a browser while leaving the Chromium session alive.", z.object({ id: z.string() }), (a) => browser.detachBrowser(a.id), undefined, "browser"),
        gated("browser_evaluate_script", "evaluate", "Run one complete JavaScript/async IIFE in the page and return JSON-serializable observations. Use this for splash-screen timers, delayed transitions, games, performance measurements, and other time-bound behavior: collect the whole interaction and timing sequence inside one injected script instead of relying on many model round trips. If the requirement cannot be evaluated by one script or existing app instrumentation, report that limitation and request a shell test harness or instrumentation.", z.object({ id: z.string(), script: z.string().min(1).describe("A complete JavaScript expression or async IIFE that returns JSON-serializable observations/results.") }), (a) => browser.evaluate(a.id, a.script), undefined, "browser"),
        gated("browser_screenshot", "screenshot", "Capture a page, full page, or element screenshot. Screenshots are stored in the agent logs folder.", z.object({ id: z.string(), outputPath: z.string(), fullPage: z.boolean().default(false), selector: z.string().optional() }), async (a) => {
          const target = screenshotLogPath(workspaceRoot, agentId, a.outputPath);
          const savedPath = await browser.screenshot(a.id, target.absolute, a);
          return { screenshotPath: target.relative, screenshotAbsolutePath: savedPath };
        }, undefined, "browser"),
        gated("capture_browser_screenshot", "captureScreenshot", "Capture a durable screenshot for an observation window.", z.object({ id: z.string(), outputPath: z.string() }), async (a) => {
          const target = screenshotLogPath(workspaceRoot, agentId, a.outputPath);
          return { screenshotPath: target.relative, screenshotAbsolutePath: await browser.captureBrowserScreenshot(a.id, target.absolute) };
        }, undefined, "browser"),
        gated("browser_multi", "multi", "Execute an array of browser actions sequentially starting from index 0. Supports nested recursive multi action arrays.", z.object({ id: z.string(), actions: z.array(z.object({ action: z.string(), params: z.record(z.string(), z.any()).optional(), actions: z.array(z.any()).optional() })).describe("Sequential array of actions executed from index 0 to N-1.") }), (a) => { validateActionQueue(a.actions); return browser.multi(a.id, a.actions); }, undefined, "browser"),
        gated("close_browser", "close", "Close a Chromium session.", z.object({ id: z.string() }), (a) => browser.close(a.id), undefined, "browser"),
      );
      }
    }
    const configuredToolAllowlist = executionContract?.contextPolicy?.allowedTools ?? [];
    if (configuredToolAllowlist.length > 0) {
      const essentialTools = new Set([
        "complete_sub_subtask",
        "add_sub_subtask",
        "ask_orchestrator",
        ...(selectedSkillIds.length > 0 && executionContract?.contextPolicy?.includeFullSkillDocs === false ? ["read_skill"] : []),
        ...(requireGraphPreflight ? ["code_review_graph_preflight"] : []),
      ]);
      const toolAliases: Record<string, string> = {
        shell_exec: "execute_command",
        execute_shell_command: "execute_command",
        shell_execute: "execute_command",
        shell_execute_command: "execute_command",
        files_read: "read_file",
        files_write: "write_file",
        files_read_lines: "read_file_lines",
        files_write_lines: "write_file_lines",
        files_multi: "file_multi",
      };
      const canonicalToolName = (tool: string): string => {
        const trimmed = tool.trim();
        const withoutNamespace = trimmed.replace(/^(?:files|shell|browser|web)\./, "");
        return toolAliases[trimmed] ?? toolAliases[withoutNamespace] ?? withoutNamespace;
      };
      const allowed = new Set([...configuredToolAllowlist.map(canonicalToolName), ...essentialTools]);
      // A planner-generated allowlist may omit the execution tool even though
      // the selected role has shell capability and the assignment explicitly
      // requires a run/build/test/generate/validate action. Preserve the
      // planner's narrow file set, but expose only the minimal shell entry
      // point needed to execute the declared verification/production step.
      const executionIntent = /\b(?:run|execute|build|test|generate|compile|validate|smoke|start)\b/i.test(
        `${assignmentInstruction}\n${executionContract?.expectedNextActions?.join(" ") ?? ""}`,
      );
      if (capabilities.includes("shell") && executionIntent) {
        allowed.add("execute_command");
        allowed.add("open_terminal");
        allowed.add("read_terminal");
      }
      return result.filter((candidate: any) => allowed.has(candidate.name));
    }
    return result;
  }
}
