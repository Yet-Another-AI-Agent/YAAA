import type { IMeshGateway, IBus, ChatMessage } from "@yaaa/interfaces";
import { container, type Container } from "@yaaa/platform";
import { TaskPlanSchema, type TaskPlan } from "@yaaa/shared";

/** Optional context threaded into planning so the planner is not memoryless. */
export interface PlanContext {
  userProfile?: { name?: string; profession?: string; description?: string };
  /** Condensed summary of earlier turns/work on this mission (for follow-ups). */
  priorSummary?: string;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/** Return an explicit user-requested agent count, if the goal contains one. */
export function getRequestedAgentCount(goal: string): number | null {
  const match = goal.match(
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:collaborating\s+|specialized\s+)?agents?\b/i,
  );
  if (!match) return null;
  const token = match[1].toLowerCase();
  const count = NUMBER_WORDS[token] ?? Number.parseInt(token, 10);
  return Number.isInteger(count) && count > 0 && count <= 300 ? count : null;
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
    const requestedAgentCount = getRequestedAgentCount(goal);
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
You must also choose the best agentTemplate from the allowed roster and explain that choice in routingReason.
Choose the best fit model for the subtask and assign it to the 'model' property:
- Use "anthropic/claude-sonnet-5" for coding, complex software/architectural decisions, layout designs, and PPT creation.
- Use "google/gemini-3.5-flash" or "google/gemini-2.5-pro" for web research, image generation, and general text tasks.
- Use "anthropic/claude-haiku-4.5" for simple file operations, QA verification, or unit testing.
Make this semantic decision from the complete subtask, not by matching isolated keywords.

Execution contract:
- Every subtask is executed by a newly spawned agent. Therefore the number of subtasks is the number of agents that will be spawned.
- If the user explicitly requests an exact number of agents, return exactly that many subtasks. Bundle requirements, implementation, revisions, and verification work into those agents' assignments rather than creating extra workflow-step subtasks.
- Preserve the requested role split in subtask titles and use dependencies to express handoffs between those agents.
${requestedAgentCount ? `- This user explicitly requested exactly ${requestedAgentCount} agents, so this plan MUST contain exactly ${requestedAgentCount} subtasks.` : ""}

Available capabilities:
- "files", "browser", "shell", "integration", "docs", and "verify".

Allowed agentTemplate values:
- FilesAgent: general file and document work
- PrincipalSweAgent: backend and complex software engineering
- UiArchitectAgent: frontend and interface engineering
- GraphicsEngineerAgent: graphics, geometry, WebGL, and rendering
- ResearcherAgent: web research and analysis
- AdStrategistAgent: advertising and campaign strategy
- DesignerAgent: visual and brand design
- DevOpsAgent: infrastructure, deployment, and operational work
- QaTesterAgent: functional and automated verification
- CvTesterAgent: visual, screenshot, and GUI verification

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
      "successCriteria": "A text file battery_facts.txt exists with information.",
      "agentTemplate": "ResearcherAgent",
      "routingReason": "The subtask requires gathering and validating factual information.",
      "model": "google/gemini-3.5-flash"
    },
    {
      "id": "subtask-2",
      "title": "Verify study contents and formatting",
      "capability": "verify",
      "dependsOn": ["subtask-1"],
      "riskLevel": "low",
      "successCriteria": "Verification status reports success.",
      "agentTemplate": "QaTesterAgent",
      "routingReason": "Independent functional verification is required.",
      "model": "anthropic/claude-haiku-4.5"
    }
  ]
}

DO NOT output any conversational text before or after the JSON. Only return a valid JSON block inside markdown triple backticks (\`\`\`json ... \`\`\`).`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `${renderPlanContext(context)}Create a task plan for this goal: "${goal}"` }
    ];

    const firstRes = await this.gateway.chat(messages, {
      modelRole: "planner",
      temperature: 0.1,
      onReasoning,
    });
    let response = firstRes.content;

    try {
      return this.parseAndValidate(response, requestedAgentCount);
    } catch (err: any) {
      console.warn("First planning attempt failed validation. Retrying with error details...", err.message);
      
      // Retry once with error feedback
      messages.push({ role: "assistant" as const, content: response });
      messages.push({
        role: "user" as const,
        content: `Your previous JSON output was invalid or failed validation. Error: ${err.message}. Please fix it and output the correct JSON block.`
      });

      const retryRes = await this.gateway.chat(messages, {
        modelRole: "planner",
        temperature: 0.1,
        onReasoning,
      });
      response = retryRes.content;

      return this.parseAndValidate(response, requestedAgentCount);
    }
  }

  private parseAndValidate(output: string, requestedAgentCount: number | null): TaskPlan {
    const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/) || output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON code block found in model output.");
    }
    const rawJson = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    const plan = TaskPlanSchema.parse(rawJson);
    for (const subtask of plan.subtasks) {
      if (!subtask.agentTemplate || !subtask.routingReason) {
        throw new Error(`Subtask ${subtask.id} is missing the required AI routing decision (agentTemplate and routingReason).`);
      }
      if (!subtask.model) {
        if (subtask.capability === "verify") {
          subtask.model = "anthropic/claude-haiku-4.5";
        } else if (subtask.capability === "browser" || subtask.capability === "docs") {
          subtask.model = "google/gemini-3.5-flash";
        } else {
          subtask.model = "anthropic/claude-sonnet-5";
        }
      }
    }
    if (
      requestedAgentCount !== null &&
      plan.subtasks.length !== requestedAgentCount
    ) {
      throw new Error(
        `The user requested exactly ${requestedAgentCount} agents, but the plan contains ${plan.subtasks.length} subtasks. Each subtask spawns one agent, so return exactly ${requestedAgentCount} subtasks.`,
      );
    }
    return plan;
  }
}
