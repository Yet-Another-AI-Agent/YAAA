/**
 * Context compaction for long agent loops.
 *
 * A worker's ReAct loop appends the full JSON of every tool result to its
 * message history. Over many turns this is the single biggest token hog and can
 * blow the model's context window. The cheapest, safest reclaim (used by Claude
 * Code, SWE-agent, OpenCode, …) is "tool-result clearing": keep the framing
 * messages and the most recent turns verbatim, and replace the *content* of
 * older, bulky tool results with a short placeholder — no LLM summarization call.
 *
 * This is a pure function that operates on the prompt sent to the model, so it
 * is non-destructive to the caller's running history and trivially unit-tested.
 */

/** Minimal structural shape compatible with ChatMessage ({ role, content }). */
export interface CompactableMessage {
  role: string;
  content: string;
}

export interface CompactOptions {
  /** Leading messages kept verbatim (system prompt + initial brief). */
  keepLeading?: number;
  /** Most-recent messages kept verbatim (the live working set). */
  keepRecent?: number;
  /** Only elide a tool result larger than this (chars); tiny results are cheap. */
  minElideChars?: number;
  /** Replacement text for an elided tool result. */
  placeholder?: string;
}

export const DEFAULT_COMPACT_OPTIONS: Required<CompactOptions> = {
  keepLeading: 2,
  keepRecent: 4,
  minElideChars: 200,
  placeholder: "[earlier tool result elided to save context — re-run the tool if you need it again]",
};

const TOOL_RESULT_PREFIXES = ["Tool Execution Result", "Tool Execution Error"];

/** True for the user-role messages the inner loop injects to report tool output. */
export function isToolResultMessage(message: CompactableMessage): boolean {
  return (
    message.role === "user" &&
    TOOL_RESULT_PREFIXES.some((prefix) => message.content.startsWith(prefix))
  );
}

/**
 * Return a compacted copy of `messages`: the first `keepLeading` and last
 * `keepRecent` messages are untouched; in the middle band, bulky tool-result
 * messages have their content replaced by a placeholder. Everything else
 * (assistant reasoning, small results) is preserved so the model keeps its
 * decision trail. Returns the input unchanged when there's nothing to elide.
 */
export function compactMessages<T extends CompactableMessage>(
  messages: T[],
  options: CompactOptions = {},
): T[] {
  const { keepLeading, keepRecent, minElideChars, placeholder } = {
    ...DEFAULT_COMPACT_OPTIONS,
    ...options,
  };

  if (messages.length <= keepLeading + keepRecent) return messages;

  const firstRecentIndex = messages.length - keepRecent;
  let elided = false;
  const out = messages.map((message, index) => {
    if (index < keepLeading || index >= firstRecentIndex) return message;
    if (isToolResultMessage(message) && message.content.length > minElideChars) {
      elided = true;
      return { ...message, content: placeholder };
    }
    return message;
  });
  return elided ? out : messages;
}

/* -------------------------------------------------------------------------- */
/*  Heavier tier: rolling LLM-summary compaction                               */
/* -------------------------------------------------------------------------- */

export interface SummaryOptions {
  /** Leading messages kept verbatim (system prompt + initial brief). */
  keepLeading?: number;
  /** Most-recent messages kept verbatim (the live working set). */
  keepRecent?: number;
  /** Summarize once the estimated char count of the array exceeds this. */
  maxChars?: number;
}

export const DEFAULT_SUMMARY_OPTIONS: Required<SummaryOptions> = {
  keepLeading: 2,
  keepRecent: 4,
  // ~24000 chars ≈ 6k tokens. Kept well above the small conversations used in
  // tests so ordinary short runs never trigger a summarization call.
  maxChars: 24000,
};

/** Prefix prepended to the injected summary message. */
export const SUMMARY_PREFIX = "Summary of earlier work so far:\n";

/**
 * Rough size of a message array, measured as the total length of all message
 * content. A cheap proxy for token count — good enough to decide whether it's
 * worth paying for a summarization call.
 */
export function estimateChars(messages: CompactableMessage[]): number {
  let total = 0;
  for (const message of messages) total += message.content.length;
  return total;
}

/**
 * True when `messages` is both large enough to be worth summarizing (over
 * `maxChars`) and has an actual middle band to collapse (more messages than the
 * leading + recent bands we always keep verbatim).
 */
export function needsSummary(
  messages: CompactableMessage[],
  options: SummaryOptions = {},
): boolean {
  const { keepLeading, keepRecent, maxChars } = {
    ...DEFAULT_SUMMARY_OPTIONS,
    ...options,
  };
  if (messages.length <= keepLeading + keepRecent) return false;
  return estimateChars(messages) > maxChars;
}

/**
 * The middle band (everything between the leading and recent bands) — the slice
 * a summarization pass should compress. Returned so callers can build the LLM
 * prompt without re-deriving the indices. Empty when there is no middle band.
 */
export function middleBand<T extends CompactableMessage>(
  messages: T[],
  options: SummaryOptions = {},
): T[] {
  const { keepLeading, keepRecent } = { ...DEFAULT_SUMMARY_OPTIONS, ...options };
  if (messages.length <= keepLeading + keepRecent) return [];
  return messages.slice(keepLeading, messages.length - keepRecent);
}

/**
 * Collapse the middle band into a single summary message:
 * `[...leading, { role: "user", content: SUMMARY_PREFIX + summaryText }, ...recent]`.
 * Returns the input unchanged when there's no middle band to collapse.
 */
export function applySummary<T extends CompactableMessage>(
  messages: T[],
  summaryText: string,
  options: SummaryOptions = {},
): T[] {
  const { keepLeading, keepRecent } = { ...DEFAULT_SUMMARY_OPTIONS, ...options };
  if (messages.length <= keepLeading + keepRecent) return messages;

  const leading = messages.slice(0, keepLeading);
  const recent = messages.slice(messages.length - keepRecent);
  const summaryMessage = {
    role: "user",
    content: SUMMARY_PREFIX + summaryText,
  } as T;
  return [...leading, summaryMessage, ...recent];
}
