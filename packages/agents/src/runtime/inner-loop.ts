import type { IMeshGateway, IBus, ChatMessage } from "@yaaa/interfaces";
import { container, PermissionEngine, pauseController } from "@yaaa/platform";
import type { AgentMessage, ToolCall } from "@yaaa/shared";
import { AGENT_REGISTRY, type AgentTemplate } from "../registry.js";

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
  private maxTurns: number;

  constructor() {
    this.gateway = container.resolve<IMeshGateway>("IMeshGateway");
    this.bus = container.resolve<IBus>("IBus");
    this.permissions = container.resolve<PermissionEngine>("PermissionEngine");
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

    const messages: ChatMessage[] = [
      { role: "system", content: template.systemPrompt },
      { role: "user", content: `Your subtask is: "${instruction}".\nContext artifacts available:\n${contextArtifacts.join("\n")}\nBegin working and call tools as needed.` }
    ];

    await this.bus.publish(`task.${taskId}.agent.${agentId}.started`, {
      kind: "status",
      from: agentId,
      taskId,
      state: "working",
      note: `Spawned ${options.templateName} to execute subtask.`
    });

    for (let turn = 1; turn <= turns; turn++) {
      // An @mention in chat pauses this specific agent; block here (before
      // the next model turn) until the sub-thread conversation resumes it.
      await pauseController.waitIfPaused(agentId);
      // Get next action from model. Reasoning tokens (when the model exposes
      // them) are streamed to the UI as "thinking"; the raw JSON answer is kept
      // out of the thinking stream and parsed for the actual tool call/result.
      const response = await this.gateway.chat(messages, {
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
                const provider = container.resolve<any>(`capability:${toolCall.capability}`);
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
}
