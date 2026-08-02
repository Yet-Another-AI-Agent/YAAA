import { describe, expect, it, vi } from "vitest";
import { createMessageId } from "./ids";

describe("createMessageId", () => {
  it("uses crypto UUIDs when available", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "crypto-id" });
    expect(createMessageId()).toBe("crypto-id");
    vi.unstubAllGlobals();
  });

  it("has a fallback when crypto UUIDs are unavailable", () => {
    vi.stubGlobal("crypto", { randomUUID: undefined });
    expect(createMessageId()).toMatch(/^message-\d+-[\da-f]+$/);
    vi.unstubAllGlobals();
  });
});
