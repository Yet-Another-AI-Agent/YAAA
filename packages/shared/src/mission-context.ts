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

/** A condensed result handed forward from a completed subtask to its dependents. */
export interface DependencyOutput {
  /** Subtask id, e.g. "subtask-1". */
  id: string;
  /** Human-readable subtask title. */
  title: string;
  /** One-paragraph summary of what that subtask produced. */
  summary: string;
}

export interface AgentBriefInput {
  /** The user's overall mission goal (plan.goal). */
  missionGoal: string;
  /** The specific subtask this agent must complete. */
  subtaskTitle: string;
  /** The subtask's success criteria. */
  successCriteria: string;
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
  const {
    missionGoal,
    subtaskTitle,
    successCriteria,
    dependencyOutputs = [],
    retryDirective,
    maxDependencyChars = DEFAULT_MAX_DEPENDENCY_CHARS,
  } = input;

  const sections: string[] = [];

  if (retryDirective && retryDirective.trim()) {
    sections.push(`## Important\n${retryDirective.trim()}`);
  }

  sections.push(`## Mission goal\n${missionGoal?.trim() || "(not specified)"}`);
  sections.push(`## Your subtask\n${subtaskTitle?.trim() || "(not specified)"}`);
  sections.push(
    `## Success criteria\n${successCriteria?.trim() || "(not specified)"}`,
  );

  if (dependencyOutputs.length > 0) {
    const lines = dependencyOutputs.map(
      (d) => `- [${d.id}] ${d.title}: ${d.summary}`,
    );
    sections.push(
      `## Results from completed dependencies\n${budgetLines(lines, maxDependencyChars)}`,
    );
  } else {
    sections.push(
      `## Results from completed dependencies\nNone yet — this is an early step in the plan.`,
    );
  }

  sections.push(
    `Work toward the mission goal above. Use tools as needed, and emit your final result payload once the success criteria are met.`,
  );

  return sections.join("\n\n");
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
