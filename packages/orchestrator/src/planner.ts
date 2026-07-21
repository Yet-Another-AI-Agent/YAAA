import type { IMeshGateway, IBus, ChatMessage } from "@yaaa/interfaces";
import { container, type Container } from "@yaaa/platform";
import { TaskPlanSchema, type TaskPlan, type PlanExecutionStage, type ModelPreference, type VerificationPlan, type PlanningAnalysis, type PlanningRoleAssessment } from "@yaaa/shared";
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
  modelPreference?: ModelPreference;
  /** Explicit user correction being replanned, kept separate from prior history. */
  correctionGoal?: string;
}

/**
 * Model tiers used across planning and fallback routing — the single source of
 * truth so a subtask's *default* model matches the rubric the planner prompt
 * advertises. These are Mesh model ids; the planner can still override any
 * subtask with an explicit `model`.
 */
export const MODEL_TIERS = {
  simple: "google/gemini-2.5-pro-preview",
  medium: "google/gemini-3.1-pro-preview",
  complex: "anthropic/claude-sonnet-4.5",
} as const;

/** Policy-level defaults used when the model advisor omits a model. */
export const PREFERENCE_MODEL_DEFAULTS: Record<ModelPreference, string> = {
  sota: "anthropic/claude-sonnet-4.5",
  // Mesh exposes Gemini 3 Flash with the preview suffix. The unsuffixed id
  // returns 404 from Mesh and must never be emitted as a planner fallback.
  balanced: "google/gemini-3.1-pro-preview",
  "cost-effective": "google/gemini-2.5-pro-preview",
};

const PLANNER_CAPABILITIES = new Set([
  "docs",
  "browser",
  "shell",
  "files",
  "integration",
  "verify",
]);

/**
 * A subtask has one execution capability because that value selects its
 * permission scope. Older/planner-model responses sometimes emit a comma-
 * separated list instead. Preserve the plan while choosing the capability
 * that best matches the routed agent template.
 */
function normalizePlannerCapability(value: unknown, agentTemplate?: string): unknown {
  const candidates = (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map((candidate) => String(candidate).trim().toLowerCase())
    .filter(Boolean);
  if (candidates.length <= 1) return value;

  const preferredByTemplate: Record<string, string> = {
    FilesAgent: "files",
    ResearcherAgent: "browser",
    QaTesterAgent: "verify",
    CvTesterAgent: "verify",
    DocumentAgent: "docs",
    DesignerAgent: "docs",
    DevOpsAgent: "shell",
  };
  const preferred = agentTemplate ? preferredByTemplate[agentTemplate] : undefined;
  return preferred && candidates.includes(preferred)
    ? preferred
    : candidates.find((candidate) => PLANNER_CAPABILITIES.has(candidate)) ?? value;
}

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
}, preference: ModelPreference = "balanced"): string {
  if (preference === "sota" || preference === "cost-effective") return PREFERENCE_MODEL_DEFAULTS[preference];
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
}, model: string, preference: ModelPreference = "balanced"): string {
  if (preference === "sota") {
    return `The SOTA setting selects the strongest reachable model for ${subtask.capability} work to maximize performance and reasoning quality.`;
  }
  if (preference === "cost-effective") {
    return `The Cost Effective setting selects the lowest-cost adequate model for ${subtask.capability} work; the assignment remains bounded by the step's success criteria.`;
  }
  if (model === MODEL_TIERS.simple) {
    return `Gemini 2.5 Pro is the base model for bounded ${subtask.capability} work and verification.`;
  }
  if (model === MODEL_TIERS.complex) {
    return "Claude Opus 5 is reserved for high-risk or engineering-heavy work that benefits from the strongest available reasoning.";
  }
  return `Gemini 3.1 Pro is the medium-tier choice for ${subtask.capability} work.`;
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
  if (context.modelPreference) {
    parts.push(`Model policy: ${context.modelPreference}. Apply this policy to every planned sub-agent.`);
  }
  if (context.correctionGoal?.trim()) {
    parts.push(`Correction that must become the new detailed implementation goal:\n${context.correctionGoal.trim()}`);
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
Your job is to create a detailed implementation methodology and a dependency-aware execution graph.
Planning is a decision process that must be made explicit in the returned JSON. First write the detailed implementation goal: what must be built, changed, corrected, or verified, including the observable outcome. Then decompose it by answering: how many logically independent, executable steps exist; what does each step produce; and which previous steps must it depend on? Do not split work merely to create agents.
For every step, evaluate every allowed agent role in the roster below. Mark whether each role is relevant and explain why briefly. Select exactly one role only when it logically fits the step, state the expectation for that role, and keep irrelevant roles marked false. Then choose the best reachable model for the selected role under the current model policy and explain why that model is the right quality/cost fit.
The plan must explain the concrete approach, the number of substeps, which stages are sequential versus parallel, and the agent role/model required for every substep.
Verification is a first-class part of the plan. Add a verification plan with explicit artifact, automated, visual, and/or research checks as appropriate. For each check, state the exact capability/tool required, whether that capability is available to the assigned agent, what the check can prove, and its limitation. If a visual screenshot check is possible, require it; if it is not possible, require the verifier to research or describe the strongest effective fallback and report the unproven claim as a bug/limitation to YAAA.
Each subtask represents a step in a task graph and must declare exactly one primary 'capability', dependencies, riskLevel, and success criteria. The capability is singular because it selects the agent's permission scope. If a step involves files plus shell/browser work, choose the dominant primary capability and describe the additional work in the title and success criteria; never output a comma-separated capability list or array.
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
- Never omit verification because the agent count is constrained: bundle the verification method and its evidence/limitations into the relevant assignment when a separate verifier cannot be added.
- Preserve the requested role split in subtask titles and use dependencies to express handoffs between those agents.
${requestedAgentCount ? `- This user explicitly requested exactly ${requestedAgentCount} agents, so this plan MUST contain exactly ${requestedAgentCount} subtasks.` : ""}

Available capabilities (choose exactly one string per subtask):
- "files", "browser", "shell", "integration", "docs", and "verify".

Allowed agentTemplate values:
- FilesAgent: general file and document work
- VerifierAgent: read-only independent artifact/evidence verification
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
- Use VerifierAgent for read-only independent artifact/evidence verification.
- Use QaTesterAgent for functional or automated testing. It must inspect artifacts and run checks; it must not create the primary deliverable or write implementation code.
- Use CvTesterAgent for visual, screenshot, and GUI testing. It must not create the primary deliverable or write implementation code.
- Use PrincipalSweAgent only for actual software engineering tasks.

Risk levels:
- "low": auto-run
- "medium": auto-run for most file ops, confirm for shell/dangerous commands
- "high": always requires explicit confirmation

You MUST return a JSON object that strictly adheres to this structure:
{
  "goal": "The overall goal",
  "planningAnalysis": {
    "implementationGoal": "Detailed, observable implementation goal",
    "decompositionRationale": "Why these independent steps and dependencies are logically necessary",
    "modelPolicy": "How the current settings policy affected model choices",
    "stepReviews": [{
      "subtaskId": "subtask-1",
      "independentExecution": true,
      "dependencyReason": "No dependency because...",
      "consideredRoles": [{"agentTemplate":"ResearcherAgent","relevant":true,"rationale":"..."},{"agentTemplate":"DocumentAgent","relevant":false,"rationale":"..."}],
      "selectedRole": "ResearcherAgent",
      "roleExpectation": "What this role must deliver",
      "selectedModel": "${MODEL_TIERS.medium}",
      "modelReason": "Why this model fits this role and step under the current settings"
    }]
  },
  "methodology": "Detailed implementation methodology covering discovery, decisions, execution, verification, and how evidence changes the next step.",
  "executionGraph": [
    {"stage": 1, "mode": "parallel", "subtaskIds": ["subtask-1", "subtask-2"], "rationale": "These steps are independent."}
  ],
  "verification": {
    "required": true,
    "strategy": "Inspect artifacts, run safe automated checks, and use visual screenshots when possible.",
    "stages": [{"id":"visual-check","kind":"visual","targetSubtaskIds":["subtask-1"],"capability":"browser","method":"Capture and inspect the rendered result.","available":true,"limitation":"Browser checks do not prove timers or performance windows.","fallback":"Report the unproven claim to YAAA."}],
    "toolLimitations": ["File inspection is not rendered visual proof."],
    "decisionPolicy": "Verification findings are bugs addressed to YAAA; YAAA decides correction and reverification."
  },
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
      "model": "${MODEL_TIERS.simple}"
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
      "model": "${MODEL_TIERS.simple}"
    }
  ]
}

DO NOT output any conversational text before or after the JSON. Only return a valid JSON block inside markdown triple backticks (\`\`\`json ... \`\`\`).${ARCH_INSTRUCTION}`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `${renderPlanContext(context)}Create a task plan for this goal: "${goal}"` }
    ];

    const finalize = (raw: string): TaskPlan => {
      const plan = this.parseAndValidate(raw, requestedAgentCount, context?.modelPreference ?? "balanced");
      if (context?.correctionGoal?.trim() && plan.planningAnalysis) {
        plan.planningAnalysis.implementationGoal = [
          `Corrective implementation goal: ${context.correctionGoal.trim()}`,
          plan.planningAnalysis.implementationGoal,
        ].filter(Boolean).join("\n\n");
      }
      return plan;
    };

    const firstRes = await this.gateway.chat(messages, {
      modelRole: "planner",
      temperature: 0.1,
      onReasoning,
    });
    let response = firstRes.content;

    try {
      return finalize(response);
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

      return finalize(response);
    }
  }

  private parseAndValidate(output: string, requestedAgentCount: number | null, modelPreference: ModelPreference = "balanced"): TaskPlan {
    const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/) || output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON code block found in model output.");
    }
    const rawJson = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    if (rawJson && Array.isArray(rawJson.subtasks)) {
      for (const subtask of rawJson.subtasks) {
        subtask.capability = normalizePlannerCapability(subtask.capability, subtask.agentTemplate);
      }
    }
    const plan = TaskPlanSchema.parse(rawJson);
    for (const subtask of plan.subtasks) {
      if (!subtask.agentTemplate || !subtask.routingReason) {
        throw new Error(`Subtask ${subtask.id} is missing the required AI routing decision (agentTemplate and routingReason).`);
      }
      if (!subtask.model) {
        // Tier the default by the subtask's shape instead of defaulting almost
        // everything to mid-tier flash. Simple file/verify work → cheapest tier,
        // engineering/high-risk work → strongest tier, the rest → mid-tier.
        subtask.model = defaultModelForSubtask(subtask, modelPreference);
      }
      if (!subtask.modelReason) {
        subtask.modelReason = defaultModelReasonForSubtask(subtask, subtask.model, modelPreference);
      }
    }
    if (!plan.methodology?.trim()) plan.methodology = buildFallbackMethodology(plan);
    if (!plan.executionGraph?.length) plan.executionGraph = deriveExecutionGraph(plan);
    plan.planningAnalysis = normalizePlanningAnalysis(plan, plan.planningAnalysis, modelPreference);
    plan.verification = normalizeVerificationPlan(plan, plan.verification);
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

const ALL_AGENT_TEMPLATES = [
  "FilesAgent", "VerifierAgent", "PrincipalSweAgent", "UiArchitectAgent",
  "GraphicsEngineerAgent", "ResearcherAgent", "AdStrategistAgent", "DesignerAgent",
  "DocumentAgent", "DevOpsAgent", "QaTesterAgent", "CvTesterAgent",
];

function buildFallbackPlanningAnalysis(plan: TaskPlan, modelPreference: ModelPreference): PlanningAnalysis {
  return {
    implementationGoal: plan.goal,
    decompositionRationale: "YAAA derived the smallest dependency-aware graph from the available subtasks. Steps with no dependencies may run independently; dependent steps wait for their listed predecessors.",
    modelPolicy: `Current settings policy: ${modelPreference}. Each selected model is the best reachable quality/cost fit for its step and role under this policy.`,
    stepReviews: plan.subtasks.map((subtask) => {
      const selectedRole = subtask.agentTemplate ?? "FilesAgent";
      const consideredRoles: PlanningRoleAssessment[] = ALL_AGENT_TEMPLATES.map((agentTemplate) => ({
        agentTemplate,
        relevant: agentTemplate === selectedRole,
        rationale: agentTemplate === selectedRole
          ? (subtask.routingReason ?? "This role matches the step's primary capability and expected deliverable.")
          : "Not selected because this role is not the best fit for the step's primary capability and deliverable.",
      }));
      return {
        subtaskId: subtask.id,
        independentExecution: subtask.dependsOn.length === 0,
        dependencyReason: subtask.dependsOn.length === 0
          ? "This step has no predecessor evidence requirement and can start independently."
          : `This step depends on ${subtask.dependsOn.join(", ")} because it consumes their evidence or artifacts.`,
        consideredRoles,
        selectedRole,
        roleExpectation: subtask.successCriteria,
        selectedModel: subtask.model ?? defaultModelForSubtask(subtask, modelPreference),
        modelReason: subtask.modelReason ?? defaultModelReasonForSubtask(subtask, subtask.model ?? defaultModelForSubtask(subtask, modelPreference), modelPreference),
      };
    }),
  };
}

function normalizePlanningAnalysis(
  plan: TaskPlan,
  provided: PlanningAnalysis | undefined,
  modelPreference: ModelPreference,
): PlanningAnalysis {
  const fallback = buildFallbackPlanningAnalysis(plan, modelPreference);
  if (!provided) return fallback;
  return {
    implementationGoal: provided.implementationGoal || fallback.implementationGoal,
    decompositionRationale: provided.decompositionRationale || fallback.decompositionRationale,
    modelPolicy: provided.modelPolicy || fallback.modelPolicy,
    stepReviews: plan.subtasks.map((subtask) => {
      const fallbackReview = fallback.stepReviews.find((review) => review.subtaskId === subtask.id)!;
      const review = provided.stepReviews.find((candidate) => candidate.subtaskId === subtask.id);
      if (!review) return fallbackReview;
      const providedRoles = new Map(review.consideredRoles.map((role) => [role.agentTemplate, role]));
      return {
        ...fallbackReview,
        ...review,
        consideredRoles: ALL_AGENT_TEMPLATES.map((agentTemplate) =>
          providedRoles.get(agentTemplate) ?? fallbackReview.consideredRoles.find((role) => role.agentTemplate === agentTemplate)!,
        ),
      };
    }),
  };
}

function deriveExecutionGraph(plan: TaskPlan): PlanExecutionStage[] {
  const stages = new Map<string, number>();
  const visit = (id: string, stack = new Set<string>()): number => {
    if (stages.has(id)) return stages.get(id)!;
    if (stack.has(id)) return 0;
    const subtask = plan.subtasks.find((candidate) => candidate.id === id);
    if (!subtask || subtask.dependsOn.length === 0) {
      stages.set(id, 0);
      return 0;
    }
    const nextStack = new Set(stack).add(id);
    const stage = Math.max(...subtask.dependsOn.map((dependency) => visit(dependency, nextStack))) + 1;
    stages.set(id, stage);
    return stage;
  };
  for (const subtask of plan.subtasks) visit(subtask.id);
  const grouped = new Map<number, string[]>();
  for (const subtask of plan.subtasks) {
    const stage = stages.get(subtask.id) ?? 0;
    grouped.set(stage, [...(grouped.get(stage) ?? []), subtask.id]);
  }
  return [...grouped.entries()].sort(([a], [b]) => a - b).map(([stage, subtaskIds]) => ({
    stage: stage + 1,
    mode: subtaskIds.length > 1 ? "parallel" : "sequential",
    subtaskIds,
    rationale: subtaskIds.length > 1
      ? "These subtasks have no dependency on one another and may run in the same bounded wave."
      : "This stage follows its dependencies and must complete before downstream work proceeds.",
  }));
}

function buildFallbackMethodology(plan: TaskPlan): string {
  const graph = plan.executionGraph ?? deriveExecutionGraph(plan);
  return [
    "YAAA will inspect the goal and existing evidence, then execute the dependency graph in bounded stages.",
    ...graph.map((stage) => `Stage ${stage.stage} (${stage.mode}): ${stage.subtaskIds.join(", ")}. ${stage.rationale ?? ""}`),
    "After every agent attempt, YAAA will reassess the evidence against the success criteria, record any correction, and either continue, revise the assignment, or create the next agent with the corrected plan.",
  ].join("\n");
}

function buildFallbackVerificationPlan(plan: TaskPlan): VerificationPlan {
  const verifyIds = plan.subtasks.filter((subtask) => subtask.capability === "verify" || /TesterAgent$/.test(subtask.agentTemplate ?? "")).map((subtask) => subtask.id);
  const visualPossible = plan.subtasks.some((subtask) => subtask.agentTemplate === "CvTesterAgent" || subtask.agentTemplate === "QaTesterAgent" || subtask.capability === "browser");
  const automatedPossible = plan.subtasks.some((subtask) => subtask.agentTemplate === "QaTesterAgent" || subtask.capability === "shell");
  const targetIds = verifyIds.length ? verifyIds : plan.subtasks.map((subtask) => subtask.id);
  return {
    required: true,
    strategy: "YAAA must inspect the concrete deliverable, run the strongest safe automated checks available, and use screenshot/browser verification for visual work when the assigned tools support it.",
    stages: [
      { id: "artifact-inspection", kind: "artifact", targetSubtaskIds: targetIds, capability: "files", method: "Reopen produced files, confirm referenced assets exist, and compare the deliverable against success criteria.", available: true, limitation: "File inspection proves contents and existence, not rendered visual appearance.", fallback: "Record the unproven visual risk as a finding for YAAA." },
      { id: "automated-checks", kind: "automated", targetSubtaskIds: targetIds, capability: "shell", method: "Run non-destructive tests, type checks, builds, or smoke commands relevant to the deliverable.", available: automatedPossible, limitation: "Automated checks do not prove visual layout or user-perceived behavior.", fallback: "Research or inspect the strongest available static evidence and report the missing proof." },
      { id: "visual-check", kind: "visual", targetSubtaskIds: targetIds, capability: "browser", method: "Open the result in the browser and capture a screenshot or screencast when the task has a rendered UI or visual artifact.", available: visualPossible, limitation: "Browser automation cannot reliably prove timers, animation timing, performance windows, or unavailable external state.", fallback: "Use one complete browser evaluation sequence if possible; otherwise report the limitation and research an effective verification method." },
      ...(!visualPossible ? [{ id: "visual-research-fallback", kind: "research" as const, targetSubtaskIds: targetIds, capability: "verify" as const, method: "Research and explain the strongest effective verification method for the unrendered or inaccessible visual claim.", available: true, limitation: "Research explains a verification method but cannot prove the local rendered result.", fallback: "Report the unproven visual claim as an open bug/limitation to YAAA." }] : []),
    ],
    toolLimitations: [
      "A file screenshot is not equivalent to a browser-rendered screenshot.",
      "Browser actions are round-trip checks, not a real-time test runner; timer and performance claims may remain unproven.",
      "Web research can explain how to verify a claim but cannot itself prove the local deliverable is correct.",
    ],
    decisionPolicy: "Verification findings are bugs addressed to YAAA. YAAA decides whether to correct, create a replacement worker, accept a documented limitation, and whether re-verification is required.",
  };
}

function normalizeVerificationPlan(plan: TaskPlan, provided?: VerificationPlan): VerificationPlan {
  const fallback = buildFallbackVerificationPlan(plan);
  if (!provided) return fallback;
  const providedById = new Map(provided.stages.map((stage) => [stage.id, stage]));
  const stages = fallback.stages.map((stage) => {
    const candidate = providedById.get(stage.id);
    if (!candidate) return stage;
    // The runtime's known capability surface is authoritative. The model may
    // describe a check, but it cannot make an unavailable browser/shell tool
    // available by claiming it in JSON.
    return { ...candidate, available: candidate.available && stage.available };
  });
  for (const stage of provided.stages) {
    if (!stages.some((candidate) => candidate.id === stage.id)) stages.push(stage);
  }
  return {
    required: true,
    strategy: provided.strategy || fallback.strategy,
    stages,
    toolLimitations: [...new Set([...fallback.toolLimitations, ...provided.toolLimitations])],
    decisionPolicy: provided.decisionPolicy || fallback.decisionPolicy,
  };
}
