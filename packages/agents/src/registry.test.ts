import { describe, it, expect } from "vitest";
import { AGENT_REGISTRY, selectAgentTemplate } from "./registry.js";

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

  describe("blueprint roster", () => {
    const ROSTER_HANDLES = [
      "@principal-swe",
      "@ui-architect",
      "@3d-graphics-engineer",
      "@researcher",
      "@ad-strategist",
      "@designer",
      "@devops",
      "@qa-tester",
      "@cv-tester",
    ];

    it("registers every blueprint specialist with a mention handle", () => {
      const handles = entries
        .map(([, template]) => template.handle)
        .filter(Boolean);
      for (const handle of ROSTER_HANDLES) {
        expect(handles).toContain(handle);
      }
    });

    it("gives QA and CV testers the independent verifier model role", () => {
      expect(AGENT_REGISTRY.QaTesterAgent.modelRole).toBe("verifier");
      expect(AGENT_REGISTRY.CvTesterAgent.modelRole).toBe("verifier");
    });

    it("enforces the 95% coverage mandate in the QA prompt", () => {
      expect(AGENT_REGISTRY.QaTesterAgent.systemPrompt).toContain("95%");
    });
  });

  describe("selectAgentTemplate", () => {
    it("routes verification subtasks to the QA tester", () => {
      expect(
        selectAgentTemplate({
          capability: "verify",
          title: "Verify summary contents",
        }),
      ).toBe("QaTesterAgent");
    });

    it("routes visual verification to the CV tester", () => {
      expect(
        selectAgentTemplate({
          capability: "verify",
          title: "Verify the GUI screenshot alignment",
        }),
      ).toBe("CvTesterAgent");
    });

    it.each([
      [
        "Migrate the legacy database to Kafka microservices",
        "PrincipalSweAgent",
      ],
      ["Build the React dashboard layout with CSS grid", "UiArchitectAgent"],
      ["Implement the WebGL aligner mesh viewer", "GraphicsEngineerAgent"],
      ["Research competitor pricing for clear aligners", "ResearcherAgent"],
      ["Plan the Meta ad campaign for the dental clinic", "AdStrategistAgent"],
      ["Design the promotional pamphlet layout", "DesignerAgent"],
      ["Set up the Docker and CI/CD pipeline", "DevOpsAgent"],
      ["Write a summary file of battery facts", "FilesAgent"],
    ])("routes %j to %s", (title, expected) => {
      expect(selectAgentTemplate({ capability: "files", title })).toBe(
        expected,
      );
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
