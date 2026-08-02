import type { SubSubtask } from "./types.js";

const ACTION_VERBS = /^(create|build|implement|generate|write|update|add|configure|design|develop|inspect|investigate|research|locate|extract|download|run|verify|validate|test|render|open|compare|document|record|confirm|ensure|establish|resolve|review|produce|package|install|remove|refactor|migrate)\b/i;
const PROCEDURAL_WRAPPERS = /^(execute build commands and validate process output for|perform core implementation and verification tasks for|create and configure application source code files for|prepare execution environment and command line scripts for|execute core setup and implementation steps for|do assigned work for|work on)\b/i;

function sentence(value: string): string {
  const clean = value.trim().replace(/^[-*•\d.\s]+/, "").replace(/[.。]+$/, "");
  if (!clean) return "";
  return `${clean.charAt(0).toUpperCase()}${clean.slice(1)}.`;
}

function artifactFrom(text: string, fallback: string): string {
  const quoted = text.match(/["'`]([^"'`]+\.[a-z0-9]+)["'`]/i)?.[1];
  const named = text.match(/\b[\w./-]+\.(?:pptx?|docx?|xlsx?|pdf|html?|css|js|ts|png|jpe?g|svg)\b/i)?.[0];
  return quoted || named || fallback.trim() || "the deliverable";
}

/**
 * Converts a title or criterion fragment into a goal with an observable outcome.
 * Criteria are deliberately tied to the produced artifact so fragments such as
 * “uses bullet points” cannot become standalone, ambiguous TODOs.
 */
function expandToMeaningfulSentence(
  phrase: string,
  capability: string,
  contextTitle: string,
  successCriteria = "",
): string {
  const clean = phrase.trim().replace(/^[-*•\d.\s]+/, "").replace(/[.。]+$/, "");
  if (!clean) return "";

  const lower = clean.toLowerCase();
  const artifact = artifactFrom(successCriteria, artifactFrom(contextTitle, contextTitle));
  const cap = capability.toLowerCase();

  if (/^(a|the)?\s*file named\b/i.test(clean) && /\b(created|generated|exists|is made)\b/i.test(clean)) {
    return sentence(`Create and verify ${artifact} exists in the task workspace`);
  }
  if (/\bexactly\s+\d+\s+slides?\b/i.test(clean)) {
    const count = clean.match(/exactly\s+(\d+)\s+slides?/i)?.[1];
    return sentence(`Verify ${artifact} contains exactly ${count} slides`);
  }
  if (/^(it|the presentation|the document|the file)\s+(uses|contains|includes|has)\b/i.test(clean)) {
    const rest = clean.replace(/^(it|the presentation|the document|the file)\s+/i, "");
    return sentence(`Verify ${artifact} ${rest}`);
  }

  if (lower.includes("logo") || lower.includes("image") || lower.includes("asset")) {
    return sentence(`Locate, extract, and download the required branding asset for ${contextTitle}`);
  }
  if (lower.includes("research") || lower.includes("inspect") || lower.includes("fetch")) {
    return sentence(`Inspect the assigned source and record the evidence needed for ${contextTitle}`);
  }
  if (lower.includes("scroll") || lower.includes("animat") || lower.includes("keyframe")) {
    return sentence(`Implement and verify scroll-triggered keyframe animations for ${contextTitle}`);
  }
  if (lower.includes("tooth") || lower.includes("aligner") || lower.includes("crooked")) {
    return sentence("Build and verify the graphic transition from crooked teeth to an aligned smile with an aligner");
  }

  if (ACTION_VERBS.test(clean) && !PROCEDURAL_WRAPPERS.test(clean)) return sentence(clean);

  if (cap === "browser") {
    return sentence(`Inspect the target pages and capture evidence for ${clean}`);
  }
  if (cap === "files") {
    return sentence(`Implement the required source changes for ${clean} and leave the resulting artifact ready for verification`);
  }
  if (cap === "shell") {
    return sentence(`Run the required build or test for ${clean} and record pass/fail evidence`);
  }
  return sentence(`Produce a verifiable result for ${clean}`);
}

export interface SubSubtaskTitleQuality {
  valid: boolean;
  reason?: string;
}

/** Validates that a displayed step is an outcome, rather than a vague procedure. */
export function validateSubSubtaskTitle(title: string): SubSubtaskTitleQuality {
  const clean = title.trim().replace(/[.。]+$/, "");
  if (clean.length < 25 || clean.split(/\s+/).length < 5) {
    return { valid: false, reason: "Step must state a concrete goal in at least five words" };
  }
  if (PROCEDURAL_WRAPPERS.test(clean)) {
    return { valid: false, reason: "Step uses a procedural wrapper instead of an observable outcome" };
  }
  if (!ACTION_VERBS.test(clean)) {
    return { valid: false, reason: "Step must begin with an actionable outcome verb" };
  }
  return { valid: true };
}

/**
 * Derives concrete, task-specific TODO items for a subtask. Each item is a
 * goal that can be independently evidenced; it is not merely a tool command.
 */
export function deriveSubSubtasksFromSubtask(st: {
  id: string;
  title: string;
  capabilities?: string[];
  successCriteria?: string;
  state?: string;
}): SubSubtask[] {
  const titleText = st.title || "Complete the assigned deliverable";
  const criteriaText = st.successCriteria || "";
  const subtaskId = st.id || "subtask";
  const state = st.state || "pending";
  const capability = (st.capabilities?.[0] || "files").toLowerCase();
  const rawPhrases: string[] = [];

  // Split only major title clauses. Keep criteria intact enough to preserve
  // artifact names and measurable requirements.
  rawPhrases.push(...titleText.split(/\s+and\s+|\s*[,;&]\s*/i).map((p) => p.trim()).filter((p) => p.length > 2));
  if (criteriaText) {
    rawPhrases.push(...criteriaText.split(/\s*;\s*|\s*\n\s*/).map((p) => p.trim()).filter((p) => p.length > 3));
  }

  const cleanedTodos: string[] = [];
  for (const phrase of rawPhrases) {
    const expanded = expandToMeaningfulSentence(phrase, capability, titleText, criteriaText);
    if (expanded && !cleanedTodos.some((t) => t.toLowerCase() === expanded.toLowerCase())) cleanedTodos.push(expanded);
  }

  const artifact = artifactFrom(criteriaText, titleText);
  if (cleanedTodos.length < 3) {
    cleanedTodos.push(sentence(`Verify the completed ${artifact} satisfies the stated success criteria`));
  }
  if (cleanedTodos.length < 3) {
    cleanedTodos.push(sentence(`Record concrete verification evidence for ${titleText} in handOff.md`));
  }

  // Keep only valid goals. The fallback is also outcome-oriented and therefore
  // prevents legacy procedural text from reaching the UI.
  const finalSteps = cleanedTodos.filter((title) => validateSubSubtaskTitle(title).valid).slice(0, 5);
  while (finalSteps.length < 3) {
    finalSteps.push(sentence(`Verify an observable result for ${titleText}`));
  }

  const isCompleted = state === "completed";
  const isRunning = state === "running";
  return finalSteps.map((todoTitle, index) => ({
    id: `${subtaskId}.${index + 1}`,
    title: todoTitle,
    state: isCompleted ? "completed" : isRunning && index === 0 ? "running" : "pending",
  }));
}
