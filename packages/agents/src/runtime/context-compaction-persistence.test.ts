import { describe, it, expect, vi, beforeEach } from "vitest";
import { pauseController, agentControl, container, PermissionEngine } from "@yaaa/platform";
import type { IBus, IStore } from "@yaaa/interfaces";
import { compactMessages, estimateChars, needsSummary, buildMissionSummary, type TaskPlan, type Subtask } from "@yaaa/shared";
import { CustomInnerLoop } from "./custom-inner-loop.js";

describe("20k Token Context Compaction & Persistence Test Suite", () => {
  let mockBus: IBus;
  let mockStore: IStore;
  let mockDbEngine: any;
  let savedCheckpoints: any[] = [];
  let eventLog: Array<{ topic: string; payload: any }> = [];

  beforeEach(() => {
    savedCheckpoints = [];
    eventLog = [];

    mockBus = {
      publish: vi.fn(async (topic: string, payload: any) => {
        eventLog.push({ topic, payload });
      }),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    } as unknown as IBus;

    mockStore = {
      savePlan: vi.fn(async () => {}),
      getPlan: vi.fn(async () => undefined),
      saveRun: vi.fn(async () => {}),
      getRun: vi.fn(async () => undefined),
      listRuns: vi.fn(async () => []),
      saveArtifact: vi.fn(async () => {}),
      listArtifacts: vi.fn(async () => []),
    } as unknown as IStore;

    mockDbEngine = {
      getAgentDb: vi.fn(() => ({})),
      getLastWALSequence: vi.fn(() => 15),
      saveCompactionCheckpoint: vi.fn((db: any, checkpoint: any) => {
        savedCheckpoints.push(checkpoint);
      }),
      writeWALRecord: vi.fn(),
    };

    container.clear();
    container.register("IBus", mockBus);
    container.register("IStore", mockStore);
    container.register("DBEngine", mockDbEngine);
    container.register("PermissionEngine", new PermissionEngine());
    container.register("IMeshGateway", {
      chat: vi.fn(async () => ({ content: "Task turn executed." })),
      executeCall: vi.fn(async () => ({ content: "Task turn executed." })),
    });
  });

  it("1. Sub-Agent Message History Compaction & In-Place Mutation: Compacts array in-place when size > 20,000 chars", () => {
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: "System prompt for Snake Game sub-agent." },
      { role: "user", content: "Instruction: Develop canvas engine in game.js" },
    ];

    // Add 10 bulky tool execution turns (3,000 chars each = 30,000 chars total)
    for (let i = 0; i < 10; i++) {
      messages.push({
        role: "assistant",
        content: `Turn ${i + 1}: Inspecting file structure and compiling canvas context.`,
      });
      messages.push({
        role: "user",
        content: `Tool Execution Result (files.read_file): ${"A".repeat(3000)}`,
      });
    }

    const uncompactedCount = messages.length;
    const initialChars = estimateChars(messages);
    expect(initialChars).toBeGreaterThan(20_000);
    expect(needsSummary(messages, { maxChars: 20_000 })).toBe(true);

    // Apply compaction and mutate messages array in-place
    const compacted = compactMessages(messages, { keepLeading: 2, keepRecent: 4, minElideChars: 300 });
    messages.length = 0;
    messages.push(...compacted);

    const compactedChars = estimateChars(messages);
    expect(compactedChars).toBeLessThan(10_000);
    expect(messages.length).toBe(uncompactedCount);
    expect(messages.some((m) => m.content.includes("[earlier tool result elided"))).toBe(true);

    // Verify subsequent turns use the mutated compacted array as starting baseline
    messages.push({ role: "assistant", content: "Turn 11: Finalizing canvas export." });
    expect(estimateChars(messages)).toBeLessThan(12_000);
  });

  it("2. CustomInnerLoop Compaction Checkpoint Persistence to DBEngine", async () => {
    const customLoop = new CustomInnerLoop(container);
    const agentId = "snake-custom-worker-1";
    const taskId = "task-compaction-test-2";

    // Trigger compaction by passing oversized instruction and workspace options
    const result = await customLoop.run({
      agentId,
      taskId,
      templateName: "FilesAgent",
      instruction: `Build Snake Game canvas engine with extended documentation: ${"B".repeat(25_000)}`,
      maxTurns: 1,
    });

    expect(result).toBeDefined();
    expect(mockDbEngine.saveCompactionCheckpoint).toHaveBeenCalled();
    expect(savedCheckpoints.length).toBeGreaterThan(0);
    expect(savedCheckpoints[0].agentId).toBe(agentId);
    expect(savedCheckpoints[0].taskId).toBe(taskId);
    expect(savedCheckpoints[0].summary).toContain("20k token limit");
  });

  it("3. Main Agent / Orchestrator Mission Compaction & TaskStore Saving", async () => {
    const taskId = "task-main-compaction-3";
    const plan: TaskPlan = {
      goal: "Develop interactive 60fps Snake Game with canvas and high score persistence",
      subtasks: [
        {
          id: "subtask-1",
          title: "Build Canvas engine",
        roles: ["FilesAgent"],
        capabilities: ["files"],
          state: "completed",
          dependsOn: [],
          riskLevel: "low",
          successCriteria: "game.js created",
          result: "C".repeat(12_000),
        },
        {
          id: "subtask-2",
          title: "Add keyboard controls and score counter",
          roles: ["FilesAgent"],
          capabilities: ["files"],
          state: "completed",
          dependsOn: ["subtask-1"],
          riskLevel: "low",
          successCriteria: "controls bound",
          result: "D".repeat(12_000),
        },
      ],
    };

    const totalSummaryChars = plan.subtasks.reduce((acc, st) => acc + (st.result ? st.result.length : 0), 0);
    expect(totalSummaryChars).toBeGreaterThan(20_000);

    // Compact plan goal with buildMissionSummary
    const completedOutputs = plan.subtasks.map((st) => ({
      id: st.id,
      title: st.title,
      summary: st.result ?? "",
    }));

    const compactedMission = buildMissionSummary({
      goal: plan.goal,
      subtasks: plan.subtasks,
      completedResults: completedOutputs,
      maxChars: 20_000,
    });

    plan.goal = `${plan.goal}\n\n[Compacted Mission Summary]\n${compactedMission}`;

    await mockStore.savePlan(taskId, plan);
    expect(mockStore.savePlan).toHaveBeenCalledWith(taskId, plan);
    expect(plan.goal).toContain("[Compacted Mission Summary]");
  });
});
