import { describe, it, expect } from "vitest";
import {
  buildAgentBrief,
  buildMissionSummary,
  budgetLines,
  DEFAULT_MAX_DEPENDENCY_CHARS,
  type DependencyOutput,
} from "./mission-context.js";

describe("budgetLines", () => {
  it("keeps every line when under budget", () => {
    const out = budgetLines(["a", "b", "c"], 1000);
    expect(out).toBe("a\nb\nc");
  });

  it("drops overflow lines and records how many were omitted", () => {
    const lines = ["11111", "22222", "33333", "44444"];
    const out = budgetLines(lines, 12); // fits ~2 lines
    expect(out).toContain("11111");
    expect(out).toMatch(/omitted to fit the context budget/);
    expect(out).not.toContain("44444");
  });

  it("hard-truncates a single over-long line so one always survives", () => {
    const out = budgetLines(["x".repeat(100)], 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("uses singular wording when exactly one line is dropped", () => {
    const out = budgetLines(["aaaa", "bbbb"], 6);
    expect(out).toContain("1 earlier dependency result omitted");
  });
});

describe("buildAgentBrief", () => {
  const base = {
    missionGoal: "Build a hello-world Python script",
    subtaskTitle: "Create hello_world.py",
    successCriteria: "hello_world.py prints 'Hello, World!'",
  };

  it("threads the mission goal, subtask, and success criteria into the brief", () => {
    const brief = buildAgentBrief(base);
    expect(brief).toContain("## Mission goal\nBuild a hello-world Python script");
    expect(brief).toContain("## Your subtask\nCreate hello_world.py");
    expect(brief).toContain("hello_world.py prints 'Hello, World!'");
  });

  it("renders completed dependency results", () => {
    const dependencyOutputs: DependencyOutput[] = [
      {
        id: "subtask-1",
        title: "Write the script",
        summary: "Created hello_world.py",
        artifacts: [{ path: "agent-workspaces/a/handOff.md", mimeType: "text/markdown", description: "Continuation handoff" }],
      },
    ];
    const brief = buildAgentBrief({ ...base, dependencyOutputs });
    expect(brief).toContain("## Results from completed dependencies");
    expect(brief).toContain("[subtask-1] Write the script: Created hello_world.py");
    expect(brief).toContain("agent-workspaces/a/handOff.md");
  });

  it("renders the hands-on, proof, and handoff contract paths", () => {
    const brief = buildAgentBrief({
      ...base,
      handsOnPath: "agent-workspaces/a/handsOn.md",
      proofOfWorkPath: "agent-workspaces/a/proofOfWork.md",
      handOffPath: "agent-workspaces/a/handOff.md",
    });
    expect(brief).toContain("## Handoff contract");
    expect(brief).toContain("agent-workspaces/a/handsOn.md");
    expect(brief).toContain("agent-workspaces/a/proofOfWork.md");
    expect(brief).toContain("agent-workspaces/a/handOff.md");
  });

  it("states there are no dependencies yet for early steps", () => {
    const brief = buildAgentBrief(base);
    expect(brief).toContain("None yet — this is an early step");
  });

  it("preserves the retry directive verbatim (kill-switch wording)", () => {
    const brief = buildAgentBrief({
      ...base,
      retryDirective: 'Attempt a COMPLETELY DIFFERENT approach.',
    });
    expect(brief).toContain("COMPLETELY DIFFERENT");
    // The directive leads the brief so the model sees it first.
    expect(brief.indexOf("COMPLETELY DIFFERENT")).toBeLessThan(brief.indexOf("## Mission goal"));
  });

  it("budgets the dependency section", () => {
    const many: DependencyOutput[] = Array.from({ length: 50 }, (_, i) => ({
      id: `subtask-${i}`,
      title: `Task ${i}`,
      summary: "x".repeat(500),
    }));
    const brief = buildAgentBrief({ ...base, dependencyOutputs: many, maxDependencyChars: 2000 });
    expect(brief).toMatch(/omitted to fit the context budget/);
    // The whole brief stays far under the naive concatenation size.
    expect(brief.length).toBeLessThan(50 * 500);
  });

  it("falls back gracefully when fields are blank", () => {
    const brief = buildAgentBrief({ missionGoal: "", subtaskTitle: "", successCriteria: "" });
    expect(brief).toContain("(not specified)");
  });

  it("exposes a sane default budget", () => {
    expect(DEFAULT_MAX_DEPENDENCY_CHARS).toBeGreaterThan(1000);
  });
});

describe("buildMissionSummary", () => {
  it("summarizes goal, progress, and key results", () => {
    const summary = buildMissionSummary({
      goal: "Ship the login page",
      subtasks: [
        { id: "s1", title: "Build the form", state: "completed" },
        { id: "s2", title: "Wire auth", state: "failed" },
      ],
      completedResults: [{ id: "s1", title: "Build the form", summary: "Created LoginForm.tsx" }],
    });
    expect(summary).toContain("Original goal: Ship the login page");
    expect(summary).toContain("[completed] Build the form");
    expect(summary).toContain("[failed] Wire auth");
    expect(summary).toContain("Created LoginForm.tsx");
  });

  it("handles a bare goal with no progress yet", () => {
    const summary = buildMissionSummary({ goal: "Do a thing" });
    expect(summary).toBe("Original goal: Do a thing");
  });

  it("stays within budget for large missions", () => {
    const subtasks = Array.from({ length: 100 }, (_, i) => ({
      id: `s${i}`,
      title: "t".repeat(100),
      state: "completed",
    }));
    const summary = buildMissionSummary({ goal: "big", subtasks, maxChars: 1000 });
    expect(summary.length).toBeLessThan(2000);
  });
});
