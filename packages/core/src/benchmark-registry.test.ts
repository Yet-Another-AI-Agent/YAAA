import { describe, expect, it } from "vitest";
import { loadBenchmarkRegistry } from "./benchmark-registry.js";

describe("offline benchmark registry", () => {
  it("has a score and provenance for every local profile", () => {
    const registry = loadBenchmarkRegistry();
    expect(registry.models.length).toBeGreaterThan(25);
    expect(registry.models.every((profile) => Object.keys(profile.benchmarks).length > 0)).toBe(true);
    expect(registry.models.every((profile) => profile.scoreSource)).toBe(true);
  });

  it("includes the major OpenAI, Anthropic, Gemini, DeepSeek, Kimi, and open-weight families", () => {
    const ids = loadBenchmarkRegistry().models.map((profile) => profile.modelId);
    expect(ids).toEqual(expect.arrayContaining([
      "openai/gpt-5.5",
      "anthropic/claude-opus-4.8",
      "google/gemini-3.1-pro-preview",
      "deepseek/deepseek-v4-pro",
      "moonshotai/kimi-k2.5",
      "qwen/qwen3-coder",
      "meta-llama/llama-3.3-70b-instruct",
    ]));
  });
});
