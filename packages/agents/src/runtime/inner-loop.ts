import type { IBus, ModelRole, IMeshGateway } from "@yaaa/interfaces";
import { container, type Container, PermissionEngine, pauseController } from "@yaaa/platform";
import { type ArtifactRef, type ToolCall, isInsufficientFundsError } from "@yaaa/shared";
import { AGENT_REGISTRY } from "../registry.js";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { AIMessage, HumanMessage, ToolMessage, isAIMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

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
const DEFAULT_AGENT_INVOKE_TIMEOUT_MS = 120_000;

function resolveAgentInvokeTimeout(): number {
  const raw =
    Number(process.env.YAAA_AGENT_INVOKE_TIMEOUT_MS) ||
    Number(process.env.YAAA_TIMEOUT) ||
    Number(process.env.MESH_TIMEOUT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_AGENT_INVOKE_TIMEOUT_MS;
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

    this.permissions.grantScope(agentId, {
      capabilities: template.capabilities,
      allowedPaths: [process.cwd()],
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
    const tools = this.buildTools(template.capabilities, template.role, agentId, taskId, artifacts);
    const modelName = options.model ?? template.modelRole;
    const model = this.modelFactory(modelName);

    const agent = createReactAgent({
      llm: model,
      tools,
      prompt: template.systemPrompt,
      // Honour a user-issued pause between model turns without polling, and
      // sanitise the model input so no empty text content block reaches a
      // Bedrock-backed model. `llmInputMessages` overrides only what is sent to
      // the LLM this turn — the persisted transcript in `messages` is untouched.
      preModelHook: async (state: { messages: BaseMessage[] }) => {
        await pauseController.waitIfPaused(agentId);
        return { llmInputMessages: state.messages.map(withNonEmptyContent) };
      },
    });

    const userParts = [instruction];
    if (contextArtifacts.length > 0) {
      userParts.push(`Context artifacts available:\n${contextArtifacts.join("\n")}`);
    }

    let finalState: { messages: BaseMessage[] };
    try {
      const invokeTimeoutMs = resolveAgentInvokeTimeout();
      await this.bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
        kind: "thought",
        from: agentId,
        content: `Waiting for ${options.templateName} model response (${modelName}).`,
      });
      finalState = (await withTimeout(
        (signal) =>
          agent.invoke(
            { messages: [new HumanMessage(userParts.join("\n\n"))] },
            {
              recursionLimit: Math.max(4, this.maxTurns * 2),
              configurable: { thread_id: agentId },
              signal,
            },
          ),
        invokeTimeoutMs,
        `Agent model invocation timed out after ${invokeTimeoutMs}ms before producing progress.`,
      )) as { messages: BaseMessage[] };
    } catch (err) {
      if (isInsufficientFundsError(err)) throw err;
      if (isRecursionLimitError(err)) {
        throw new Error(
          `Agent inner-loop exceeded max turns of ${this.maxTurns} without yielding a result.`,
        );
      }
      throw err;
    }

    const finalText = finalTextOf(finalState.messages);

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

    const summary = finalText || "Subtask completed.";
    const finalArtifacts = await this.ensureHandoffArtifacts({
      agentId,
      taskId,
      templateName: options.templateName,
      agentWorkspace,
      artifacts,
      summary,
    });
    await this.publishResult(taskId, agentId, finalArtifacts, summary);
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
  }): Promise<ArtifactRef[]> {
    const filesProvider = this.scope.resolve<any>("capability:files");
    const artifacts = [...input.artifacts];
    const now = new Date().toISOString();
    const proofPath = `${input.agentWorkspace}/proofOfWork.md`;
    const handOffPath = `${input.agentWorkspace}/handOff.md`;
    const alreadyProduced = new Set(artifacts.map((artifact) => artifact.path));

    if (!alreadyProduced.has(proofPath)) {
      const verifierBlock = input.verifier
        ? `\n## Verification\n\n- Status: ${input.verifier.status}\n- Findings:\n${input.verifier.findings.map((item) => `  - ${item}`).join("\n") || "  - None recorded."}\n- Evidence:\n${input.verifier.evidence.map((item) => `  - ${item}`).join("\n") || "  - None recorded."}\n`
        : "";
      await filesProvider.writeFile(
        proofPath,
        `# Proof of Work\n\n- Task: ${input.taskId}\n- Agent: ${input.agentId}\n- Role: ${input.templateName}\n- Created: ${now}\n\n## Result Summary\n\n${input.summary.trim() || "No summary was provided."}\n${verifierBlock}\n## Produced Artifacts\n\n${formatArtifactList(input.artifacts)}\n`,
      );
      artifacts.push({
        path: proofPath,
        mimeType: "text/markdown",
        description: `Proof of work produced by ${input.templateName}.`,
      });
    }

    if (!alreadyProduced.has(handOffPath)) {
      await filesProvider.writeFile(
        handOffPath,
        `# Agent Handoff\n\n- Task: ${input.taskId}\n- Agent: ${input.agentId}\n- Role: ${input.templateName}\n- Created: ${now}\n\n## Work Done\n\n${input.summary.trim() || "No summary was provided."}\n\n## Observations\n\n- Review the proof of work and produced artifacts listed below before deciding whether to continue, revise, or spin another agent.\n\n## Suggestions\n\n- Continue from the concrete artifacts and evidence, not from assumptions.\n- If follow-up work is needed, create a fresh handsOn.md that cites this handOff.md and the relevant artifacts.\n\n## Asset Metadata\n\n${formatArtifactList(artifacts)}\n\n## Residual Risks\n\n- None identified by the runtime. Review the proof of work for task-specific caveats.\n\n## Continuation Instructions\n\n- Start by reading this handOff.md and proofOfWork.md.\n- Inspect any listed artifacts before modifying them.\n- Preserve useful outputs from this agent and only redo work when evidence shows a gap.\n`,
      );
      artifacts.push({
        path: handOffPath,
        mimeType: "text/markdown",
        description: `Continuation handoff produced by ${input.templateName}.`,
      });
    }

    return artifacts;
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
  ): StructuredToolInterface[] {
    const filesProvider = capabilities.includes("files") ? this.scope.resolve<any>("capability:files") : undefined;
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
            return `This exact ${capability}.${method} call has already been attempted ${priorAttempts} times with the same arguments and produced no new progress. Do not call it again with these arguments. Either try a materially different approach (new arguments, a different tool) or, if you cannot make progress, stop and report what you have found so far.`;
          }

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
          });
          try {
            const output = await permissions.executeWithApproval(agentId, call, () => invoke(args));
            onSuccess?.(args);
            await bus.publish(`task.${taskId}.agent.${agentId}.tool_requested`, {
              kind: "thought",
              from: agentId,
              content: `✓ ${capability}.${method}: ${summarizeToolResult(output)}`,
            });
            return capOutput(safeSerialize(output));
          } catch (err: any) {
            await bus.publish(`task.${taskId}.agent.${agentId}.tool_requested`, {
              kind: "thought",
              from: agentId,
              content: `✗ ${capability}.${method} failed: ${truncateForLog(err?.message ?? String(err))}`,
            });
            return capOutput(`Tool execution error: ${err?.message ?? String(err)}`);
          }
        },
        { name, description, schema },
      );

    const result: StructuredToolInterface[] = filesProvider ? [
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

    if (capabilities.includes("shell")) {
      const shell = optionalProvider("capability:shell");
      if (shell) {
      result.push(
        gated("execute_command", "execute", "Run a command with timeout and separate stdout/stderr.", z.object({ command: z.string(), cwd: z.string().optional(), timeoutMs: z.number().positive().optional() }), (a) => shell.execute(a.command, a), undefined, "shell"),
        gated("open_terminal", "open", "Open a durable interactive terminal session.", z.object({ id: z.string().optional(), cwd: z.string().optional(), shell: z.string().optional() }), (a) => shell.open(a), undefined, "shell"),
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
