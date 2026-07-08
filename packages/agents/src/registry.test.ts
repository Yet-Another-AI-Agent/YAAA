import { describe, it, expect } from "vitest";
import { AGENT_REGISTRY } from "./registry.js";

describe("AGENT_REGISTRY", () => {
  const entries = Object.entries(AGENT_REGISTRY);

  it("should have at least one registered agent", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)("%s has all required fields", (_key, template) => {
    expect(typeof template.role).toBe("string");
    expect(template.role.length).toBeGreaterThan(0);

    expect(typeof template.systemPrompt).toBe("string");
    expect(template.systemPrompt.length).toBeGreaterThan(0);

    expect(Array.isArray(template.capabilities)).toBe(true);
    expect(template.capabilities.length).toBeGreaterThan(0);

    expect(["low", "medium", "high"]).toContain(template.riskCeiling);

    expect(typeof template.modelRole).toBe("string");
    expect(template.modelRole.length).toBeGreaterThan(0);
  });

  describe("FilesAgent", () => {
    const agent = AGENT_REGISTRY["FilesAgent"];

    it("is defined", () => {
      expect(agent).toBeDefined();
    });

    it("has capability 'files'", () => {
      expect(agent.capabilities).toContain("files");
    });

    it("has riskCeiling 'medium'", () => {
      expect(agent.riskCeiling).toBe("medium");
    });

    it("has modelRole 'worker'", () => {
      expect(agent.modelRole).toBe("worker");
    });

    it("has a non-empty systemPrompt", () => {
      expect(agent.systemPrompt.trim().length).toBeGreaterThan(0);
    });
  });

  describe("VerifierAgent", () => {
    const agent = AGENT_REGISTRY["VerifierAgent"];

    it("is defined", () => {
      expect(agent).toBeDefined();
    });

    it("has riskCeiling 'low'", () => {
      expect(agent.riskCeiling).toBe("low");
    });

    it("has modelRole 'verifier'", () => {
      expect(agent.modelRole).toBe("verifier");
    });

    it("has a non-empty systemPrompt", () => {
      expect(agent.systemPrompt.trim().length).toBeGreaterThan(0);
    });
  });
});
