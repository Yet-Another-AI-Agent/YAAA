import type { IMeshGateway, IBus, ChatMessage } from "@yaaa/interfaces";
import { container, type Container } from "@yaaa/platform";
import { TaskPlanSchema, type TaskPlan } from "@yaaa/shared";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readArchitectureDoc(): string {
  const paths = [
    path.resolve(__dirname, "../../../docs/architecture.md"),
    path.resolve(__dirname, "../../docs/architecture.md"),
    path.resolve(process.cwd(), "docs/architecture.md"),
    path.resolve(process.cwd(), "../docs/architecture.md"),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      try {
        return fs.readFileSync(p, "utf8");
      } catch (err) {
        // ignore
      }
    }
  }
  return "";
}

const archDoc = readArchitectureDoc();
const ARCH_INSTRUCTION = archDoc
  ? `\n\nHere is the system architecture of the application we are running within:\n\n${archDoc}`
  : "";

/** Optional context threaded into planning so the planner is not memoryless. */
export interface PlanContext {
  userProfile?: { name?: string; profession?: string; description?: string };
  /** Condensed summary of earlier turns/work on this mission (for follow-ups). */
  priorSummary?: string;
}

/**
 * Model tiers used across planning and fallback routing — the single source of
 * truth so a subtask's *default* model matches the rubric the planner prompt
 * advertises. These are Mesh model ids; the planner can still override any
 * subtask with an explicit `model`.
 */
export const MODEL_TIERS = {
  simple: "google/gemini-2.5-flash",
  medium: "google/gemini-2.5-flash",
  complex: "google/gemini-2.5-pro",
} as const;

/** Agent templates whose work is engineering-heavy enough to warrant the top tier. */
const COMPLEX_AGENT_TEMPLATES = new Set([
  "PrincipalSweAgent",
  "UiArchitectAgent",
  "GraphicsEngineerAgent",
]);

/**
 * Tier-aware default model for a subtask, used only when the planner did not
 * assign an explicit `model`. Replaces the previous blanket gemini-flash
 * fallback that collapsed nearly every subtask onto one mid-tier model.
 */
export function defaultModelForSubtask(subtask: {
  capability: string;
  riskLevel?: string;
  agentTemplate?: string;
}): string {
  // High-stakes or engineering-heavy work gets the strongest tier.
  if (subtask.riskLevel === "high") return MODEL_TIERS.complex;
  if (subtask.agentTemplate && COMPLEX_AGENT_TEMPLATES.has(subtask.agentTemplate)) {
    return MODEL_TIERS.complex;
  }
  // Simple, well-bounded file ops and verification go to the cheapest tier.
  if (subtask.capability === "verify" || subtask.capability === "files") {
    return MODEL_TIERS.simple;
  }
  // Everything else (docs, browser, integration, shell content work) is mid-tier.
  return MODEL_TIERS.medium;
}

/** Explain the cost/capability tradeoff behind the model shown at agent creation. */
export function defaultModelReasonForSubtask(subtask: {
  capability: string;
  riskLevel?: string;
  agentTemplate?: string;
}, model: string): string {
  if (model === MODEL_TIERS.simple) {
    return `Gemini Flash is the cost-efficient default for bounded ${subtask.capability} work and verification.`;
  }
  if (model === MODEL_TIERS.complex) {
    return "Gemini Pro is reserved for high-risk or engineering-heavy work that benefits from stronger reasoning.";
  }
  return `Gemini Flash is a balanced choice for ${subtask.capability} work without a high-risk or specialist constraint.`;
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

/**
 * The static rubric, used only when Mesh's live catalog cannot be read. It names
 * models that may not exist on the account, which is exactly why the live menu
 * is preferred: a hardcoded list is why every plan picked the same model.
 */
const FALLBACK_MODEL_RUBRIC = `- "${MODEL_TIERS.simple}" (cheapest) — simple file operations, QA/verification, unit testing, and other well-bounded low-risk steps. This is the correct default for FilesAgent/QaTesterAgent/verify work.
- "${MODEL_TIERS.complex}" (strongest, default) — web research, browser/search, document/PPT/content generation, complex coding, software architecture, hard debugging, high-stakes decisions.
- "${MODEL_TIERS.medium}" (mid, cost-aware) — only for simple non-critical tasks or when specifically requested.`;

/**
 * Supplies the live model menu as prompt-ready lines. The runtime owns the
 * catalog (and the cycle rules keep this package from importing it), so the
 * planner takes the rendered menu rather than the catalog itself.
 */
export type ModelMenuProvider = () => Promise<string>;

export class Planner {
  private gateway: IMeshGateway;
  private bus: IBus;
  private modelMenuProvider?: ModelMenuProvider;

  constructor(scope: Container = container) {
    this.gateway = scope.resolve<IMeshGateway>("IMeshGateway");
    this.bus = scope.resolve<IBus>("IBus");
    try {
      this.modelMenuProvider = scope.resolve<ModelMenuProvider>("modelMenuProvider");
    } catch {
      // Tests and alternate runtimes may not expose Mesh's catalog.
    }
  }

  /**
   * The model rubric handed to the planner: Mesh's live, tool-capable lineup
   * when it can be read, so a newly released model is selectable the day the
   * account gets it, and the static tier list otherwise.
   */
  private async renderModelRubric(): Promise<string> {
    if (!this.modelMenuProvider) return FALLBACK_MODEL_RUBRIC;
    try {
      const menu = (await this.modelMenuProvider()).trim();
      if (!menu) return FALLBACK_MODEL_RUBRIC;
      return `${menu}\n\nPick from that list by price and difficulty: the cheapest adequate model for well-bounded, low-risk steps (simple file operations, QA/verification, unit tests), and a stronger, pricier one only for work that earns it (web research, document/PPT generation, complex coding, architecture, hard debugging, high-stakes decisions).`;
    } catch {
      return FALLBACK_MODEL_RUBRIC;
    }
  }

  async plan(goal: string, taskId?: string, context?: PlanContext): Promise<TaskPlan> {
    const requestedAgentCount = getRequestedAgentCount(goal);
    const modelRubric = await this.renderModelRubric();
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
You must also choose the best agentTemplate from the allowed roster and explain that choice in routingReason. Explain the model choice in modelReason using one concise sentence focused on capability and cost.
You MUST assign every subtask an explicit 'model', chosen from the models this account can actually reach right now:
${modelRubric}
Make this semantic decision from the complete subtask, not by matching isolated keywords. Do not default every subtask to the same model: match each one to the difficulty of its own work so the plan stays cost-aware. Use a model id exactly as written above.

Execution contract:
- Every subtask is executed by a newly spawned agent. Therefore the number of subtasks is the number of agents that will be spawned. Keep the number of subtasks to an absolute minimum.
- Spawning multiple agents is ONLY for complex multi-role codebase work (e.g. one implementing code and one verifying, or different domains).
- If a goal is a single research task, report generation, or simple script, assign it to a SINGLE agent with a single subtask. That agent can do multiple searches, read/write multiple files, and produce the final output. Do NOT split research, outlines, and drafting into separate sequential subtasks. One agent can handle the entire research and drafting flow.
- A typical task should have 1 to 2 subtasks. Never exceed 3 subtasks unless the user explicitly requested a higher number of agents or the task involves a genuine multi-role codebase implementation.
- If the user explicitly requests an exact number of agents, return exactly that many subtasks. Bundle requirements, implementation, revisions, and verification work into those agents' assignments rather than creating extra workflow-step subtasks.
- Preserve the requested role split in subtask titles and use dependencies to express handoffs between those agents.
${requestedAgentCount ? `- This user explicitly requested exactly ${requestedAgentCount} agents, so this plan MUST contain exactly ${requestedAgentCount} subtasks.` : ""}

Available capabilities:
- "files", "browser", "shell", "integration", "docs", and "verify".

Allowed agentTemplate values:
- FilesAgent: general file and document work
- DocumentAgent: reports, Markdown documents, PowerPoint/PPTX, slide outlines, speaker notes, spreadsheets, and non-code content artifacts
- PrincipalSweAgent: backend and complex software engineering
- UiArchitectAgent: frontend and interface engineering
- GraphicsEngineerAgent: graphics, geometry, WebGL, and rendering
- ResearcherAgent: web research and analysis
- AdStrategistAgent: advertising and campaign strategy
- DesignerAgent: visual and brand design
- DevOpsAgent: infrastructure, deployment, and operational work
- QaTesterAgent: functional and automated verification
- CvTesterAgent: visual, screenshot, and GUI verification

Routing constraints:
- Use DocumentAgent for docs/PPT/report/spreadsheet/content-artifact creation. Do NOT use PrincipalSweAgent for document or presentation generation unless the user explicitly asks for software engineering.
- For PowerPoint/PPTX requests, plan for a real .pptx artifact generated with pptxgenjs. For multi-slide decks, split slide research/content into separate docs/browser subtasks when useful, then add a final DocumentAgent subtask that stitches the final deck with pptxgenjs and speaker notes.
- When the goal asks for images, illustrations, diagrams, or a visual deck, the assigned agent HAS a native generate_image tool that produces real PNG files. Make image generation an explicit part of the relevant subtask's success criteria (e.g. "each slide embeds a generated image"), and route visual-asset work to DocumentAgent, DesignerAgent, or GraphicsEngineerAgent. Do not plan a deliverable that only describes images in text when actual images were requested.
- Use QaTesterAgent only for verification. It must inspect artifacts and run checks; it must not create the primary deliverable or write implementation code.
- Use PrincipalSweAgent only for actual software engineering tasks.

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
      "model": "google/gemini-2.5-flash"
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
      "modelReason": "Gemini Flash is the cost-efficient fit for bounded verification.",
      "model": "google/gemini-2.5-flash"
    }
  ]
}

DO NOT output any conversational text before or after the JSON. Only return a valid JSON block inside markdown triple backticks (\`\`\`json ... \`\`\`).${ARCH_INSTRUCTION}`;

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
        // Tier the default by the subtask's shape instead of defaulting almost
        // everything to mid-tier flash. Simple file/verify work → cheapest tier,
        // engineering/high-risk work → strongest tier, the rest → mid-tier.
        subtask.model = defaultModelForSubtask(subtask);
      }
      if (!subtask.modelReason) {
        subtask.modelReason = defaultModelReasonForSubtask(subtask, subtask.model);
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
