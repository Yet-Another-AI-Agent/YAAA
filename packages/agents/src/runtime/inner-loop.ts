import type { IMeshGateway, IBus, ChatMessage, ToolDefinition } from "@yaaa/interfaces";
import { container, type Container, PermissionEngine, pauseController } from "@yaaa/platform";
import {
  type AgentMessage,
  type ToolCall,
  compactMessages,
  needsSummary,
  applySummary,
  estimateChars,
  middleBand,
} from "@yaaa/shared";
import { AGENT_REGISTRY, type AgentTemplate } from "../registry.js";
import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import { AgentState, type AgentStateType } from "./graph-state.js";

const SUMMARY_REFRESH_CHARS = 12000;
const SUMMARY_SYSTEM_PROMPT =
  "You are a summarization assistant for an autonomous agent's working memory. " +
  "Compress the provided transcript into a terse note capturing the key decisions, " +
  "important tool results, and the current state of the work. Preserve concrete " +
  "facts (file names, values, errors) an agent would need to continue. Keep it " +
  "under ~250 words. Output only the note — no preamble, headings, or commentary.";

export interface WorkerOptions {
  agentId: string;
  taskId: string;
  templateName: string;
  instruction: string;
  contextArtifacts?: string[];
  maxTurns?: number;
}

const CAPABILITY_TOOL_DEFINITIONS: Record<string, ToolDefinition[]> = {
  files: [
    {
      name: "files:readFile",
      description: "Read the complete text contents of a file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path to the file." },
        },
        required: ["path"],
      },
    },
    {
      name: "files:writeFile",
      description: "Create or overwrite a file in the workspace with specific text content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path to the file." },
          content: { type: "string", description: "The content to write to the file." },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "files:listFiles",
      description: "List all files and folders in a specific directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The directory path to list." },
        },
        required: ["path"],
      },
    },
    {
      name: "files:searchFiles",
      description: "Search for files matching a wildcard pattern inside a directory.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "The search pattern (e.g. *.js)." },
          path: { type: "string", description: "The directory to search." },
        },
        required: ["pattern", "path"],
      },
    },
  ],
};

export class InnerLoop {
  private gateway: IMeshGateway;
  private bus: IBus;
  private permissions: PermissionEngine;
  private scope: Container;
  private maxTurns: number;

  constructor(scope: Container = container) {
    this.scope = scope;
    this.gateway = scope.resolve<IMeshGateway>("IMeshGateway");
    this.bus = scope.resolve<IBus>("IBus");
    this.permissions = scope.resolve<PermissionEngine>("PermissionEngine");
    this.maxTurns = 10;
  }

  async run(options: WorkerOptions): Promise<any> {
    const template = AGENT_REGISTRY[options.templateName];
    if (!template) {
      throw new Error(`Agent template ${options.templateName} not found in registry.`);
    }

    const { agentId, taskId, instruction, contextArtifacts = [] } = options;
    this.maxTurns = options.maxTurns || 10;

    this.permissions.grantScope(agentId, {
      capabilities: template.capabilities,
      allowedPaths: [process.cwd()],
      riskCeiling: template.riskCeiling,
    });

    const userParts = [instruction];
    if (contextArtifacts.length > 0) {
      userParts.push(`Context artifacts available:\n${contextArtifacts.join("\n")}`);
    }
    const initialMessages: ChatMessage[] = [
      { role: "system", content: template.systemPrompt },
      { role: "user", content: userParts.join("\n\n") },
    ];

    await this.bus.publish(`task.${taskId}.agent.${agentId}.started`, {
      kind: "status",
      from: agentId,
      taskId,
      state: "working",
      note: `Spawned ${options.templateName} to execute subtask.`
    });

    const checkpointer = new MemorySaver();
    const workflow = new StateGraph(AgentState)
      .addNode("callModel", this.callModel.bind(this))
      .addNode("executeTools", this.executeTools.bind(this))
      .addEdge(START, "callModel")
      .addConditionalEdges("callModel", this.shouldContinue.bind(this))
      .addEdge("executeTools", "callModel");

    const app = workflow.compile({ checkpointer });

    const finalState = await app.invoke({
      messages: initialMessages,
      taskId,
      agentId,
      templateName: options.templateName,
      instruction,
      currentStep: 1,
      errors: [],
      status: "working",
    }, {
      configurable: { thread_id: agentId }
    });

    if (finalState.status === "failed") {
      throw new Error(finalState.errors[finalState.errors.length - 1] || "Agent execution failed.");
    }

    return finalState.result;
  }

  private async callModel(state: AgentStateType): Promise<Partial<AgentStateType>> {
    await pauseController.waitIfPaused(state.agentId);

    if (state.currentStep > this.maxTurns) {
      return {
        status: "failed",
        errors: [...state.errors, `Agent inner-loop exceeded max turns of ${this.maxTurns} without yielding a result.`],
      };
    }

    const template = AGENT_REGISTRY[state.templateName];
    if (!template) {
      throw new Error(`Agent template ${state.templateName} not found.`);
    }

    // Two-tier memory compaction
    const cleared = compactMessages(state.messages);
    let prompt = cleared;
    if (needsSummary(cleared)) {
      const summary = await this.summarizeMiddleBand(cleared);
      if (summary) {
        prompt = applySummary(cleared, summary);
      }
    }

    // Map capabilities to native tool schemas
    const tools: ToolDefinition[] = [];
    for (const cap of template.capabilities) {
      if (CAPABILITY_TOOL_DEFINITIONS[cap]) {
        tools.push(...CAPABILITY_TOOL_DEFINITIONS[cap]);
      }
    }

    const response = await this.gateway.chat(prompt, {
      modelRole: template.modelRole,
      temperature: 0.1,
      tools: tools.length > 0 ? tools : undefined,
      onReasoning: (reasoning) => {
        void this.bus.publish(`task.${state.taskId}.agent.${state.agentId}.thought`, {
          kind: "thought",
          from: state.agentId,
          content: reasoning,
        });
      },
    });

    const content = typeof response === "string" ? response : (response.content || "");
    const nativeToolCalls = typeof response === "object" ? response.toolCalls : undefined;

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content,
    };
    if (nativeToolCalls) {
      (assistantMsg as any).toolCalls = nativeToolCalls;
    }

    // Parse response for validation/completions
    let parsedResult: any = null;
    let parsedVerification: any = null;
    let hasToolCalls = (nativeToolCalls && nativeToolCalls.length > 0);
    let formatError: string | null = null;

    if (!hasToolCalls) {
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
          if (parsed.call) {
            hasToolCalls = true;
          } else if (parsed.result) {
            parsedResult = parsed.result;
          } else if (parsed.verification) {
            parsedVerification = parsed.verification;
          } else {
            formatError = "Your JSON block did not contain a valid 'call', 'result', or 'verification' field.";
          }
        } catch (e: any) {
          formatError = `Failed to parse your JSON response: ${e.message}`;
        }
      } else {
        formatError = "No valid JSON block found in your response. Please wrap your action/result in a JSON block inside markdown triple backticks.";
      }
    }

    // Prepare updates
    const messagesUpdate = [assistantMsg];
    let newStatus = state.status;
    let newResult = state.result;
    const newErrors = [...state.errors];

    if (parsedResult) {
      void this.bus.publish(`task.${state.taskId}.agent_message`, {
        kind: "result",
        from: state.agentId,
        taskId: state.taskId,
        artifacts: parsedResult.artifacts,
        summary: parsedResult.summary
      });
      newResult = parsedResult;
      newStatus = "completed";
    } else if (parsedVerification) {
      newResult = parsedVerification;
      newStatus = "completed";
    } else if (formatError && !hasToolCalls) {
      if (state.currentStep >= this.maxTurns) {
        newStatus = "failed";
        newErrors.push(`Agent inner-loop exceeded max turns of ${this.maxTurns} without yielding a result.`);
      } else {
        messagesUpdate.push({
          role: "user",
          content: formatError,
        });
      }
    }

    return {
      messages: messagesUpdate,
      currentStep: state.currentStep + 1,
      result: newResult,
      status: newStatus,
      errors: newErrors,
    };
  }

  private async executeTools(state: AgentStateType): Promise<Partial<AgentStateType>> {
    const lastMsg = state.messages[state.messages.length - 1];
    const nativeToolCalls = (lastMsg as any).toolCalls || [];
    let parsedToolCall: any = null;

    if (nativeToolCalls.length === 0) {
      const jsonMatch = lastMsg.content.match(/```json\s*([\s\S]*?)\s*```/) || lastMsg.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
          if (parsed.call) {
            parsedToolCall = parsed.call;
          }
        } catch {
          // ignore
        }
      }
    }

    const newMessages: ChatMessage[] = [];

    if (nativeToolCalls.length > 0) {
      for (const tc of nativeToolCalls) {
        const [capability, method] = tc.name.split(":");
        const toolCall: ToolCall = {
          id: tc.id || `call-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          capability: capability || tc.name,
          method: method || "",
          args: tc.args,
        };

        await this.bus.publish(`task.${state.taskId}.agent.${state.agentId}.tool_requested`, {
          kind: "thought",
          from: state.agentId,
          content: `Requesting execution of ${toolCall.capability}.${toolCall.method}`
        });

        try {
          const toolResult = await this.permissions.executeWithApproval(state.agentId, toolCall, async () => {
            const provider = this.scope.resolve<any>(`capability:${toolCall.capability}`);
            if (!provider || typeof provider[toolCall.method] !== "function") {
              throw new Error(`Provider for capability "${toolCall.capability}" does not support method "${toolCall.method}"`);
            }
            return provider[toolCall.method](...Object.values(toolCall.args));
          });

          newMessages.push({
            role: "user",
            content: `Tool Execution Result:\n\`\`\`json\n${JSON.stringify({ status: "success", data: toolResult }, null, 2)}\n\`\`\``
          });
        } catch (execErr: any) {
          newMessages.push({
            role: "user",
            content: `Tool Execution Error:\n\`\`\`json\n${JSON.stringify({ status: "error", error: execErr.message }, null, 2)}\n\`\`\``
          });
        }
      }
    } else if (parsedToolCall) {
      const toolCall: ToolCall = {
        id: parsedToolCall.id || `call-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        capability: parsedToolCall.capability,
        method: parsedToolCall.method,
        args: parsedToolCall.args,
      };
      await this.bus.publish(`task.${state.taskId}.agent.${state.agentId}.tool_requested`, {
        kind: "thought",
        from: state.agentId,
        content: `Requesting execution of ${toolCall.capability}.${toolCall.method}`
      });

      try {
        const toolResult = await this.permissions.executeWithApproval(state.agentId, toolCall, async () => {
          const provider = this.scope.resolve<any>(`capability:${toolCall.capability}`);
          if (!provider || typeof provider[toolCall.method] !== "function") {
            throw new Error(`Provider for capability "${toolCall.capability}" does not support method "${toolCall.method}"`);
          }
          return provider[toolCall.method](...Object.values(toolCall.args));
        });

        newMessages.push({
          role: "user",
          content: `Tool Execution Result:\n\`\`\`json\n${JSON.stringify({ status: "success", data: toolResult }, null, 2)}\n\`\`\``
        });
      } catch (execErr: any) {
        newMessages.push({
          role: "user",
          content: `Tool Execution Error:\n\`\`\`json\n${JSON.stringify({ status: "error", error: execErr.message }, null, 2)}\n\`\`\``
        });
      }
    }

    return {
      messages: newMessages,
    };
  }

  private shouldContinue(state: AgentStateType): "executeTools" | typeof END | "callModel" {
    if (state.status === "completed" || state.status === "failed") {
      return END;
    }

    const lastMsg = state.messages[state.messages.length - 1];
    const nativeToolCalls = (lastMsg as any).toolCalls || [];
    if (nativeToolCalls.length > 0) {
      return "executeTools";
    }

    const jsonMatch = lastMsg.content?.match(/```json\s*([\s\S]*?)\s*```/) || lastMsg.content?.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
        if (parsed.call) {
          return "executeTools";
        }
      } catch {
        // ignore
      }
    }

    return "callModel";
  }

  private async summarizeMiddleBand(cleared: ChatMessage[]): Promise<string | null> {
    const middle = middleBand(cleared);
    if (middle.length === 0) return null;

    const transcript = middle.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
    try {
      const summary = await this.gateway.chat(
        [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          {
            role: "user",
            content:
              "Summarize the following agent transcript into key decisions, tool " +
              `results, and current state:\n\n${transcript}`,
          },
        ],
        { modelRole: "utility", temperature: 0 },
      );
      const rawText = typeof summary === "string" ? summary : (summary?.content || "");
      const trimmed = rawText.trim();
      return trimmed ? trimmed : null;
    } catch {
      return null;
    }
  }
}
