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

  it.each(entries)("%s requires concrete handoff evidence", (_key, template) => {
    expect(template.systemPrompt).toMatch(/evidence/i);
    expect(template.systemPrompt).toMatch(/Never (?:claim|report)/i);
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
      "@document-specialist",
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

    it("keeps QA focused on verification instead of implementation", () => {
      expect(AGENT_REGISTRY.QaTesterAgent.systemPrompt).toContain("do not create the primary deliverable");
      expect(AGENT_REGISTRY.QaTesterAgent.systemPrompt).toContain("do not write implementation code");
      expect(AGENT_REGISTRY.QaTesterAgent.systemPrompt).not.toContain("When you write a file");
    });

    it("tells the document specialist to generate real PowerPoint files with pptxgenjs", () => {
      expect(AGENT_REGISTRY.DocumentAgent.systemPrompt).toContain("pptxgenjs");
      expect(AGENT_REGISTRY.DocumentAgent.systemPrompt).toContain("real .pptx file");
      expect(AGENT_REGISTRY.DocumentAgent.systemPrompt).toContain("speaker notes");
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

    it("uses the planner's structured visual-verification assignment", () => {
      expect(
        selectAgentTemplate({
          capability: "verify",
          title: "Verify the GUI screenshot alignment",
          agentTemplate: "CvTesterAgent",
        }),
      ).toBe("CvTesterAgent");
    });

    it("routes docs subtasks to the document specialist", () => {
      expect(selectAgentTemplate({ capability: "docs", title: "Create a PPT deck" })).toBe("DocumentAgent");
    });

    it("does not infer a specialist from title keywords", () => {
      expect(selectAgentTemplate({ capability: "files", title: "Docker React research database" })).toBe("FilesAgent");
    });

    it("accepts every valid planner-selected specialist", () => {
      for (const agentTemplate of ["PrincipalSweAgent", "UiArchitectAgent", "GraphicsEngineerAgent", "ResearcherAgent", "AdStrategistAgent", "DesignerAgent", "DocumentAgent", "DevOpsAgent"]) {
        expect(selectAgentTemplate({ capability: "files", agentTemplate })).toBe(agentTemplate);
      }
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
