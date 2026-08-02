import { describe, expect, it, vi } from "vitest";
import { createTypingBarId } from "./ids";

describe("createTypingBarId", () => {
  it("uses crypto when available", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "typing-id" });
    expect(createTypingBarId()).toBe("typing-id");
    vi.unstubAllGlobals();
  });

  it("falls back when crypto is unavailable", () => {
    vi.stubGlobal("crypto", { randomUUID: undefined });
    expect(createTypingBarId()).toMatch(/^typing-bar-\d+-[\da-f]+$/);
    vi.unstubAllGlobals();
  });
});
