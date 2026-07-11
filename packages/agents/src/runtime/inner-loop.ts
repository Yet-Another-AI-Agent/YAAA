import type { IMeshGateway, IBus, ChatMessage } from "@yaaa/interfaces";
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

/**
 * Once the tool-result-cleared prompt is over the summary threshold we roll the
 * middle band into an LLM summary. To avoid paying for a utility-model call on
 * every subsequent turn, we only *re*-summarize once the cleared prompt has
 * grown at least this many chars beyond the size it had at the last summary.
 */
const SUMMARY_REFRESH_CHARS = 12000;

/** System prompt for the cheap "utility" model that compresses the middle band. */
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
    const turns = options.maxTurns || this.maxTurns;

    // Grant scopes to permission engine for this execution
    this.permissions.grantScope(agentId, {
      capabilities: template.capabilities,
      allowedPaths: [process.cwd()], // Default to workspace directory
      riskCeiling: template.riskCeiling,
    });

    // `instruction` now carries a fully-formed mission brief (goal + subtask +
    // completed-dependency results) built by the outer loop via buildAgentBrief.
    // Any extra context artifacts are appended for backward compatibility with
    // callers that still pass them.
    const userParts = [instruction];
    if (contextArtifacts.length > 0) {
      userParts.push(`Context artifacts available:\n${contextArtifacts.join("\n")}`);
    }
    const messages: ChatMessage[] = [
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

    // Rolling summary of the older middle band. Kept across turns and only
    // refreshed once the conversation has grown appreciably (see
    // SUMMARY_REFRESH_CHARS) so we don't re-summarize on every turn.
    let summary: string | null = null;
    let lastSummaryChars = 0;

    for (let turn = 1; turn <= turns; turn++) {
      // An @mention in chat pauses this specific agent; block here (before
      // the next model turn) until the sub-thread conversation resumes it.
      await pauseController.waitIfPaused(agentId);

      // Two-tier compaction of the prompt (the full `messages` array is kept
      // locally). Tier 1: tool-result clearing — cheap, pure, no LLM call.
      const cleared = compactMessages(messages);
      // Tier 2: if the cleared prompt is still too large, collapse the middle
      // band into a single LLM-produced summary note. Resilient: on any failure
      // summarizeMiddleBand returns null and we fall back to `cleared`.
      let prompt: ChatMessage[] = cleared;
      if (needsSummary(cleared)) {
        const clearedChars = estimateChars(cleared);
        if (summary === null || clearedChars - lastSummaryChars > SUMMARY_REFRESH_CHARS) {
          const fresh = await this.summarizeMiddleBand(cleared);
          if (fresh) {
            summary = fresh;
            lastSummaryChars = clearedChars;
          }
        }
        if (summary) prompt = applySummary(cleared, summary);
      }

      // Get next action from model. Reasoning tokens (when the model exposes
      // them) are streamed to the UI as "thinking"; the raw JSON answer is kept
      // out of the thinking stream and parsed for the actual tool call/result.
      const response = await this.gateway.chat(prompt, {
        modelRole: template.modelRole,
        temperature: 0.1,
        onReasoning: (reasoning) => {
          void this.bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
            kind: "thought",
            from: agentId,
            content: reasoning,
          });
        },
      });

      messages.push({ role: "assistant", content: response });

      // Parse JSON tool call or final result from model output
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);

          if (parsed.call) {
            const toolCall = parsed.call as ToolCall;
            // Execute tool
            await this.bus.publish(`task.${taskId}.agent.${agentId}.tool_requested`, {
              kind: "thought",
              from: agentId,
              content: `Requesting execution of ${toolCall.capability}.${toolCall.method}`
            });

            let toolResult: any;
            try {
              toolResult = await this.permissions.executeWithApproval(agentId, toolCall, async () => {
                const provider = this.scope.resolve<any>(`capability:${toolCall.capability}`);
                if (!provider || typeof provider[toolCall.method] !== "function") {
                  throw new Error(`Provider for capability "${toolCall.capability}" does not support method "${toolCall.method}"`);
                }
                return provider[toolCall.method](...Object.values(toolCall.args));
              });

              messages.push({
                role: "user",
                content: `Tool Execution Result:\n\`\`\`json\n${JSON.stringify({ status: "success", data: toolResult }, null, 2)}\n\`\`\``
              });
            } catch (execErr: any) {
              messages.push({
                role: "user",
                content: `Tool Execution Error:\n\`\`\`json\n${JSON.stringify({ status: "error", error: execErr.message }, null, 2)}\n\`\`\``
              });
            }
            continue; // Continue to next turn to observe tool result
          }

          if (parsed.result) {
            // Task completed successfully
            await this.bus.publish(`task.${taskId}.agent_message`, {
              kind: "result",
              from: agentId,
              taskId,
              artifacts: parsed.result.artifacts,
              summary: parsed.result.summary
            });
            return parsed.result;
          }

          if (parsed.verification) {
            // For VerifierAgent
            return parsed.verification;
          }
        } catch (err: any) {
          // JSON parse failed or invalid model output format
          messages.push({
            role: "user",
            content: `Error parsing your response. Please ensure you output valid JSON containing either "call" or "result". Error: ${err.message}`
          });
        }
      } else {
        messages.push({
          role: "user",
          content: "No valid JSON block found in your response. Please wrap your action/result in a JSON block inside markdown triple backticks."
        });
      }
    }

    throw new Error(`Agent inner-loop exceeded max turns of ${turns} without yielding a result.`);
  }

  /**
   * Compress the middle band of a (tool-result-cleared) prompt into a short note
   * via the cheap `utility` model. Never throws: on any error — or an empty
   * middle band / empty model reply — it returns null so the caller falls back
   * to the tool-result-cleared array and the agent loop keeps running.
   *
   * Deliberately does not pass `onReasoning`; this is a side utility call and
   * must not pollute the main turn's "thinking" stream.
   */
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
      const trimmed = summary?.trim();
      return trimmed ? trimmed : null;
    } catch {
      return null;
    }
  }
}
