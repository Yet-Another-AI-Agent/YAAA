import { describe, it, expect } from "vitest";
import {
  compactMessages,
  isToolResultMessage,
  DEFAULT_COMPACT_OPTIONS,
  estimateChars,
  needsSummary,
  applySummary,
  middleBand,
  SUMMARY_PREFIX,
  type CompactableMessage,
} from "./context-compaction.js";

const big = (label: string) => `Tool Execution Result:\n${label} ${"x".repeat(500)}`;

describe("isToolResultMessage", () => {
  it("detects tool result and error report messages", () => {
    expect(isToolResultMessage({ role: "user", content: "Tool Execution Result:\n{}" })).toBe(true);
    expect(isToolResultMessage({ role: "user", content: "Tool Execution Error:\nboom" })).toBe(true);
  });

  it("ignores assistant messages and ordinary user prompts", () => {
    expect(isToolResultMessage({ role: "assistant", content: "Tool Execution Result:\n{}" })).toBe(false);
    expect(isToolResultMessage({ role: "user", content: "please continue" })).toBe(false);
  });
});

describe("compactMessages", () => {
  it("returns the input unchanged when short", () => {
    const msgs: CompactableMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "brief" },
      { role: "assistant", content: "ok" },
    ];
    expect(compactMessages(msgs)).toBe(msgs);
  });

  it("elides bulky tool results in the middle band but keeps framing and recent turns", () => {
    const msgs: CompactableMessage[] = [
      { role: "system", content: "sys" }, // 0 keepLeading
      { role: "user", content: "brief" }, // 1 keepLeading
      { role: "assistant", content: "call 1" }, // 2 middle
      { role: "user", content: big("old-result") }, // 3 middle -> elided
      { role: "assistant", content: "call 2" }, // 4 middle
      { role: "user", content: big("mid-result") }, // 5 middle -> elided
      { role: "assistant", content: "call 3" }, // 6 recent
      { role: "user", content: big("recent-result") }, // 7 recent (kept)
      { role: "assistant", content: "call 4" }, // 8 recent
      { role: "user", content: big("newest-result") }, // 9 recent (kept)
    ];
    const out = compactMessages(msgs);

    expect(out[0].content).toBe("sys"); // framing kept
    expect(out[1].content).toBe("brief");
    expect(out[3].content).toBe(DEFAULT_COMPACT_OPTIONS.placeholder); // old elided
    expect(out[5].content).toBe(DEFAULT_COMPACT_OPTIONS.placeholder); // mid elided
    expect(out[7].content).toContain("recent-result"); // recent kept verbatim
    expect(out[9].content).toContain("newest-result");
    // Assistant reasoning is never elided.
    expect(out[2].content).toBe("call 1");
    expect(out[4].content).toBe("call 2");
  });

  it("does not elide small tool results", () => {
    const msgs: CompactableMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "brief" },
      { role: "user", content: "Tool Execution Result:\nok" }, // tiny, middle
      { role: "assistant", content: "a" },
      { role: "user", content: "b" },
      { role: "assistant", content: "c" },
      { role: "user", content: "d" },
    ];
    const out = compactMessages(msgs);
    expect(out[2].content).toBe("Tool Execution Result:\nok");
  });

  it("leaves non-tool-result middle messages alone", () => {
    const msgs: CompactableMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "brief" },
      { role: "user", content: "No valid JSON block found in your response." },
      { role: "assistant", content: "a" },
      { role: "user", content: "b" },
      { role: "assistant", content: "c" },
      { role: "user", content: "d" },
    ];
    const out = compactMessages(msgs);
    expect(out[2].content).toBe("No valid JSON block found in your response.");
  });

  it("preserves role types (returns a ChatMessage-compatible array)", () => {
    const msgs = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "brief" },
      { role: "assistant" as const, content: "a" },
      { role: "user" as const, content: big("x") },
      { role: "assistant" as const, content: "b" },
      { role: "user" as const, content: big("y") },
      { role: "user" as const, content: "recent" },
    ];
    const out = compactMessages(msgs);
    expect(out[3].role).toBe("user");
  });
});

describe("estimateChars", () => {
  it("sums the content length of every message", () => {
    const msgs: CompactableMessage[] = [
      { role: "system", content: "abc" }, // 3
      { role: "user", content: "de" }, // 2
      { role: "assistant", content: "" }, // 0
    ];
    expect(estimateChars(msgs)).toBe(5);
  });

  it("is zero for an empty array", () => {
    expect(estimateChars([])).toBe(0);
  });
});

describe("needsSummary", () => {
  const filler = (n: number): CompactableMessage => ({ role: "assistant", content: "z".repeat(n) });

  it("is false when there is no middle band, even if huge", () => {
    // keepLeading(2) + keepRecent(4) = 6; exactly 6 messages => no middle band.
    const msgs: CompactableMessage[] = Array.from({ length: 6 }, () => filler(10000));
    expect(estimateChars(msgs)).toBeGreaterThan(24000);
    expect(needsSummary(msgs)).toBe(false);
  });

  it("is false for a small conversation over the leading+recent count", () => {
    const msgs: CompactableMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "brief" },
      { role: "assistant", content: "a" },
      { role: "user", content: "b" },
      { role: "assistant", content: "c" },
      { role: "user", content: "d" },
      { role: "assistant", content: "e" },
    ];
    expect(needsSummary(msgs)).toBe(false);
  });

  it("is true once the estimated chars exceed maxChars with a middle band present", () => {
    // 8 messages (2 leading, 2 middle, 4 recent), > 24000 chars total.
    const msgs: CompactableMessage[] = Array.from({ length: 8 }, () => filler(4000));
    expect(needsSummary(msgs)).toBe(true);
  });

  it("honours a custom maxChars threshold", () => {
    const msgs: CompactableMessage[] = Array.from({ length: 8 }, () => filler(100));
    expect(needsSummary(msgs)).toBe(false);
    expect(needsSummary(msgs, { maxChars: 500 })).toBe(true);
  });
});

describe("middleBand", () => {
  it("returns the slice between the leading and recent bands", () => {
    const msgs: CompactableMessage[] = [
      { role: "system", content: "s" }, // leading
      { role: "user", content: "brief" }, // leading
      { role: "assistant", content: "m1" }, // middle
      { role: "user", content: "m2" }, // middle
      { role: "assistant", content: "r1" }, // recent
      { role: "user", content: "r2" }, // recent
      { role: "assistant", content: "r3" }, // recent
      { role: "user", content: "r4" }, // recent
    ];
    const band = middleBand(msgs);
    expect(band.map((m) => m.content)).toEqual(["m1", "m2"]);
  });

  it("is empty when there is no middle band", () => {
    const msgs: CompactableMessage[] = Array.from({ length: 6 }, (_, i) => ({
      role: "user",
      content: String(i),
    }));
    expect(middleBand(msgs)).toEqual([]);
  });
});

describe("applySummary", () => {
  it("replaces the middle band with a single prefixed summary message", () => {
    const msgs: CompactableMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "brief" },
      { role: "assistant", content: "call 1" },
      { role: "user", content: "Tool Execution Result:\nold" },
      { role: "assistant", content: "call 2" },
      { role: "assistant", content: "r1" },
      { role: "user", content: "r2" },
      { role: "assistant", content: "r3" },
      { role: "user", content: "r4" },
    ];
    const out = applySummary(msgs, "did X, wrote Y, now doing Z");

    // leading(2) + 1 summary + recent(4) = 7
    expect(out).toHaveLength(7);
    expect(out[0].content).toBe("sys");
    expect(out[1].content).toBe("brief");
    expect(out[2].role).toBe("user");
    expect(out[2].content).toBe(SUMMARY_PREFIX + "did X, wrote Y, now doing Z");
    expect(out[2].content).toContain("Summary of earlier work");
    // Recent band preserved verbatim.
    expect(out.slice(3).map((m) => m.content)).toEqual(["r1", "r2", "r3", "r4"]);
  });

  it("returns the input unchanged when there is no middle band", () => {
    const msgs: CompactableMessage[] = Array.from({ length: 6 }, (_, i) => ({
      role: "user",
      content: String(i),
    }));
    expect(applySummary(msgs, "summary")).toBe(msgs);
  });

  it("respects custom keepLeading/keepRecent", () => {
    const msgs: CompactableMessage[] = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "m1" },
      { role: "assistant", content: "m2" },
      { role: "user", content: "recent" },
    ];
    const out = applySummary(msgs, "note", { keepLeading: 1, keepRecent: 1 });
    // leading(1) + summary + recent(1) = 3
    expect(out).toHaveLength(3);
    expect(out[0].content).toBe("sys");
    expect(out[1].content).toBe(SUMMARY_PREFIX + "note");
    expect(out[2].content).toBe("recent");
  });
});
