import { describe, it, expect } from "vitest";
import { SKILL_REGISTRY, getSkill, getMatchingSkills } from "./skill-registry.js";
import { buildAgentBrief } from "../mission-context.js";

describe("Skills System Test Suite", () => {
  it("1. Loads and registers all specialized skills with full documentation", () => {
    const categories = ["ppt", "pdf", "web-access", "word", "canvas", "3d-graphics", "chart", "code-generation"] as const;
    
    for (const cat of categories) {
      const skill = SKILL_REGISTRY[cat];
      expect(skill).toBeDefined();
      expect(skill.id).toBe(`${cat}-skill`);
      expect(skill.name).toBeTruthy();
      expect(skill.description).toBeTruthy();
      expect(skill.content).toContain("# ");
      expect(skill.content).toContain("Advanced Reference Documentation & Links");
      expect(skill.content).toContain("http");
      expect(skill.content.length).toBeGreaterThan(100);
    }
  });

  it("2. Looks up skills by ID or category name via getSkill", () => {
    const pptSkill = getSkill("ppt");
    expect(pptSkill).toBeDefined();
    expect(pptSkill?.id).toBe("ppt-skill");
    expect(pptSkill?.content).toContain("PptxGenJS");

    const pdfSkill = getSkill("pdf-skill");
    expect(pdfSkill).toBeDefined();
    expect(pdfSkill?.category).toBe("pdf");
    expect(pdfSkill?.content).toContain("PDFKit");

    const webSkill = getSkill("web-access");
    expect(webSkill).toBeDefined();
    expect(webSkill?.content).toContain("browser_navigate_and_wait");

    const wordSkill = getSkill("word");
    expect(wordSkill).toBeDefined();
    expect(wordSkill?.content).toContain("docx");

    const canvasSkill = getSkill("canvas");
    expect(canvasSkill).toBeDefined();
    expect(canvasSkill?.content).toContain("HTML5 Canvas");

    const threeDSkill = getSkill("3d-graphics");
    expect(threeDSkill).toBeDefined();
    expect(threeDSkill?.content).toContain("Three.js");

    const chartSkill = getSkill("chart");
    expect(chartSkill).toBeDefined();
    expect(chartSkill?.content).toContain("Chart.js");

    const codeSkill = getSkill("code-generation");
    expect(codeSkill?.id).toBe("code-generation-skill");
    expect(codeSkill?.content).toContain("scope");
  });

  it("3. Auto-detects matching skills from subtask goals and capabilities via getMatchingSkills", () => {
    const slideMatches = getMatchingSkills("Build PowerPoint presentation slides for executive review");
    expect(slideMatches.some((s) => s.category === "ppt")).toBe(true);

    const docMatches = getMatchingSkills("Generate PDF audit report and Word doc documentation");
    expect(docMatches.some((s) => s.category === "pdf")).toBe(true);
    expect(docMatches.some((s) => s.category === "word")).toBe(true);

    const webMatches = getMatchingSkills("Navigate website and test SPA history state");
    expect(webMatches.some((s) => s.category === "web-access")).toBe(true);

    const graphicMatches = getMatchingSkills("Draw 2D canvas sprite and WebGL 3D graphics model");
    expect(graphicMatches.some((s) => s.category === "canvas")).toBe(true);
    expect(graphicMatches.some((s) => s.category === "3d-graphics")).toBe(true);

    const chartMatches = getMatchingSkills("Create bar chart and line graph latency visualizations");
    expect(chartMatches.some((s) => s.category === "chart")).toBe(true);
  });

  it("does not infer unrelated 3D or chart skills from generic game wording", () => {
    const gameMatches = getMatchingSkills(
      "Build a Phaser 2D browser game with programmatic graphics and a battle UI",
    );
    expect(gameMatches.some((skill) => skill.category === "canvas")).toBe(true);
    expect(gameMatches.some((skill) => skill.category === "3d-graphics")).toBe(false);
    expect(gameMatches.some((skill) => skill.category === "chart")).toBe(false);
    expect(gameMatches.some((skill) => skill.category === "code-generation")).toBe(true);
  });

  it("does not infer Word or PDF skills from agent role names", () => {
    expect(getMatchingSkills("Generate a 5-slide PowerPoint presentation for children").map((skill) => skill.id)).toEqual(["ppt-skill"]);
    expect(getMatchingSkills("Generate a 5-slide PowerPoint presentation for children DocumentAgent files shell").map((skill) => skill.id)).toEqual(["ppt-skill"]);
  });

  it("requires explicit 3D or chart terminology", () => {
    const uiMatches = getMatchingSkills("Implement a graphics-heavy UI");
    expect(uiMatches.some((skill) => skill.category === "code-generation")).toBe(true);
    expect(uiMatches.some((skill) => skill.category === "3d-graphics")).toBe(false);
    expect(uiMatches.some((skill) => skill.category === "chart")).toBe(false);
    expect(getMatchingSkills("Draw a 3D WebGL scene with Three.js").some((skill) => skill.category === "3d-graphics")).toBe(true);
    expect(getMatchingSkills("Render a bar chart").some((skill) => skill.category === "chart")).toBe(true);
    expect(getMatchingSkills("Render a progress bar and draw a line between nodes")).toEqual([]);
  });

  it("4. Injects Provided Skills & Technical Documentation into buildAgentBrief prompt", () => {
    const pptSkill = SKILL_REGISTRY.ppt;
    const chartSkill = SKILL_REGISTRY.chart;

    const brief = buildAgentBrief({
      missionGoal: "Build Executive Analytics Dashboard",
      subtaskTitle: "Create PowerPoint slides with performance charts",
      successCriteria: "presentation.pptx generated",
      skills: [pptSkill, chartSkill],
    });

    expect(brief).toContain("## Provided Skills & Technical Documentation");
    expect(brief).toContain("PowerPoint Generation Skill (ppt)");
    expect(brief).toContain("Chart Generation Skill (chart)");
    expect(brief).toContain("PptxGenJS");
    expect(brief).toContain("Chart.js");
  });

  it("keeps the complete mission context ahead of a terse micro-step", () => {
    const brief = buildAgentBrief({
      missionGoal: "Create a 5-slide educational Betta fish PowerPoint for children",
      subtaskTitle: "Draft content",
      successCriteria: "The final deck contains five age-appropriate slides and is saved as betta_fish.pptx",
      subSubtasks: [
        { id: "subtask-1.1", title: "Run the required build or test for Draft content", state: "running" },
      ],
    });

    const glance = brief.indexOf("## Assignment at a glance");
    expect(glance).toBeGreaterThanOrEqual(0);
    expect(glance).toBeLessThan(brief.indexOf("## Your subtask"));
    expect(brief.slice(glance, glance + 700)).toContain("Create a 5-slide educational Betta fish PowerPoint for children");
    expect(brief.slice(glance, glance + 700)).toContain("betta_fish.pptx");
    expect(brief).toContain("Do not claim that context is missing");
  });
});
