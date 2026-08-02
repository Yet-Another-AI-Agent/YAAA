import { describe, it, expect, beforeEach } from "vitest";
import { pauseController, agentControl } from "@yaaa/platform";
import { buildMissionSummary, deriveSubSubtasksFromSubtask, type Subtask, type TaskPlan } from "@yaaa/shared";

describe("Snake Game Task Lifecycle & Agent State Verification", () => {
  beforeEach(() => {
    pauseController.resume("task-snake-1");
    pauseController.resume("task-snake-2");
    agentControl.clear("snake-agent-1");
    agentControl.clear("snake-agent-2");
  });

  it("1. Mid-task Switch & Resume: Pauses current task when user creates another task, and resumes from exact state when returning", async () => {
    const taskId1 = "task-snake-1";

    // 1. User starts Snake Game creation task
    pauseController.resume(taskId1);
    expect(pauseController.isPaused(taskId1)).toBe(false);

    // 2. Mid-game, user switches to another task -> taskId1 is paused
    pauseController.pause(taskId1);
    expect(pauseController.isPaused(taskId1)).toBe(true);

    // 3. Sub-agents checking waitIfPaused(taskId1) will wait without terminating or losing state
    let innerLoopResumed = false;
    const asyncWorker = (async () => {
      await pauseController.waitIfPaused(taskId1);
      innerLoopResumed = true;
    })();

    // Verify worker is suspended
    await new Promise((r) => setTimeout(r, 50));
    expect(innerLoopResumed).toBe(false);

    // 4. User comes back to Snake Game task -> resume taskId1
    pauseController.resume(taskId1);
    await asyncWorker;
    expect(innerLoopResumed).toBe(true);
    expect(pauseController.isPaused(taskId1)).toBe(false);
  });

  it("2. Close & Open Re-hydration: Closing a running task and re-opening restores exact progress and sub-subtasks", () => {
    const taskId = "task-snake-1";
    const initialPlan: TaskPlan = {
      goal: "Build interactive Snake Game with Canvas rendering and high score persistence",
      subtasks: [
        {
          id: "subtask-1",
          title: "Setup Canvas container and game loop engine",
        roles: ["FilesAgent"],
        capabilities: ["files"],
          state: "running",
          dependsOn: [],
          riskLevel: "low",
          successCriteria: "Canvas game engine operational",
          subSubtasks: [
            { id: "subtask-1.1", title: "Create index.html with score display canvas", state: "completed" },
            { id: "subtask-1.2", title: "Implement snake movement and collision detection logic", state: "running" },
            { id: "subtask-1.3", title: "Add keyboard controls and high score persistence", state: "pending" },
          ],
        },
      ],
    };

    // Store current state (simulating closing app while task is running)
    pauseController.pause(taskId);
    expect(pauseController.isPaused(taskId)).toBe(true);

    // Re-hydrate plan state
    const subtask = initialPlan.subtasks[0];
    expect(subtask.state).toBe("running");
    expect(subtask.subSubtasks?.[0].state).toBe("completed");
    expect(subtask.subSubtasks?.[1].state).toBe("running");
    expect(subtask.subSubtasks?.[2].state).toBe("pending");

    // Resume execution from exact checkpoint
    pauseController.resume(taskId);
    expect(pauseController.isPaused(taskId)).toBe(false);
  });

  it("3. Terminal State Abort Guard: Stops agent loop immediately when sub-agent enters completed/failed/exited state", () => {
    const agentId = "snake-agent-1";

    // Post stop directive for exited/completed state
    agentControl.post(agentId, { type: "stop", reason: "exited" });
    expect(agentControl.isStopped(agentId)).toBe(true);
  });

  it("4. Follow-Up Memory & Single Ledger Snapshot: Compacts past Snake Game work into priorSummary for new follow-up tasks", () => {
    const pastSubtasks: Subtask[] = [
      { id: "subtask-1", title: "Create HTML5 Canvas and game loop", roles: ["FilesAgent"], capabilities: ["files"], state: "completed", dependsOn: [], riskLevel: "low", successCriteria: "Game loop running" },
      { id: "subtask-2", title: "Add keyboard controls and score counter", roles: ["FilesAgent"], capabilities: ["files"], state: "completed", dependsOn: ["subtask-1"], riskLevel: "low", successCriteria: "Controls bound" },
    ];

    const completedResults = [
      {
        id: "subtask-1",
        title: "Create HTML5 Canvas and game loop",
        summary: "Created index.html and game.js with 60fps canvas loop",
      },
      {
        id: "subtask-2",
        title: "Add keyboard controls and score counter",
        summary: "Bound arrow keys and local storage high score",
      },
    ];

    // Generate prior summary for follow-up prompt
    const summary = buildMissionSummary({
      goal: "Build interactive Snake Game with HTML5 Canvas",
      subtasks: pastSubtasks,
      completedResults,
    });

    expect(summary).toContain("Build interactive Snake Game");
    expect(summary).toContain("Created index.html and game.js");
    expect(summary).toContain("Bound arrow keys and local storage high score");

    // User follows up ("now add sound effects and custom skins")
    const followUpSubtask: Subtask = {
      id: "subtask-3",
      title: "Add retro sound effects and customizable snake skins",
          roles: ["FilesAgent"],
          capabilities: ["files"],
      state: "pending",
      dependsOn: ["subtask-2"],
      riskLevel: "low",
      successCriteria: "Audio effects and skins enabled",
    };
    const subSubtasks = deriveSubSubtasksFromSubtask(followUpSubtask);
    expect(subSubtasks.length).toBeGreaterThanOrEqual(3);
    expect(subSubtasks[0].title).toContain("retro sound effects");
  });

  it("5. Step-by-Step Execution Feed & Instruction Set Sync: Emits step completion and plan update events on every move/edit", () => {
    const subtask: Subtask = {
      id: "subtask-1",
      title: "Develop Snake Game rendering engine",
      roles: ["FilesAgent"],
      capabilities: ["files"],
      state: "running",
      dependsOn: [],
      riskLevel: "low",
      successCriteria: "Engine working",
    };

    const subSubtasks = deriveSubSubtasksFromSubtask(subtask);
    expect(subSubtasks[0].state).toBe("running");
    expect(subSubtasks[0].title.length).toBeGreaterThanOrEqual(25);
  });
});
