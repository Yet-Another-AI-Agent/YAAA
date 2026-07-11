import type { IMeshGateway, IBus, ChatMessage } from "@yaaa/interfaces";
import { container, type Container } from "@yaaa/platform";
import { TaskPlanSchema, type TaskPlan } from "@yaaa/shared";

/** Optional context threaded into planning so the planner is not memoryless. */
export interface PlanContext {
  userProfile?: { name?: string; profession?: string; description?: string };
  /** Condensed summary of earlier turns/work on this mission (for follow-ups). */
  priorSummary?: string;
}

/** Render the plan-context preamble prepended to the planning request. */
export function renderPlanContext(context?: PlanContext): string {
  if (!context) return "";
  const parts: string[] = [];
  const p = context.userProfile;
  if (p && (p.name || p.profession || p.description)) {
    const bits = [
      p.name ? `Name: ${p.name}` : "",
      p.profession ? `Profession: ${p.profession}` : "",
      p.description ? `About: ${p.description}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    parts.push(`About the user — ${bits}.`);
  }
  if (context.priorSummary?.trim()) {
    parts.push(`Context from earlier in this mission:\n${context.priorSummary.trim()}`);
  }
  return parts.length ? `${parts.join("\n\n")}\n\n` : "";
}

export class Planner {
  private gateway: IMeshGateway;
  private bus: IBus;

  constructor(scope: Container = container) {
    this.gateway = scope.resolve<IMeshGateway>("IMeshGateway");
    this.bus = scope.resolve<IBus>("IBus");
  }

  async plan(goal: string, taskId?: string, context?: PlanContext): Promise<TaskPlan> {
    // Surface the orchestrator's reasoning tokens as "thinking" for the UI.
    const onReasoning = taskId
      ? (reasoning: string) => {
          void this.bus.publish(`task.${taskId}.agent.planner.thought`, {
            kind: "thought",
            from: "planner",
            content: reasoning,
          });
        }
      : undefined;

    const systemPrompt = `You are a central Task Planner for YAAA.
Your job is to break down a user's task into a sequential, structured list of subtasks.
Each subtask represents a step in a task graph and must declare its capabilities, dependencies, riskLevel, and success criteria.

Available capabilities:
- "files": file read, write, search.
- "verify": validation pass.

Risk levels:
- "low": auto-run
- "medium": auto-run for most file ops, confirm for shell/dangerous commands
- "high": always requires explicit confirmation

You MUST return a JSON object that strictly adheres to this structure:
{
  "goal": "The overall goal",
  "subtasks": [
    {
      "id": "subtask-1",
      "title": "Create a detailed study on...",
      "capability": "files",
      "dependsOn": [],
      "riskLevel": "low",
      "successCriteria": "A text file battery_facts.txt exists with information."
    },
    {
      "id": "subtask-2",
      "title": "Verify study contents and formatting",
      "capability": "verify",
      "dependsOn": ["subtask-1"],
      "riskLevel": "low",
      "successCriteria": "Verification status reports success."
    }
  ]
}

DO NOT output any conversational text before or after the JSON. Only return a valid JSON block inside markdown triple backticks (\`\`\`json ... \`\`\`).`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `${renderPlanContext(context)}Create a task plan for this goal: "${goal}"` }
    ];

    let response = await this.gateway.chat(messages, {
      modelRole: "planner",
      temperature: 0.1,
      onReasoning,
    });

    try {
      return this.parseAndValidate(response);
    } catch (err: any) {
      console.warn("First planning attempt failed validation. Retrying with error details...", err.message);
      
      // Retry once with error feedback
      messages.push({ role: "assistant" as const, content: response });
      messages.push({
        role: "user" as const,
        content: `Your previous JSON output was invalid or failed validation. Error: ${err.message}. Please fix it and output the correct JSON block.`
      });

      response = await this.gateway.chat(messages, {
        modelRole: "planner",
        temperature: 0.1,
        onReasoning,
      });

      return this.parseAndValidate(response);
    }
  }

  private parseAndValidate(output: string): TaskPlan {
    const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/) || output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON code block found in model output.");
    }
    const rawJson = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    return TaskPlanSchema.parse(rawJson);
  }
}
