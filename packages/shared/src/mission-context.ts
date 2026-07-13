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
  /** Durable artifacts produced by the agent, including proof and handoff docs. */
  artifacts?: Array<{ path: string; mimeType: string; description: string }>;
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
  /** Orchestrator-authored assignment document path for this agent. */
  handsOnPath?: string;
  /** Agent-authored proof-of-work path expected at completion. */
  proofOfWorkPath?: string;
  /** Agent-authored handoff path expected at completion. */
  handOffPath?: string;
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
    handsOnPath,
    proofOfWorkPath,
    handOffPath,
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

  if (handsOnPath || proofOfWorkPath || handOffPath) {
    const lines = [
      handsOnPath
        ? `- Read the orchestrator-authored hands-on brief at \`${handsOnPath}\` before acting.`
        : "",
      proofOfWorkPath
        ? `- Create proof of work at \`${proofOfWorkPath}\` with text evidence, test output, screenshots/images, or artifact references.`
        : "",
      handOffPath
        ? `- Create the final handoff at \`${handOffPath}\` with work done, observations, suggestions, asset metadata, residual risks, and continuation instructions for the orchestrator or another agent.`
        : "",
    ].filter(Boolean);
    sections.push(`## Handoff contract\n${lines.join("\n")}`);
  }

  sections.push(
    `## Exit checklist\nBefore you stop, verify every item below:\n- The requested deliverable exists as a concrete file/artifact, not only as search results, notes in chat, or a tool observation.\n- The deliverable satisfies the success criteria above; if it does not, keep working or write a clear blocker handoff.\n- You used available tools to check the deliverable exists and, when possible, reopened/read/rendered/tested it.\n${proofOfWorkPath ? `- You wrote proof of work to \`${proofOfWorkPath}\` with the evidence from that check.` : "- You recorded proof of work with concrete evidence from that check."}\n${handOffPath ? `- You wrote the final handoff to \`${handOffPath}\` with work done, observations, suggestions, asset metadata, residual risks, and continuation instructions.` : "- You wrote a final handoff with work done, observations, suggestions, asset metadata, residual risks, and continuation instructions."}\n- Do not exit immediately after web.search, list_files, read_file, or browser inspection unless you have also created/found the deliverable artifact and completed the proof/handoff.`,
  );

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

  sections.push(
    `Work toward the mission goal above. Use tools as needed. Only emit your final result after the exit checklist is satisfied, or after you have written a blocker handoff explaining exactly why it cannot be satisfied.`,
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
