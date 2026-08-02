import type { IMeshGateway, IBus, ChatMessage } from "@yaaa/interfaces";
import { container, type Container } from "@yaaa/platform";
import { Capability, TaskPlanSchema, type TaskPlan, type PlanExecutionStage, type ModelPreference, type VerificationPlan, type PlanningAnalysis, getMatchingSkills, getSkill } from "@yaaa/shared";
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
  ? `\n\nHere is the bounded system architecture reference. Use the graph/files tools later for exact code details:\n\n${archDoc.slice(0, 6_000)}${archDoc.length > 6_000 ? "\n[…architecture reference truncated; exact implementation details are not planning context]" : ""}`
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
  sota: "openai/gpt-5.5-pro",
  // Mesh exposes Gemini 3 Flash with the preview suffix. The unsuffixed id
  // returns 404 from Mesh and must never be emitted as a planner fallback.
  balanced: "google/gemini-3.1-pro-preview",
  "cost-effective": "google/gemini-3.1-flash-lite-preview",
};

const PLANNER_CAPABILITIES = new Set([
  "docs",
  "browser",
  "shell",
  "files",
  "integration",
  "verify",
]);

// Planner output is model-authored, so tolerate common aliases but normalize
// them before the execution contract reaches the permission filter. The
// runtime exposes execute_command; leaving shell_exec or execute_shell_command
// in a populated allowlist silently removes the real shell tool.
const TOOL_ALIASES: Record<string, string> = {
  shell_exec: "execute_command",
  execute_shell_command: "execute_command",
  shell_execute: "execute_command",
  readFile: "read_file",
  writeFile: "write_file",
  readFileLines: "read_file_lines",
  writeFileLines: "write_file_lines",
  fileMulti: "file_multi",
  files_read: "read_file",
  files_write: "write_file",
  files_read_lines: "read_file_lines",
  files_write_lines: "write_file_lines",
  files_multi: "file_multi",
  shell_execute_command: "execute_command",
  shell_open_terminal: "open_terminal",
  shell_read_terminal: "read_terminal",
  browser_multi_action: "browser_multi",
  browser_search: "web_search",
};

const RUNTIME_TOOL_NAMES = new Set([
  "read_skill", "code_review_graph_preflight", "read_file", "read_file_lines", "write_file", "write_file_lines",
  "download_file", "list_files", "search_files", "delete_path", "delete_file_lines", "create_directory", "move_path",
  "copy_path", "path_metadata", "file_screenshot", "generate_image", "file_multi", "complete_sub_subtask", "add_sub_subtask",
  "ask_orchestrator", "request_extension", "execute_command", "open_terminal", "write_terminal", "read_terminal",
  "observe_terminal", "detach_terminal", "attach_terminal", "list_terminals", "navigate_terminal", "resize_terminal",
  "terminate_terminal", "terminal_screenshot", "web_search", "fetch_web_page", "web_results_screenshot", "open_browser",
  "browser_navigate", "browser_navigate_and_wait", "browser_click", "browser_type", "browser_fill_form", "browser_select",
  "browser_press", "browser_hover", "browser_reload", "browser_refresh", "browser_back", "browser_go_back",
  "browser_go_back_times", "browser_forward", "browser_go_front", "browser_go_front_times", "browser_wait", "browser_content",
  "observe_browser", "attach_browser", "detach_browser", "browser_evaluate_script", "browser_screenshot", "browser_multi",
  "close_browser", "canvas_commenter", "qa_coverage_checker", "cv_tester",
]);

function normalizeAllowedTools(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((tool) => String(tool).trim())
    .filter(Boolean)
    .map((tool) => {
      const withoutNamespace = tool.replace(/^(?:files|shell|browser|web)\./, "");
      const normalized = TOOL_ALIASES[tool] ?? TOOL_ALIASES[withoutNamespace] ?? withoutNamespace;
      return RUNTIME_TOOL_NAMES.has(normalized) ? normalized : "";
    })
    .filter(Boolean)));
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
  capabilities: string[];
  riskLevel?: string;
  roles: string[];
}, preference: ModelPreference = "balanced"): string {
  if (preference === "sota" || preference === "cost-effective") return PREFERENCE_MODEL_DEFAULTS[preference];
  // High-stakes or engineering-heavy work gets the strongest tier.
  if (subtask.riskLevel === "high") return MODEL_TIERS.complex;
  if (subtask.roles.some((role) => COMPLEX_AGENT_TEMPLATES.has(role))) {
    return MODEL_TIERS.complex;
  }
  // Simple, well-bounded file ops and verification go to the cheapest tier.
  if (subtask.capabilities.some((capability) => capability === "verify" || capability === "files")) {
    return MODEL_TIERS.simple;
  }
  // Everything else (docs, browser, integration, shell content work) is mid-tier.
  return MODEL_TIERS.medium;
}

/** Explain the cost/capability tradeoff behind the model shown at agent creation. */
export function defaultModelReasonForSubtask(subtask: {
  capabilities: string[];
  riskLevel?: string;
  roles: string[];
}, model: string, preference: ModelPreference = "balanced"): string {
  if (preference === "sota") {
    return `The SOTA setting selects the strongest reachable model for ${subtask.roles.join(" + ")} work to maximize performance and reasoning quality.`;
  }
  if (preference === "cost-effective") {
    return `The Cost Effective setting selects the lowest-cost adequate model for ${subtask.roles.join(" + ")} work; the assignment remains bounded by the step's success criteria.`;
  }
  if (model === MODEL_TIERS.simple) {
    return `Gemini 2.5 Pro is the base model for bounded ${subtask.roles.join(" + ")} work and verification.`;
  }
  if (model === MODEL_TIERS.complex) {
    return "Claude Opus 4.8 is reserved for high-risk or engineering-heavy work that benefits from the strongest reachable reasoning.";
  }
  return `Gemini 3.1 Pro is the medium-tier choice for ${subtask.roles.join(" + ")} work.`;
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
Before the plan fields, estimate the planning work itself in planningEstimate: write a concise user-facing message explaining what YAAA is considering while generating the plan, list the main considerations, and give an expectedDurationMs estimate. This is an estimate only; deterministic runtime timeouts remain authoritative.
Planning is a decision process that must be made explicit in the returned JSON. First write the detailed implementation goal: what must be built, changed, corrected, or verified, including the observable outcome. Then decompose it by answering: how many logically independent, executable steps exist; what does each step produce; and which previous steps must it depend on? Do not split work merely to create agents.
For every step, select the complete set of cooperating agent roles, capabilities, and specialized skills required by that step. Use one subtask with multiple roles when the work shares one workspace and execution history; do not split merely because multiple roles are needed. Give one concise routing reason describing the role composition. Then choose the best reachable model for the composite assignment and explain that choice briefly.
The plan must explain the concrete approach, the number of substeps, which stages are sequential versus parallel, and the agent role/model required for every substep.
Verification is a first-class part of the plan. Add a verification plan with explicit artifact, automated, visual, and/or research checks as appropriate. For each check, state the exact capability/tool required, whether that capability is available to the assigned agent, what the check can prove, and its limitation. If a visual screenshot check is possible, require it; if it is not possible, require the verifier to research or describe the strongest effective fallback and report the unproven claim as a bug/limitation to YAAA.
The first planning response must also include an executionContract. It is an LLM-generated policy for this task, not a hardcoded workflow: list required artifacts, the target workspace, expected next actions, the dependency graph, exact paths needing one-time preflight, measurable completion signals, no-progress correction/stop thresholds, when a sequential action queue is appropriate, its maximum action count/depth and stop-on-error behavior, the correct verification surface (files, Electron, browser, shell, or none), and a contextPolicy describing the maximum useful context, dependency evidence, history turns, file excerpt size, whether full skill docs are needed, whether on-demand reads are allowed, and the exact tool names needed for this assignment. Use the runtime's canonical tool names (for example execute_command, not shell_exec; file_multi is file-only). Do not place shell, browser, or web actions inside a file batch. The runtime will validate and enforce these bounds, but must not invent task-specific steps.
Each subtask represents a step in a task graph and must declare non-empty 'roles' and 'capabilities' arrays, dependencies, riskLevel, a concise 'summary' of the work/deliverable, and success criteria. The capabilities array determines the union of permission-scoped tools available to the one composite worker. If multiple roles share one workspace and history, keep them in one subtask; use separate subtasks only when work genuinely requires independent agents or artifact handoffs. Connect independent subtasks with dependsOn only when one consumes another's artifact.
Every subtask title and success criterion must be a well-defined outcome: use an action verb, identify the artifact or behavior, and include a measurable acceptance condition when one exists. Do not generate procedural fragments such as "Execute build commands and validate process output for..." or subjectless criteria such as "uses bullet points". A worker's sub-subtasks follow the same rule and must be independently completable goals, not model turns or tool calls.
For every subtask, include a 'skills' array containing the ids of the specialized skills that exact role must consult before using tools (for example 'code-generation-skill', 'ppt-skill', 'pdf-skill', 'web-access-skill', 'word-skill', 'canvas-skill', '3d-graphics-skill', or 'chart-skill'). Include all relevant skills for that subtask, but do not attach skills needed only by another role; do not invent ids. Code tasks should use 'code-generation-skill'; add a graphics/document/web skill only when that specialized output is actually required.
You must choose one or more roles from the allowed roster and explain the composition in routingReason. Explain the model choice in modelReason using one concise sentence focused on the combined role and capability requirements.
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

Available capabilities (choose one or more strings per subtask):
- "files", "browser", "shell", "integration", "docs", and "verify".

Allowed role values:
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
      "selectedRole": "ResearcherAgent",
      "roleExpectation": "What this role must deliver",
      "selectedModel": "${MODEL_TIERS.medium}",
      "modelReason": "Why this model fits this role and step under the current settings"
    }]
  },
  "executionContract": {
    "contextPolicy": {"maxInputTokens": 6000, "maxDependencyChars": 3000, "maxHistoryTurns": 4, "maxFileExcerptLines": 120, "includeFullSkillDocs": false, "allowOnDemandReads": true, "allowedTools": ["code_review_graph_preflight", "read_skill", "read_file", "read_file_lines", "write_file", "write_file_lines", "file_multi", "complete_sub_subtask", "add_sub_subtask"]},
    "requiredArtifacts": ["index.html", "style.css", "game.js"],
    "targetWorkspace": "task working directory",
    "expectedNextActions": ["Read the graph scope", "Create only missing artifacts", "Run verification"],
    "dependencyGraph": [{"subtaskId":"subtask-1","dependsOn":[]}],
    "preflight": {"runOncePerAssignment": true, "targetPaths": ["index.html"]},
    "completionSignals": ["The required artifact exists and the stated acceptance criteria have evidence."],
    "noProgress": {"correctionAfter": 1, "stopAfter": 2},
    "actionQueue": {"useWhen": ["Related file operations are sequentially dependent or share one workspace."], "maxActions": 16, "maxDepth": 2, "stopOnError": true},
    "verificationSurface": "files"
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
      "summary": "Gather and synthesize the required facts into a referenced report.",
      "roles": ["FilesAgent"],
      "capabilities": ["files"],
      "dependsOn": [],
      "riskLevel": "low",
      "successCriteria": "A text file battery_facts.txt exists with information.",
      "routingReason": "The subtask requires gathering and validating factual information.",
      "skills": [],
      "model": "${MODEL_TIERS.simple}"
    },
    {
      "id": "subtask-2",
      "title": "Verify study contents and formatting",
      "roles": ["QaTesterAgent"],
      "capabilities": ["verify"],
      "dependsOn": ["subtask-1"],
      "riskLevel": "low",
      "successCriteria": "Verification status reports success.",
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
      const plan = this.parseAndValidate(raw, requestedAgentCount, context?.modelPreference ?? "balanced", taskId);
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

  private parseAndValidate(output: string, requestedAgentCount: number | null, modelPreference: ModelPreference = "balanced", taskId?: string): TaskPlan {
    const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/) || output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON code block found in model output.");
    }
    const rawJson = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    const plan = TaskPlanSchema.parse(rawJson);
    plan.executionContract ??= {
      contextPolicy: { maxInputTokens: 6000, maxDependencyChars: 3000, maxHistoryTurns: 4, maxFileExcerptLines: 120, includeFullSkillDocs: false, allowOnDemandReads: true, allowedTools: [] },
      requiredArtifacts: [],
      targetWorkspace: "task working directory",
      expectedNextActions: [],
      dependencyGraph: plan.subtasks.map((subtask) => ({ subtaskId: subtask.id, dependsOn: subtask.dependsOn ?? [] })),
      preflight: { runOncePerAssignment: true, targetPaths: [] },
      completionSignals: ["All required artifacts exist and the declared success criteria have evidence."],
      noProgress: { correctionAfter: 1, stopAfter: 2 },
      actionQueue: { useWhen: ["Related sequential operations share one workspace."], maxActions: 16, maxDepth: 2, stopOnError: true },
      verificationSurface: plan.verification?.stages?.some((stage) => stage.kind === "visual") ? "electron" : "files",
    };
    // Models may return a partial execution contract. Keep the durable plan
    // valid and make the context policy explicit before workers are spawned.
    // An empty tool list means "planner did not constrain tools"; it is kept
    // distinct from a populated allowlist so the runtime never guesses a
    // task-specific tool set.
    plan.executionContract.contextPolicy ??= {
      maxInputTokens: 6000,
      maxDependencyChars: 3000,
      maxHistoryTurns: 4,
      maxFileExcerptLines: 120,
      includeFullSkillDocs: false,
      allowOnDemandReads: true,
      allowedTools: [],
    };
    plan.executionContract.contextPolicy.allowedTools = normalizeAllowedTools(
      plan.executionContract.contextPolicy.allowedTools,
    );
    if (!plan.planningEstimate) {
      plan.planningEstimate = {
        message: "YAAA is comparing task dependencies, verification needs, and the best model assignments before showing the plan.",
        considerations: ["task decomposition", "dependencies", "verification", "model routing"],
        expectedDurationMs: 30_000,
      };
    }
    for (const subtask of plan.subtasks) {
      subtask.summary = subtask.summary?.trim() || `${subtask.title}. Deliverable: ${subtask.successCriteria}`.slice(0, 320);
      if (subtask.roles.length === 0 || subtask.capabilities.length === 0 || !subtask.routingReason) {
        throw new Error(`Subtask ${subtask.id} is missing the required composite routing decision (roles, capabilities, and routingReason).`);
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
      // Role names are routing metadata, not evidence that a specialized
      // document skill is needed. For example, DocumentAgent contains "doc".
      const skillQuery = `${subtask.title} ${subtask.successCriteria}`;
      const inferredSkills = getMatchingSkills(skillQuery).map((skill) => skill.id);
      const explicitSkills = (subtask.skills ?? []).filter((skillId) => Boolean(getSkill(skillId)));
      const relevantSkills = inferredSkills.length > 0
        ? explicitSkills.filter((skillId) => inferredSkills.includes(skillId))
        : explicitSkills;
      subtask.skills = Array.from(new Set([...relevantSkills, ...inferredSkills]));
      if (taskId) {
        void this.bus.publish(`task.${taskId}.agent.planner.thought`, {
          kind: "thought",
          from: "planner",
          content: `Skill routing — ${subtask.id}: ${subtask.skills.length > 0 ? subtask.skills.join(", ") : "none required"}. Matching uses explicit technology/output terms; generic “graphics”, “line”, and “graph” do not attach 3D or chart skills.`,
          metadata: {
            event: "skill_routing",
            subtaskId: subtask.id,
            selectedSkills: subtask.skills,
          },
        });
      }
    }
    if (!plan.methodology?.trim()) plan.methodology = buildFallbackMethodology(plan);
    // The graph is deterministic from dependsOn. Never trust a stale or
    // contradictory graph emitted by the model; regenerate it so the UI and
    // executor agree on what is serial versus parallel.
    plan.executionGraph = deriveExecutionGraph(plan);
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

function buildFallbackPlanningAnalysis(plan: TaskPlan, modelPreference: ModelPreference): PlanningAnalysis {
  return {
    implementationGoal: plan.goal,
    decompositionRationale: "YAAA derived the smallest dependency-aware graph from the available subtasks. Steps with no dependencies may run independently; dependent steps wait for their listed predecessors.",
    modelPolicy: `Current settings policy: ${modelPreference}. Each selected model is the best reachable quality/cost fit for its step and role under this policy.`,
    stepReviews: plan.subtasks.map((subtask) => {
      const selectedRole = subtask.roles.join(" + ");
      return {
        subtaskId: subtask.id,
        independentExecution: subtask.dependsOn.length === 0,
        dependencyReason: subtask.dependsOn.length === 0
          ? "This step has no predecessor evidence requirement and can start independently."
          : `This step depends on ${subtask.dependsOn.join(", ")} because it consumes their evidence or artifacts.`,
        selectedRole,
        roleExpectation: subtask.summary || subtask.successCriteria,
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
      return {
        ...fallbackReview,
        ...review,
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
  const verifyIds = plan.subtasks.filter((subtask) => subtask.capabilities.includes("verify") || subtask.roles.some((role) => /TesterAgent$/.test(role))).map((subtask) => subtask.id);
  const visualPossible = plan.subtasks.some((subtask) => subtask.roles.some((role) => ["CvTesterAgent", "QaTesterAgent"].includes(role)) || subtask.capabilities.includes("browser"));
  const automatedPossible = plan.subtasks.some((subtask) => subtask.roles.includes("QaTesterAgent") || subtask.capabilities.includes("shell"));
  const targetIds = verifyIds.length ? verifyIds : plan.subtasks.map((subtask) => subtask.id);
  return {
    required: true,
    strategy: "YAAA must inspect the concrete deliverable, run the strongest safe automated checks available, and use screenshot/browser verification for visual work when the assigned tools support it.",
    stages: [
      { id: "artifact-inspection", kind: "artifact", targetSubtaskIds: targetIds, capability: Capability.Files, method: "Reopen produced files, confirm referenced assets exist, and compare the deliverable against success criteria.", available: true, limitation: "File inspection proves contents and existence, not rendered visual appearance.", fallback: "Record the unproven visual risk as a finding for YAAA." },
      { id: "automated-checks", kind: "automated", targetSubtaskIds: targetIds, capability: Capability.Shell, method: "Run non-destructive tests, type checks, builds, or smoke commands relevant to the deliverable.", available: automatedPossible, limitation: "Automated checks do not prove visual layout or user-perceived behavior.", fallback: "Research or inspect the strongest available static evidence and report the missing proof." },
      { id: "visual-check", kind: "visual", targetSubtaskIds: targetIds, capability: Capability.Browser, method: "Open the result in the browser and capture a screenshot or screencast when the task has a rendered UI or visual artifact.", available: visualPossible, limitation: "Browser automation cannot reliably prove timers, animation timing, performance windows, or unavailable external state.", fallback: "Use one complete browser evaluation sequence if possible; otherwise report the limitation and research an effective verification method." },
      ...(!visualPossible ? [{ id: "visual-research-fallback", kind: "research" as const, targetSubtaskIds: targetIds, capability: Capability.Verify, method: "Research and explain the strongest effective verification method for the unrendered or inaccessible visual claim.", available: true, limitation: "Research explains a verification method but cannot prove the local rendered result.", fallback: "Report the unproven visual claim as an open bug/limitation to YAAA." }] : []),
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
