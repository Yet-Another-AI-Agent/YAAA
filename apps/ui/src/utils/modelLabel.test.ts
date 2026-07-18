import { describe, it, expect } from "vitest";
import { formatModelLabel } from "./modelLabel";

describe("formatModelLabel", () => {
  it("renders a provider-qualified Mesh id as a readable name", () => {
    expect(formatModelLabel("anthropic/claude-sonnet-4.5")).toBe("Anthropic Claude Sonnet 4.5");
    expect(formatModelLabel("anthropic/claude-haiku-4.5")).toBe("Anthropic Claude Haiku 4.5");
    expect(formatModelLabel("google/gemini-2.5-flash")).toBe("Google Gemini 2.5 Flash");
  });

  it("keeps an unknown provider's name rather than dropping it", () => {
    expect(formatModelLabel("acme/some-model-2")).toBe("Acme Some Model 2");
  });

  it("titleizes an id that carries no provider prefix", () => {
    expect(formatModelLabel("claude-sonnet-4.5")).toBe("Claude Sonnet 4.5");
  });

  it("returns an empty string for empty input, so the UI renders nothing", () => {
    expect(formatModelLabel("")).toBe("");
    expect(formatModelLabel("   ")).toBe("");
  });
});
