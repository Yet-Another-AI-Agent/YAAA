/**
 * Human-facing identity helpers. The backend speaks in machine handles
 * ("orchestrator", "files-agent-zbim", "@qa-tester-2"); the chat surface speaks
 * in names people can read and @-mention. Everything here is deterministic so a
 * given agent always renders as the same person across renders and reloads.
 */

/** The single user-facing name for the orchestrator/supervisor persona. */
export const ORCHESTRATOR_DISPLAY = "YAAA";

/** The mention users type to address the orchestrator. */
export const ORCHESTRATOR_MENTION = "@yaaa";

const ORCHESTRATOR_RE = /^@?(orchestrator|supervisor|yaaa)(-\d+)?$/i;

/** True when a raw sender label refers to the orchestrator persona. */
export function isOrchestratorSender(sender: string): boolean {
  return ORCHESTRATOR_RE.test((sender || "").trim());
}

// Gender-diverse first names. The pool is intentionally large so distinct
// agents in one mission rarely collide.
const FIRST_NAMES = [
  "Mike", "Sarah", "Alex", "Priya", "Diego", "Mei", "Omar", "Lena",
  "Raj", "Nina", "Theo", "Zoe", "Ivan", "Aria", "Kofi", "Yuki",
  "Noah", "Elena", "Sam", "Farah",
];

// Roster template -> readable job title. Keys are the template role with a
// trailing "agent" stripped, so both "ResearcherAgent" and "Researcher" match.
const ROLE_LABELS: Record<string, string> = {
  files: "Software Engineer",
  verifier: "QA Tester",
  qatester: "QA Tester",
  cvtester: "Visual QA Engineer",
  principalswe: "Principal Engineer",
  uiarchitect: "UI Architect",
  graphicsengineer: "Graphics Engineer",
  researcher: "Researcher",
  adstrategist: "Ad Strategist",
  designer: "Designer",
  devops: "DevOps Engineer",
};

// Fallback role derived from the capability baked into an agent id
// (`${capability}-agent-${rand}`) when the roster role is unavailable.
const CAPABILITY_ROLE_LABELS: Record<string, string> = {
  files: "Software Engineer",
  verify: "QA Tester",
  browser: "Researcher",
  shell: "DevOps Engineer",
  docs: "Technical Writer",
  integration: "Integrations Engineer",
};

/** Stable non-negative hash for deterministic name selection. */
function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0; // force 32-bit
  }
  return Math.abs(hash);
}

export interface AgentIdentity {
  /** Human first name, e.g. "Mike". */
  firstName: string;
  /** Readable job title, e.g. "Software Engineer". */
  roleLabel: string;
  /** Mention handle, e.g. "@mike". */
  mention: string;
  /** Combined label for headers, e.g. "Mike (Software Engineer)". */
  display: string;
}

function roleLabelFor(rawId: string, role?: string): string {
  if (role) {
    const key = role.toLowerCase().replace(/[^a-z]/g, "").replace(/agent$/, "");
    if (ROLE_LABELS[key]) return ROLE_LABELS[key];
  }
  // Derive from the capability prefix of ids like "files-agent-zbim".
  const capMatch = /^([a-z]+)-agent/i.exec(rawId);
  if (capMatch) {
    const cap = capMatch[1].toLowerCase();
    if (CAPABILITY_ROLE_LABELS[cap]) return CAPABILITY_ROLE_LABELS[cap];
  }
  return "Specialist Agent";
}

/**
 * Resolve a machine agent id/handle into a human identity. The name is chosen
 * deterministically from the id so it never changes between renders.
 */
export function agentIdentity(rawId: string, role?: string): AgentIdentity {
  const seed = (rawId || "agent").toLowerCase();
  const firstName = FIRST_NAMES[hashString(seed) % FIRST_NAMES.length];
  const roleLabel = roleLabelFor(rawId, role);
  return {
    firstName,
    roleLabel,
    mention: `@${firstName.toLowerCase()}`,
    display: `${firstName} (${roleLabel})`,
  };
}

/**
 * Turn any raw chat sender (orchestrator alias, agent id, roster handle, or a
 * plain label like "User"/"System") into the name shown in the UI.
 * `roleLookup` maps a raw agent id to its roster role when known.
 */
export function displaySender(
  rawSender: string,
  roleLookup?: (id: string) => string | undefined,
): string {
  const sender = (rawSender || "").trim();
  if (!sender) return "Agent";
  if (isOrchestratorSender(sender)) return ORCHESTRATOR_DISPLAY;
  // Generic, unattributed labels have no id to derive an identity from.
  if (sender === "User" || sender === "System" || sender === "Agent") return sender;
  return agentIdentity(sender, roleLookup?.(sender)).display;
}

/**
 * Normalize a slug or LLM topic into a readable channel name — hyphens and
 * underscores become spaces. Raw task UUIDs are never allowed to leak, so an
 * empty result falls back to a safe placeholder.
 */
export function humanizeChannelName(raw: string): string {
  const cleaned = (raw || "")
    .replace(/^#/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "new mission";
}
