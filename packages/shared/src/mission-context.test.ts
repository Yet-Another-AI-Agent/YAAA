import { describe, it, expect } from "vitest";
import {
  assembleContextPacket,
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

  it("renders the hands-on and handoff contract paths", () => {
    const brief = buildAgentBrief({
      ...base,
      handsOnPath: "agent-workspaces/a/handsOn.md",
      handOffPath: "agent-workspaces/a/handOff.md",
    });
    expect(brief).toContain("## Handoff contract");
    expect(brief).toContain("agent-workspaces/a/handsOn.md");
    expect(brief).toContain("agent-workspaces/a/handOff.md");
  });

  it("requires an exit checklist before the agent stops", () => {
    const brief = buildAgentBrief({
      ...base,
      handOffPath: "agent-workspaces/a/handOff.md",
    });
    expect(brief).toContain("## Exit checklist");
    expect(brief).toContain("deliverable exists as a concrete file/artifact");
    expect(brief).toContain("Do not exit immediately after web.search");
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

  it("renders the planner-owned sequential action contract without dumping history", () => {
    const brief = buildAgentBrief({
      ...base,
      executionContract: {
        requiredArtifacts: ["index.html", "game.js"],
        targetWorkspace: "the canonical task workspace",
        expectedNextActions: ["read graph scope", "write missing files"],
        dependencyGraph: [{ subtaskId: "task-1", dependsOn: [] }],
        preflight: { runOncePerAssignment: true, targetPaths: ["game.js"] },
        completionSignals: ["Both files exist"],
        noProgress: { correctionAfter: 1, stopAfter: 2 },
        actionQueue: { useWhen: ["dependent file operations"], maxActions: 4, maxDepth: 2, stopOnError: true },
        verificationSurface: "files",
      },
    });
    expect(brief).toContain("## Execution contract");
    expect(brief).toContain("Expected next actions: read graph scope; write missing files");
    expect(brief).toContain("max 4 actions, depth 2");
  });

  it("fits a planner-selected context budget while retaining the assignment contract", () => {
    const brief = buildAgentBrief({
      ...base,
      maxContextChars: 900,
      dependencyOutputs: [{ id: "s1", title: "Large dependency", summary: "x".repeat(3000) }],
      workspaceArtifactPaths: Array.from({ length: 20 }, (_, i) => `generated/${i}.js`),
    });
    expect(brief.length).toBeLessThanOrEqual(900);
    expect(brief).toContain("## Mission goal");
    expect(brief).toContain("## Success criteria");
    expect(brief).toContain("## Exit checklist");
  });

  it("does not leak verifier-only evidence or unrelated durable sections into a worker packet", () => {
    const packet = assembleContextPacket({
      role: "worker",
      missionGoal: "Build the requested app",
      subtaskTitle: "Implement the app shell",
      successCriteria: "The app shell exists",
      subSubtasks: [
        { id: "shell.1", title: "Create the app shell", state: "running" },
        { id: "shell.2", title: "Verify the app shell", state: "pending" },
      ],
      dependencyOutputs: [{ id: "unrelated", title: "Unrelated sibling", summary: "x".repeat(20_000) }],
      workspaceArtifactPaths: ["app/index.html", "private/transcript.json"],
      skills: [{ id: "canvas", name: "Canvas", category: "graphics", description: "Draw shapes" } as any],
      contextPolicy: {
        maxInputTokens: 1_000,
        maxDependencyChars: 200,
        maxHistoryTurns: 2,
        maxFileExcerptLines: 40,
        includeFullSkillDocs: false,
        allowOnDemandReads: true,
        allowedTools: ["read_file"],
      },
    });

    expect(packet.role).toBe("worker");
    expect(packet.activeStep).toContain("shell.1");
    expect(packet.dependencySummary[0].length).toBeLessThan(300);
    expect(packet.omittedSections).toContain("full-transcript");
    expect(packet.omittedSections).toContain("full-skill-documents");
    expect(packet.omittedSections).toContain("unrelated-sibling-results");
    expect(packet.omittedSections).not.toContain("verification-target");
  });

  it("retains the assignment contract when a large durable packet is hard-capped", () => {
    const brief = buildAgentBrief({
      role: "worker",
      missionGoal: "Ship the feature",
      subtaskTitle: "Implement the bounded change",
      successCriteria: "The targeted file passes its checks",
      dependencyOutputs: Array.from({ length: 40 }, (_, index) => ({
        id: `dependency-${index}`,
        title: `Dependency ${index}`,
        summary: "large result ".repeat(500),
      })),
      skills: Array.from({ length: 10 }, (_, index) => ({
        id: `skill-${index}`,
        name: `Skill ${index}`,
        category: "code",
        description: "skill description",
        content: "full skill document ".repeat(500),
      } as any)),
      contextPolicy: {
        maxInputTokens: 750,
        maxDependencyChars: 400,
        maxHistoryTurns: 1,
        maxFileExcerptLines: 20,
        includeFullSkillDocs: false,
        allowOnDemandReads: true,
        allowedTools: [],
      },
      maxContextChars: 1_200,
    });

    expect(brief.length).toBeLessThanOrEqual(1_200);
    expect(brief).toContain("## Mission goal");
    expect(brief).toContain("## Your subtask");
    expect(brief).toContain("## Success criteria");
    expect(brief).toContain("## Exit checklist");
    expect(brief).toContain("durable mission state remains persisted");
    expect(brief).not.toContain("full skill document");
  });
});

describe("assembleContextPacket", () => {
  it("selects role-specific durable facts without copying the transcript", () => {
    const packet = assembleContextPacket({
      role: "verifier",
      missionGoal: "Ship the game",
      subtaskTitle: "Verify the battle screen",
      successCriteria: "The battle screen is reachable",
      subSubtasks: [{ id: "s.1", title: "Open the app", state: "running" }],
      dependencyOutputs: [{ id: "s", title: "Build", summary: "Created game.js" }],
      skills: [{ id: "browser", name: "Browser", category: "browser", description: "Inspect pages", content: "full docs" } as any],
      contextPolicy: {
        maxInputTokens: 6000,
        maxDependencyChars: 3000,
        maxHistoryTurns: 4,
        maxFileExcerptLines: 120,
        includeFullSkillDocs: false,
        allowOnDemandReads: true,
        allowedTools: ["open_browser"],
      },
    });
    expect(packet.role).toBe("verifier");
    expect(packet.activeStep).toContain("s.1");
    expect(packet.dependencySummary).toEqual(["[s] Build: Created game.js"]);
    expect(packet.selectedSkillIds).toEqual(["browser"]);
    expect(packet.omittedSections).toContain("full-transcript");
    expect(packet.omittedSections).toContain("full-skill-documents");
    expect(buildAgentBrief({
      role: "verifier",
      missionGoal: "Ship the game",
      subtaskTitle: "Verify the battle screen",
      successCriteria: "The battle screen is reachable",
      executionContract: {
        requiredArtifacts: ["game.js"],
        targetWorkspace: "workspace",
        expectedNextActions: [],
        dependencyGraph: [],
        preflight: { runOncePerAssignment: true, targetPaths: [] },
        completionSignals: ["screen reachable"],
        noProgress: { correctionAfter: 1, stopAfter: 2 },
        actionQueue: { useWhen: [], maxActions: 2, maxDepth: 1, stopOnError: true },
        verificationSurface: "browser",
      },
    })).toContain("## Verification target");
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
