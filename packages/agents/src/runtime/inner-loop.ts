import type { IBus, ModelRole } from "@yaaa/interfaces";
import { container, type Container, PermissionEngine, pauseController } from "@yaaa/platform";
import { type ArtifactRef, type ToolCall, isInsufficientFundsError } from "@yaaa/shared";
import { AGENT_REGISTRY } from "../registry.js";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, isAIMessage, type BaseMessage } from "@langchain/core/messages";
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
const DEFAULT_MAX_TURNS = 20;

function resolveMaxTurns(): number {
  const raw = Number(process.env.YAAA_MAX_TURNS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_TURNS;
}

/** The runtime registers this factory so tests can inject a fake chat model. */
export type ChatModelFactory = (role: ModelRole) => BaseChatModel;

export interface WorkerOptions {
  agentId: string;
  taskId: string;
  templateName: string;
  instruction: string;
  contextArtifacts?: string[];
  maxTurns?: number;
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

/** Verifiers end with a VERDICT line; default to passed when unstated (real
 * pass/fail is the Synthesizer's job — this is informational). */
function parseVerdict(text: string): { status: "passed" | "failed"; reason: string } {
  const match = text.match(/VERDICT:\s*(PASS(?:ED)?|FAIL(?:ED)?)/i);
  const failed = match ? /^FAIL/i.test(match[1]) : /\bfail(ed|ure|s)?\b/i.test(text);
  return { status: failed ? "failed" : "passed", reason: text || "No verdict text produced." };
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
    const model = this.modelFactory(template.modelRole);

    const agent = createReactAgent({
      llm: model,
      tools,
      prompt: template.systemPrompt,
      // Honour a user-issued pause between model turns without polling.
      preModelHook: async () => {
        await pauseController.waitIfPaused(agentId);
        return {};
      },
    });

    const userParts = [instruction];
    if (contextArtifacts.length > 0) {
      userParts.push(`Context artifacts available:\n${contextArtifacts.join("\n")}`);
    }

    let finalState: { messages: BaseMessage[] };
    try {
      finalState = (await agent.invoke(
        { messages: [new HumanMessage(userParts.join("\n\n"))] },
        { recursionLimit: Math.max(4, this.maxTurns * 2), configurable: { thread_id: agentId } },
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
      const verdict = parseVerdict(finalText);
      await this.publishResult(taskId, agentId, [], verdict.reason);
      return verdict;
    }

    const summary = finalText || "Subtask completed.";
    await this.publishResult(taskId, agentId, artifacts, summary);
    return { artifacts, summary };
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
    if (!capabilities.includes("files")) return [];
    const filesProvider = this.scope.resolve<any>("capability:files");
    const bus = this.bus;
    const permissions = this.permissions;

    const gated = (
      name: string,
      method: string,
      description: string,
      schema: z.ZodTypeAny,
      invoke: (args: any) => Promise<unknown>,
      onSuccess?: (args: any) => void,
    ) =>
      tool(
        async (args: any) => {
          const call: ToolCall = {
            id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            capability: "files",
            method,
            args,
          };
          await bus.publish(`task.${taskId}.agent.${agentId}.tool_requested`, {
            kind: "thought",
            from: agentId,
            content: `Requesting execution of files.${method}`,
          });
          try {
            const output = await permissions.executeWithApproval(agentId, call, () => invoke(args));
            onSuccess?.(args);
            return typeof output === "string" ? output : JSON.stringify(output ?? { status: "ok" });
          } catch (err: any) {
            return `Tool execution error: ${err?.message ?? String(err)}`;
          }
        },
        { name, description, schema },
      );

    return [
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
    ];
  }
}
