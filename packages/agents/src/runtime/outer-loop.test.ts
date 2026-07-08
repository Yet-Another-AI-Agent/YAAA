import { describe, it, expect, vi, beforeEach } from "vitest";
import { container, PermissionEngine } from "@yaaa/platform";
import type { IBus, IStore, IMeshGateway } from "@yaaa/interfaces";
import type { TaskPlan } from "@yaaa/shared";
import { OuterLoop } from "./outer-loop.js";

describe("OuterLoop Manager", () => {
  let mockGateway: IMeshGateway;
  let mockBus: IBus;
  let mockStore: IStore;
  let permissions: PermissionEngine;
  let outerLoop: OuterLoop;

  beforeEach(() => {
    container.clear();

    mockGateway = {
      chat: vi.fn().mockResolvedValue(`\`\`\`json
{
  "result": {
    "artifacts": [],
    "summary": "Completed subtask facts check."
  }
}
\`\`\``),
      chatStream: vi.fn(),
    };

    mockBus = {
      publish: vi.fn(),
      subscribe: vi.fn(),
    };

    mockStore = {
      initTaskDb: vi.fn(),
      saveMessage: vi.fn(),
      getMessages: vi.fn(),
      savePlan: vi.fn(),
      getPlan: vi.fn(),
      saveLedgerEntry: vi.fn(),
      getLedgerEntries: vi.fn(),
      saveAuditLog: vi.fn(),
      getAuditLogs: vi.fn(),
    };

    permissions = new PermissionEngine();

    container.register("IMeshGateway", mockGateway);
    container.register("IBus", mockBus);
    container.register("IStore", mockStore);
    container.register("PermissionEngine", permissions);

    outerLoop = new OuterLoop();
  });

  it("should execute sequential plan subtasks matching dependencies", async () => {
    const plan: TaskPlan = {
      goal: "Run test task",
      subtasks: [
        {
          id: "task-1",
          title: "Write file facts",
          capability: "files",
          dependsOn: [],
          riskLevel: "low",
          successCriteria: "file exists",
          state: "pending",
        },
        {
          id: "task-2",
          title: "Verify task facts contents",
          capability: "verify",
          dependsOn: ["task-1"], // depends on task-1
          riskLevel: "low",
          successCriteria: "facts verified",
          state: "pending",
        },
      ],
    };

    // Mock verifier subtask response
    (mockGateway.chat as any).mockImplementation(async (messages: any[], options: any) => {
      if (options.modelRole === "verifier") {
        return `\`\`\`json
{
  "verification": {
    "status": "passed",
    "reason": "OK"
  }
}
\`\`\``;
      }
      return `\`\`\`json
{
  "result": {
    "artifacts": [],
    "summary": "Subtask completed successfully."
  }
}
\`\`\``;
    });

    await expect(outerLoop.run("task-123", plan)).resolves.not.toThrow();

    expect(mockStore.savePlan).toHaveBeenCalledWith("task-123", plan);
    expect(mockStore.saveLedgerEntry).toHaveBeenCalled();
    expect(mockBus.publish).toHaveBeenCalledWith("task.task-123.started", expect.objectContaining({
      kind: "status",
      state: "working",
    }));
  });

  it("should throw an error if a subtask dependency loop or deadlock is detected", async () => {
    const deadlockedPlan: TaskPlan = {
      goal: "Deadlock task",
      subtasks: [
        {
          id: "task-1",
          title: "Task 1",
          capability: "files",
          dependsOn: ["task-2"], // cyclic dependency
          riskLevel: "low",
          successCriteria: "done",
          state: "pending",
        },
        {
          id: "task-2",
          title: "Task 2",
          capability: "files",
          dependsOn: ["task-1"], // cyclic dependency
          riskLevel: "low",
          successCriteria: "done",
          state: "pending",
        },
      ],
    };

    await expect(outerLoop.run("task-deadlock", deadlockedPlan)).rejects.toThrow(
      "Deadlock detected in subtask execution dependency graph."
    );
  });

  it("should handle subtask failures and throw error eventually on blocked state", async () => {
    const failingPlan: TaskPlan = {
      goal: "Failing task",
      subtasks: [
        {
          id: "task-1",
          title: "Failing subtask",
          capability: "files",
          dependsOn: [],
          riskLevel: "low",
          successCriteria: "done",
          state: "pending",
        },
        {
          id: "task-2",
          title: "Dependent pending subtask",
          capability: "files",
          dependsOn: ["task-1"],
          riskLevel: "low",
          successCriteria: "done",
          state: "pending",
        },
      ],
    };

    // Force mock gateway to throw an error for worker loop
    (mockGateway.chat as any).mockRejectedValue(new Error("LLM failure"));

    await expect(outerLoop.run("task-failing", failingPlan)).rejects.toThrow(
      "Task execution failed due to subtask failure."
    );
  });
});
