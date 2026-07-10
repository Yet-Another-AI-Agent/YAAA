import { describe, it, expect, vi, beforeEach } from "vitest";
import { container, PermissionEngine } from "@yaaa/platform";
import type { IBus, IStore, IMeshGateway } from "@yaaa/interfaces";
import { OuterLoop } from "@yaaa/agents";
import { Supervisor } from "./supervisor.js";

describe("Supervisor", () => {
  let mockGateway: IMeshGateway;
  let mockBus: IBus;
  let mockStore: IStore;
  let supervisor: Supervisor;

  beforeEach(() => {
    container.clear();

    mockGateway = {
      chat: vi.fn(),
      chatStream: vi.fn(),
    };

    mockBus = {
      publish: vi.fn(),
      subscribe: vi.fn(),
    };

    mockStore = {
      initTaskDb: vi.fn(),
      saveMessage: vi.fn(),
      getMessages: vi.fn().mockResolvedValue([]),
      savePlan: vi.fn(),
      getPlan: vi.fn(),
      saveLedgerEntry: vi.fn(),
      getLedgerEntries: vi.fn().mockResolvedValue([]),
      saveAuditLog: vi.fn(),
      getAuditLogs: vi.fn().mockResolvedValue([]),
      saveAgent: vi.fn(),
      getAgents: vi.fn().mockResolvedValue([]),
    };

    container.register("IMeshGateway", mockGateway);
    container.register("IBus", mockBus);
    container.register("IStore", mockStore);
    container.register("PermissionEngine", new PermissionEngine());

    supervisor = new Supervisor();
  });

  it("should successfully run the full supervisor workflow", async () => {
    // 1. Mock Planner response
    // 2. Mock Worker Loop response
    // 3. Mock Synthesizer response
    (mockGateway.chat as any).mockImplementation(async (messages: any[], options: any) => {
      if (options.modelRole === "planner") {
        return `\`\`\`json
{
  "goal": "Test goal",
  "subtasks": [
    {
      "id": "task-1",
      "title": "Subtask 1",
      "capability": "files",
      "dependsOn": [],
      "riskLevel": "low",
      "successCriteria": "done",
      "state": "pending"
    }
  ]
}
\`\`\``;
      }
      if (options.modelRole === "worker") {
        return `\`\`\`json
{
  "result": {
    "artifacts": [],
    "summary": "Subtask done"
  }
}
\`\`\``;
      }
      if (options.modelRole === "verifier") {
        return `\`\`\`json
{
  "passed": true,
  "summary": "Task fully verified"
}
\`\`\``;
      }
      return "{}";
    });

    const result = await supervisor.runTask("Test goal");
    expect(result.success).toBe(true);
    expect(result.summary).toBe("Task fully verified");
    expect(mockStore.initTaskDb).toHaveBeenCalled();
  });

  it("creates and persists a draft plan before any agent execution", async () => {
    const plan = {
      goal: "Review before execution",
      subtasks: [],
    };
    (mockGateway.chat as any).mockResolvedValue(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``);
    const runSpy = vi.spyOn(OuterLoop.prototype, "run");

    await expect(supervisor.createPlan("Review before execution", "task-draft")).resolves.toEqual(plan);

    expect(mockStore.savePlan).toHaveBeenCalledWith("task-draft", plan);
    expect(mockBus.publish).toHaveBeenCalledWith("task.task-draft.plan_updated", plan);
    expect(runSpy).not.toHaveBeenCalled();
    runSpy.mockRestore();
  });

  it("should handle failures during task execution and return success: false", async () => {
    // 1. Mock Planner response
    (mockGateway.chat as any).mockResolvedValue(`\`\`\`json
{
  "goal": "Test goal",
  "subtasks": [
    {
      "id": "task-1",
      "title": "Subtask 1",
      "capability": "files",
      "dependsOn": [],
      "riskLevel": "low",
      "successCriteria": "done",
      "state": "pending"
    }
  ]
}
\`\`\``);

    // Mock OuterLoop to throw an error to hit the Supervisor catch block
    const runSpy = vi.spyOn(OuterLoop.prototype, "run").mockRejectedValue(new Error("Execution failed"));

    const result = await supervisor.runTask("Test goal");
    expect(result.success).toBe(false);
    expect(result.summary).toContain("Execution failed: Execution failed");
    
    runSpy.mockRestore();
  });
});
