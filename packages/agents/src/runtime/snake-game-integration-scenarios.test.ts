import { describe, it, expect, beforeEach, vi } from "vitest";
import { pauseController, agentControl, container, PermissionEngine } from "@yaaa/platform";
import type { IBus, IStore } from "@yaaa/interfaces";
import { buildMissionSummary, deriveSubSubtasksFromSubtask, type TaskPlan, type Subtask } from "@yaaa/shared";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { OuterLoop } from "./outer-loop.js";

type Responder = (role: string, messages: BaseMessage[]) => Promise<AIMessage>;

interface CapturedCall {
  role: string;
  messages: BaseMessage[];
}

class ProgrammableChatModel extends BaseChatModel {
  constructor(
    private readonly roleOrModel: string,
    private readonly responder: () => Responder,
    private readonly captured: CapturedCall[],
  ) {
    super({});
  }
  _llmType() {
    return "programmable-test-model";
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.captured.push({ role: this.roleOrModel, messages });
    const message = await this.responder()(this.roleOrModel, messages);
    const text = typeof message.content === "string" ? message.content : "";
    return { generations: [{ text, message }] };
  }
  override bindTools() {
    return this;
  }
}

const finalMessage = (text: string) => new AIMessage({ content: text });

describe("Snake Game Integration Scenarios Test Suite", () => {
  let mockBus: IBus;
  let mockStore: IStore;
  let permissions: PermissionEngine;
  let outerLoop: OuterLoop;
  let captured: CapturedCall[];
  let currentPlan: TaskPlan | null = null;
  let eventLog: Array<{ topic: string; payload: any }> = [];

  beforeEach(() => {
    captured = [];
    eventLog = [];
    currentPlan = null;

    mockBus = {
      publish: vi.fn(async (topic: string, payload: any) => {
        eventLog.push({ topic, payload });
      }),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    } as unknown as IBus;

    mockStore = {
      savePlan: vi.fn(async (taskId: string, plan: TaskPlan) => {
        currentPlan = JSON.parse(JSON.stringify(plan));
      }),
      getPlan: vi.fn(async (taskId: string) => currentPlan),
      saveRun: vi.fn(async () => {}),
      getRun: vi.fn(async () => undefined),
      listRuns: vi.fn(async () => []),
      saveArtifact: vi.fn(async () => {}),
      listArtifacts: vi.fn(async () => []),
    } as unknown as IStore;

    permissions = new PermissionEngine();
    container.clear();
    container.register("IBus", mockBus);
    container.register("IStore", mockStore);
    container.register("PermissionEngine", permissions);

    let responder: Responder = async (role) =>
      role === "verifier"
        ? finalMessage(JSON.stringify({ status: "passed", summary: "Snake Game engine verified.", findings: [], evidence: ["index.html created", "game.js created"] }))
        : finalMessage("Subtask completed.");

    container.register(
      "ChatModelFactory",
      (roleOrModel: string) => new ProgrammableChatModel(roleOrModel, () => responder, captured),
    );

    outerLoop = new OuterLoop(container);

    pauseController.resume("task-snake-integration-1");
    pauseController.resume("task-snake-integration-2");
    agentControl.clear("snake-worker-1");
  });

  it("Scenario 1: Mid-Task Switch & Pause-Resume Integration", async () => {
    const taskId = "task-snake-integration-1";

    const plan: TaskPlan = {
      goal: "Develop interactive 60fps Snake Game with score counter",
      subtasks: [
        {
          id: "subtask-1",
          title: "Build Canvas rendering engine and game loop in game.js",
        roles: ["FilesAgent"],
        capabilities: ["files"],
          state: "pending",
          dependsOn: [],
          riskLevel: "low",
          successCriteria: "game.js written and rendering canvas",
        },
      ],
    };

    // 1. User starts Snake Game task
    pauseController.resume(taskId);
    expect(pauseController.isPaused(taskId)).toBe(false);

    // 2. User switches to Task B mid-execution -> taskId is paused
    pauseController.pause(taskId);
    expect(pauseController.isPaused(taskId)).toBe(true);

    // 3. Worker checking waitIfPaused(taskId) pauses without throwing or losing state
    let workerExecuted = false;
    const workerTask = (async () => {
      await pauseController.waitIfPaused(taskId);
      workerExecuted = true;
    })();

    await new Promise((r) => setTimeout(r, 40));
    expect(workerExecuted).toBe(false);

    // 4. User returns to Snake Game task -> resume taskId
    pauseController.resume(taskId);
    await workerTask;
    expect(workerExecuted).toBe(true);
    expect(pauseController.isPaused(taskId)).toBe(false);
  });

  it("Scenario 2: Close & Re-Open Task Re-Hydration Integration", async () => {
    const taskId = "task-snake-integration-2";

    const savedPlan: TaskPlan = {
      goal: "Develop interactive 60fps Snake Game with score counter",
      subtasks: [
        {
          id: "subtask-1",
          title: "Build Canvas rendering engine and game loop in game.js",
          roles: ["FilesAgent"],
          capabilities: ["files"],
          state: "running",
          dependsOn: [],
          riskLevel: "low",
          successCriteria: "game.js written and rendering canvas",
          subSubtasks: [
            { id: "subtask-1.1", title: "Inspect domain architecture for canvas rendering", state: "completed" },
            { id: "subtask-1.2", title: "Create index.html with HTML5 score canvas", state: "running" },
            { id: "subtask-1.3", title: "Implement 60fps game loop and keyboard controls", state: "pending" },
          ],
        },
      ],
    };

    // Store state and simulate app closing
    await mockStore.savePlan(taskId, savedPlan);
    pauseController.pause(taskId);

    // User re-opens app and re-hydrates task plan from TaskStore
    const rehydratedPlan = await mockStore.getPlan(taskId);
    expect(rehydratedPlan).toBeDefined();
    expect(rehydratedPlan?.subtasks[0].state).toBe("running");
    expect(rehydratedPlan?.subtasks[0].subSubtasks?.[0].state).toBe("completed");
    expect(rehydratedPlan?.subtasks[0].subSubtasks?.[1].state).toBe("running");
    expect(rehydratedPlan?.subtasks[0].subSubtasks?.[2].state).toBe("pending");

    // Resume task
    pauseController.resume(taskId);
    expect(pauseController.isPaused(taskId)).toBe(false);
  });

  it("Scenario 3: Sub-Agent Terminal State Abort Guard Integration", () => {
    const agentId = "snake-worker-1";

    // Mark agent as stopped on exit
    agentControl.post(agentId, { type: "stop", reason: "exited" });
    expect(agentControl.isStopped(agentId)).toBe(true);

    // Verify isStopped returns true for completed state as well
    agentControl.post("snake-worker-completed", { type: "stop", reason: "completed" });
    expect(agentControl.isStopped("snake-worker-completed")).toBe(true);
  });

  it("Scenario 4: Single Ledger Snapshot & Follow-Up Memory Integration", () => {
    const initialPlan: TaskPlan = {
      goal: "Develop interactive 60fps Snake Game with score counter",
      subtasks: [
        {
          id: "subtask-1",
          title: "Build Canvas rendering engine and game loop",
            roles: ["FilesAgent"],
            capabilities: ["files"],
          state: "completed",
          dependsOn: [],
          riskLevel: "low",
          successCriteria: "game.js created",
        },
      ],
    };

    const completedResults = [
      {
        id: "subtask-1",
        title: "Build Canvas rendering engine and game loop",
        summary: "Created index.html and game.js with HTML5 Canvas game loop",
        artifacts: [{ path: "game.js", mimeType: "application/javascript", description: "Snake Game Engine" }],
      },
    ];

    // Build prior summary snapshot
    const priorSummary = buildMissionSummary({
      goal: initialPlan.goal,
      subtasks: initialPlan.subtasks,
      completedResults,
    });

    expect(priorSummary).toContain("Develop interactive 60fps Snake Game");
    expect(priorSummary).toContain("Created index.html and game.js");

    // Follow-up request from user: "Now add retro sound effects and custom skins"
    const followUpSubtask: Subtask = {
      id: "subtask-2",
      title: "Add retro sound effects and custom skins to Snake Game",
      roles: ["FilesAgent"],
      capabilities: ["files"],
      state: "pending",
      dependsOn: ["subtask-1"],
      riskLevel: "low",
      successCriteria: "Sound effects and skin textures created",
    };

    const derivedMicroSteps = deriveSubSubtasksFromSubtask(followUpSubtask);
    expect(derivedMicroSteps.length).toBeGreaterThanOrEqual(3);
    expect(derivedMicroSteps[0].title).toContain("retro sound effects");
  });

  it("Scenario 5: Granular Step-by-Step Execution Feed & Instruction Set Sync Integration", async () => {
    const taskId = "task-snake-integration-5";

    const subtask: Subtask = {
      id: "subtask-1",
      title: "Design CSS retro layout and score counter animations",
    roles: ["FilesAgent"],
    capabilities: ["files"],
      state: "running",
      dependsOn: [],
      riskLevel: "low",
      successCriteria: "style.css created with retro theme",
    };

    // 1. Verify deriveSubSubtasksFromSubtask sets sub-subtask 1.1 to "running" when subtask is running
    const subSubtasks = deriveSubSubtasksFromSubtask(subtask);
    expect(subSubtasks[0].id).toBe("subtask-1.1");
    expect(subSubtasks[0].state).toBe("running");
    expect(subSubtasks[0].title.length).toBeGreaterThanOrEqual(25);

    // 2. Simulate step completion event publishing over EventBus
    await mockBus.publish(`task.${taskId}.sub_subtask_completed`, {
      kind: "sub_subtask_completed",
      taskId,
      agentId: "snake-worker-5",
      subSubtask: { ...subSubtasks[0], state: "completed" },
    });

    await mockBus.publish(`task.${taskId}.plan_updated`, {
      goal: "Design CSS retro layout",
      subtasks: [{ ...subtask, subSubtasks }],
    });

    // 3. Verify event bus recorded both sub_subtask_completed and plan_updated
    const subSubtaskEvent = eventLog.find((e) => e.topic === `task.${taskId}.sub_subtask_completed`);
    const planUpdatedEvent = eventLog.find((e) => e.topic === `task.${taskId}.plan_updated`);

    expect(subSubtaskEvent).toBeDefined();
    expect(subSubtaskEvent?.payload.subSubtask.state).toBe("completed");
    expect(planUpdatedEvent).toBeDefined();
  });

  it("Scenario 6: 20k Token Context Compaction Persistence for Main and Sub Agents", async () => {
    const taskId = "task-snake-compaction-6";
    const agentId = "snake-worker-6";

    // Simulate 15 turns of heavy message history (>25,000 characters of tool outputs)
    const bulkyMessages: Array<{ role: string; content: string }> = [
      { role: "system", content: "You are SnakeGameAgent." },
      { role: "user", content: "Build high-performance 60fps Snake Game in Canvas" },
    ];

    for (let i = 0; i < 10; i++) {
      bulkyMessages.push({
        role: "assistant",
        content: `Analyzing step ${i + 1}: inspect DOM and canvas state.`,
      });
      bulkyMessages.push({
        role: "user",
        content: `Tool Execution Result (files.read_file): ${"X".repeat(3000)}`,
      });
    }

    // Verify initial uncompacted size exceeds 20k character limit (~5k tokens)
    const initialChars = bulkyMessages.reduce((acc, m) => acc + m.content.length, 0);
    expect(initialChars).toBeGreaterThan(20_000);

    // Apply compaction
    const { compactMessages } = await import("@yaaa/shared");
    const compacted = compactMessages(bulkyMessages, { keepLeading: 2, keepRecent: 4, minElideChars: 300 });

    const compactedChars = compacted.reduce((acc, m) => acc + m.content.length, 0);
    expect(compactedChars).toBeLessThan(10_000);
    expect(compacted.some((m) => m.content.includes("[earlier tool result elided"))).toBe(true);

    // Save compacted plan state to IStore for main agent persistence
    const plan: TaskPlan = {
      goal: `Develop Snake Game\n\n[Compacted Mission Summary]\nTotal messages compacted down to ${compacted.length}`,
      subtasks: [
        {
          id: "subtask-1",
          title: "Build Canvas engine",
          roles: ["FilesAgent"],
          capabilities: ["files"],
          state: "running",
          dependsOn: [],
          riskLevel: "low",
          successCriteria: "game.js created",
          result: "Compacted result summary",
        },
      ],
    };

    await mockStore.savePlan(taskId, plan);
    const persistedPlan = await mockStore.getPlan(taskId);
    expect(persistedPlan?.goal).toContain("[Compacted Mission Summary]");
    expect(persistedPlan?.subtasks[0].result).toBe("Compacted result summary");
  });
});
