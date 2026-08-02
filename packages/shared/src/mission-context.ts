/**
 * Mission context assembly.
 *
 * Sub-agents used to receive only their own subtask title + success criteria,
 * so the LLM had no idea what the overall mission was or what sibling agents had
 * already produced. This module composes a structured, token-budgeted brief that
 * threads the mission goal and the results of completed dependencies into every
 * agent prompt — without dumping unbounded history (see the char budget below).
 *
 * It is intentionally a pure function with no I/O or LLM dependency so it can be
 * unit-tested in isolation and reused by any layer (orchestrator, agents).
 */

import type { Skill } from "./skills/skill-registry.js";
import type { ContextPolicy, ExecutionContract } from "./types.js";

/** A condensed result handed forward from a completed subtask to its dependents. */
export interface DependencyOutput {
  /** Subtask id, e.g. "subtask-1". */
  id: string;
  /** Human-readable subtask title. */
  title: string;
  /** One-paragraph summary of what that subtask produced. */
  summary: string;
  /** Durable artifacts produced by the agent, including proof and handoff docs. */
  artifacts?: Array<{ path: string; mimeType: string; description: string }>;
}

export interface AgentBriefInput {
  /** Context selector role; controls which durable facts are promoted. */
  role?: "planner" | "orchestrator" | "worker" | "verifier";
  /** The user's overall mission goal (plan.goal). */
  missionGoal: string;
  /** The specific subtask this agent must complete. */
  subtaskTitle: string;
  /** The subtask's success criteria. */
  successCriteria: string;
  /** Composite specialist roles assigned to this one worker. */
  roles?: string[];
  /** Union of permission-scoped capabilities available to this worker. */
  capabilities?: string[];
  /** Results from subtasks this one depends on, in completion order. */
  dependencyOutputs?: DependencyOutput[];
  /**
   * Directive injected when previous agents failed and a fresh approach is
   * required. Kept verbatim so the kill-switch wording ("COMPLETELY DIFFERENT")
   * still reaches the model.
   */
  retryDirective?: string;
  /** Character budget for the dependency-results section (~4 chars/token). */
  maxDependencyChars?: number;
  /** Orchestrator-authored assignment document path for this agent. */
  handsOnPath?: string;
  /** Agent-authored handoff path expected at completion. */
  handOffPath?: string;
  /** Live files found in the task workspace immediately before this brief. */
  workspaceArtifactPaths?: string[];
  /** Sub-subtasks breakdown (micro-steps) managed by the sub-agent. */
  subSubtasks?: Array<{ id: string; title: string; state: string; result?: string }>;
  /** Special technical skills and library documentation provided to the agent. */
  skills?: Skill[];
  /** LLM-generated execution policy for this assignment. */
  executionContract?: ExecutionContract;
  /** Per-assignment context limits selected by the planner. */
  contextPolicy?: ContextPolicy;
  /** Optional hard character ceiling for this prompt packet. */
  maxContextChars?: number;
}

/**
 * The bounded, role-specific view sent to a model. Durable mission state is
 * intentionally not represented here; it remains in the plan store, event
 * log, workspace files, and handoff documents.
 */
export interface ContextPacket {
  role: "planner" | "orchestrator" | "worker" | "verifier";
  missionGoal: string;
  assignment: string;
  successCriteria: string;
  activeStep?: string;
  requiredFiles: string[];
  relevantEvidence: string[];
  dependencySummary: string[];
  selectedSkillIds: string[];
  constraints: string[];
  omittedSections: string[];
}

/** Select durable facts for one model boundary without reading or copying the full transcript. */
export function assembleContextPacket(input: AgentBriefInput): ContextPacket {
  const subSubtasks = input.subSubtasks ?? [];
  const activeStep = subSubtasks.find((step) => step.state === "running");
  const rawDependencySummary = (input.dependencyOutputs ?? []).map((dependency) =>
    `[${dependency.id}] ${dependency.title}: ${dependency.summary}`,
  );
  const dependencySummary = budgetLines(
    rawDependencySummary,
    input.contextPolicy?.maxDependencyChars ?? DEFAULT_MAX_DEPENDENCY_CHARS,
  ).split("\n").filter(Boolean);
  const requiredFiles = input.executionContract?.requiredArtifacts ?? [];
  const selectedSkillIds = (input.skills ?? []).map((skill) => skill.id);
  const omittedSections = ["full-transcript", "unrelated-sibling-results"];
  if (input.contextPolicy?.includeFullSkillDocs === false) omittedSections.push("full-skill-documents");
  return {
    role: input.role ?? "worker",
    missionGoal: input.missionGoal?.trim() || "(not specified)",
    assignment: input.subtaskTitle?.trim() || "(not specified)",
    successCriteria: input.successCriteria?.trim() || "(not specified)",
    activeStep: activeStep ? `${activeStep.id}: ${activeStep.title}` : undefined,
    requiredFiles,
    relevantEvidence: dependencySummary.slice(-4),
    dependencySummary,
    selectedSkillIds,
    constraints: [
      ...(input.executionContract?.expectedNextActions ?? []),
      ...(input.retryDirective?.trim() ? [input.retryDirective.trim()] : []),
    ],
    omittedSections,
  };
}

/** ~1.5k tokens of dependency context by default. */
export const DEFAULT_MAX_DEPENDENCY_CHARS = 6000;

/**
 * Join lines up to a character budget. Once the budget would be exceeded the
 * remaining lines are dropped and a single notice records how many were omitted,
 * so the model knows context was elided rather than silently missing. A single
 * over-long line is hard-truncated so at least one dependency always survives.
 */
export function budgetLines(lines: string[], maxChars: number): string {
  const kept: string[] = [];
  let used = 0;
  let droppedFrom = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (kept.length === 0 && line.length > maxChars) {
      kept.push(`${line.slice(0, Math.max(0, maxChars - 1))}…`);
      used = maxChars;
      continue;
    }
    if (used + line.length + 1 > maxChars && kept.length > 0) {
      droppedFrom = i;
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  if (droppedFrom >= 0) {
    const dropped = lines.length - droppedFrom;
    kept.push(
      `- …(${dropped} earlier dependency result${dropped === 1 ? "" : "s"} omitted to fit the context budget)`,
    );
  }
  return kept.join("\n");
}

/**
 * Compose the user-facing brief for a worker agent. Sections are ordered so the
 * most important framing (mission goal, this subtask) comes first and the
 * budgeted dependency results follow.
 */
export function buildAgentBrief(input: AgentBriefInput): string {
  const packet = assembleContextPacket(input);
  const {
    missionGoal,
    subtaskTitle,
    successCriteria,
    dependencyOutputs = [],
    retryDirective,
    maxDependencyChars = DEFAULT_MAX_DEPENDENCY_CHARS,
    handsOnPath,
    handOffPath,
    workspaceArtifactPaths = [],
    subSubtasks = [],
    skills = [],
    executionContract,
    contextPolicy,
    maxContextChars = contextPolicy ? contextPolicy.maxInputTokens * 4 : undefined,
  } = input;

  const sections: string[] = [];

  // Keep one compact, self-contained assignment summary at the very front of
  // every worker packet. Some providers over-weight the current micro-step
  // and may otherwise treat a terse derived label such as "Draft content" as
  // the entire assignment. This summary is deliberately duplicated from the
  // structured sections below so it survives any later evidence trimming.
  sections.push(
    `## Assignment at a glance\nMission: ${packet.missionGoal}\nDeliverable/task: ${packet.assignment}\nAcceptance criteria: ${packet.successCriteria}${packet.activeStep ? `\nCurrent micro-step: ${packet.activeStep}` : ""}${input.roles?.length ? `\nAssigned roles: ${input.roles.join(" + ")}` : ""}${input.capabilities?.length ? `\nAvailable capabilities: ${input.capabilities.join(", ")}` : ""}\n\nThis is the complete assignment context. Start work immediately using the supplied details. Do not ask for the mission, deliverable, acceptance criteria, or current step again. Do not claim that context is missing unless these fields are explicitly marked as not specified.`,
  );

  if (retryDirective && retryDirective.trim()) {
    sections.push(`## Important\n${retryDirective.trim()}`);
  }

  sections.push(`## Mission goal\n${packet.missionGoal}`);
  sections.push(`## Your subtask\n${packet.assignment}`);
  sections.push(
    `## Success criteria\n${packet.successCriteria}`,
  );

  if (packet.activeStep) sections.push(`## Active sub-step\n${packet.activeStep}`);

  if (packet.role === "verifier") {
    sections.push(`## Verification target\nRead-only verification assignment. Verify only the declared artifacts and acceptance criteria; do not recreate the producer's work.\n- Required artifacts: ${packet.requiredFiles.join(", ") || "use the canonical workspace inventory"}\n- Producer evidence: ${packet.relevantEvidence.join(" | ") || "none supplied; inspect the canonical artifacts"}`);
  }

  if (skills.length > 0) {
    const skillDocs = skills.map(
      (s) => contextPolicy?.includeFullSkillDocs === false
        ? `### ${s.name} (${s.category})\n${s.description}\n\nSkill documentation is available through the assignment preflight reader. Read only this selected skill before using tools.`
        : `### ${s.name} (${s.category})\n${s.description}\n\n${s.content}`
    );
    sections.push(`## Required Skill Preflight\nBefore using any tool, identify the relevant provided skill(s) below, read the applicable instructions, and follow them. Do not start tool work until this preflight is complete.\n\n## Provided Skills & Technical Documentation\n${skillDocs.join("\n\n---\n\n")}`);
  }

  if (subSubtasks.length > 0) {
    const subLines = subSubtasks.map(
      (st: { id: string; title: string; state: string; result?: string }) =>
        `- [${st.state === "completed" ? "x" : " "}] ${st.id}: ${st.title}${st.result ? ` (${st.result})` : ""}`
    );
    sections.push(`## Sub-subtasks breakdown\n${subLines.join("\n")}`);
  }

  if (handsOnPath || handOffPath) {
    const lines = [
      handsOnPath
        ? `- Read the orchestrator-authored hands-on brief at \`${handsOnPath}\` for full task details and micro-steps breakdown before acting.`
        : "",
      handOffPath
        ? `- Create the final consolidated handoff at \`${handOffPath}\` with work done, proof of work, tool evidence, produced artifacts, residual risks, and continuation instructions. (Transient \`checkpoint.md\` is automatically cleaned up upon completion).`
        : "",
    ].filter(Boolean);
    sections.push(`## Handoff contract\n${lines.join("\n")}`);
  }

  sections.push(
    `## Exit checklist\nBefore you stop, verify every item below:\n- The requested deliverable exists as a concrete file/artifact, not only as search results, notes in chat, or a tool observation.\n- The deliverable satisfies the success criteria above; if it does not, keep working or write a clear blocker handoff.\n- You used available tools to check the deliverable exists and, when possible, reopened/read/rendered/tested it.\n${handOffPath ? `- You wrote the consolidated handoff and proof of work to \`${handOffPath}\`.` : "- You recorded a final handoff with work done, proof of work, tool evidence, residual risks, and continuation instructions."}\n- Do not exit immediately after web.search, list_files, read_file, or browser inspection unless you have also created/found the deliverable artifact and completed the proof/handoff.`,
  );

  if (executionContract) {
    sections.push(`## Execution contract\nThis is the task-specific policy generated during planning. Follow it as the source of truth; do not invent extra steps or repeatedly redo completed work.\n- Required artifacts: ${executionContract.requiredArtifacts.join(", ") || "none declared"}\n- Target workspace: ${executionContract.targetWorkspace || "the canonical task workspace"}\n- Expected next actions: ${executionContract.expectedNextActions.join("; ") || "choose the next evidence-backed action"}\n- Preflight once per assignment: ${executionContract.preflight.runOncePerAssignment ? "yes" : "no"}${executionContract.preflight.targetPaths.length ? `; target paths: ${executionContract.preflight.targetPaths.join(", ")}` : ""}\n- Completion signals: ${executionContract.completionSignals.join("; ")}\n- No-progress policy: correct after ${executionContract.noProgress.correctionAfter} equivalent results; stop after ${executionContract.noProgress.stopAfter}.\n- Sequential action queues: use for ${executionContract.actionQueue.useWhen.join(", ") || "related dependent actions"}; max ${executionContract.actionQueue.maxActions} actions, depth ${executionContract.actionQueue.maxDepth}, stop on error: ${executionContract.actionQueue.stopOnError ? "yes" : "no"}.\n- Verification surface: ${executionContract.verificationSurface}.`);
  }

  if (contextPolicy) {
    sections.push(`## Context policy\nThe complete mission history remains durable outside this prompt. Use only the relevant assignment context here. Read additional files or selected skill documentation on demand when needed.\n- Context budget: approximately ${contextPolicy.maxInputTokens} input tokens\n- Dependency evidence: up to ${contextPolicy.maxDependencyChars} characters\n- History: up to ${contextPolicy.maxHistoryTurns} recent turns\n- File excerpts: up to ${contextPolicy.maxFileExcerptLines} lines\n- Full skill documents initially: ${contextPolicy.includeFullSkillDocs ? "yes" : "no"}\n- On-demand reads: ${contextPolicy.allowOnDemandReads ? "allowed" : "not allowed"}.`);
  }

  if (dependencyOutputs.length > 0) {
    const lines = dependencyOutputs.map(
      (d) => {
        const artifactSummary = d.artifacts?.length
          ? ` Artifacts: ${d.artifacts.map((a) => `${a.path} (${a.description})`).join("; ")}`
          : "";
        return `- [${d.id}] ${d.title}: ${d.summary}${artifactSummary}`;
      },
    );
    sections.push(
      `## Results from completed dependencies\n${budgetLines(lines, maxDependencyChars)}`,
    );
  } else {
    sections.push(
      `## Results from completed dependencies\nNone yet — this is an early step in the plan.`,
    );
  }

  if (workspaceArtifactPaths.length > 0) {
    sections.push(
      `## Live workspace artifact inventory\nThe following files currently exist in the task workspace. These are authoritative current paths, not guesses from the original plan:\n${workspaceArtifactPaths.map((filePath) => `- \`${filePath}\``).join("\n")}`,
    );
  }

  sections.push(
    `Work toward the mission goal above. Use tools as needed. Only emit your final result after the exit checklist is satisfied, or after you have written a blocker handoff explaining exactly why it cannot be satisfied.`,
  );

  let rendered = sections.join("\n\n");
  if (maxContextChars && rendered.length > maxContextChars) {
    // Preserve the assignment contract and completion instructions. Trim
    // evidence-heavy sections first; the agent can retrieve omitted details
    // through the bounded read tools when the policy permits it.
    const removableHeadings = [
      "## Live workspace artifact inventory",
      "## Results from completed dependencies",
      "## Sub-subtasks breakdown",
      "## Provided Skills & Technical Documentation",
    ];
    for (const heading of removableHeadings) {
      if (rendered.length <= maxContextChars) break;
      const index = sections.findIndex((section) => section.includes(heading));
      if (index < 0) continue;
      sections[index] = `${heading}\n[Omitted from this turn to fit the context budget. Use the assignment's bounded read tools if this evidence is required.]`;
      rendered = sections.join("\n\n");
    }
    if (rendered.length > maxContextChars) {
      rendered = `${rendered.slice(0, Math.max(0, maxContextChars - 180))}\n\n[Context packet truncated at the planner-selected budget; durable mission state remains persisted outside this prompt.]`;
    }
  }
  return rendered;
}

export interface MissionSummaryInput {
  /** The mission's original goal. */
  goal: string;
  /** Subtasks with their final state, for a progress snapshot. */
  subtasks?: Array<{ id: string; title: string; state: string }>;
  /** Condensed results produced so far. */
  completedResults?: DependencyOutput[];
  /** Character budget for the whole summary. */
  maxChars?: number;
}

/** ~1k tokens of prior-mission context by default. */
export const DEFAULT_MAX_SUMMARY_CHARS = 4000;

/**
 * Condense a mission's prior plan + results into a short brief that can be
 * re-injected as `priorSummary` when the user sends a follow-up on an existing
 * mission. This is what lets a continued session "remember what happened before"
 * without replaying the entire transcript.
 */
export function buildMissionSummary(input: MissionSummaryInput): string {
  const { goal, subtasks = [], completedResults = [], maxChars = DEFAULT_MAX_SUMMARY_CHARS } = input;
  const sections: string[] = [];

  sections.push(`Original goal: ${goal?.trim() || "(not specified)"}`);

  if (subtasks.length > 0) {
    const lines = subtasks.map((s) => `- [${s.state}] ${s.title}`);
    sections.push(`Progress so far:\n${budgetLines(lines, Math.floor(maxChars / 2))}`);
  }

  if (completedResults.length > 0) {
    const lines = completedResults.map((r) => `- ${r.title}: ${r.summary}`);
    sections.push(`Key results:\n${budgetLines(lines, Math.floor(maxChars / 2))}`);
  }

  return sections.join("\n\n");
}
