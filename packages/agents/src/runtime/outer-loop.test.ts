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
      saveAgent: vi.fn(),
      getAgents: vi.fn(),
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
    expect(mockStore.saveAgent).toHaveBeenCalledWith("task-123", expect.objectContaining({
      handle: "@sage-1",
      status: "working",
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

  const singleSubtaskPlan = (): TaskPlan => ({
    goal: "Kill switch task",
    subtasks: [
      {
        id: "task-1",
        title: "Write the report file",
        capability: "files",
        dependsOn: [],
        riskLevel: "low",
        successCriteria: "report exists",
        state: "pending",
      },
    ],
  });

  it("trips the kill switch after 3 identical errors and retries once with a different approach", async () => {
    (mockGateway.chat as any).mockRejectedValue(new Error("segfault in strategy A"));

    await expect(outerLoop.run("task-loop", singleSubtaskPlan())).rejects.toThrow(
      "Task execution failed due to subtask failure."
    );

    // Hard interrupt was broadcast to the channel/Agent Space.
    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-loop.started",
      expect.objectContaining({
        kind: "status",
        note: expect.stringContaining("Kill switch"),
      }),
    );

    // The replacement agent was explicitly ordered to change approach.
    const instructions = (mockGateway.chat as any).mock.calls.map(
      (call: any[]) => call[0].map((m: any) => m.content).join("\n"),
    );
    expect(
      instructions.some((text: string) => text.includes("COMPLETELY DIFFERENT")),
    ).toBe(true);

    // 3 identical failures + 1 different-approach attempt = 4 agents, all failed.
    const savedAgents = (mockStore.saveAgent as any).mock.calls.map((c: any[]) => c[1]);
    const failedAgents = savedAgents.filter((agent: any) => agent.status === "failed");
    expect(failedAgents).toHaveLength(4);
  });

  it("runs independent ready subtasks concurrently", async () => {
    const parallelPlan: TaskPlan = {
      goal: "Parallel task",
      subtasks: [
        {
          id: "task-a",
          title: "Independent A",
          capability: "files",
          dependsOn: [],
          riskLevel: "low",
          successCriteria: "a done",
          state: "pending",
        },
        {
          id: "task-b",
          title: "Independent B",
          capability: "files",
          dependsOn: [],
          riskLevel: "low",
          successCriteria: "b done",
          state: "pending",
        },
      ],
    };

    // Each agent's gateway call parks on a deferred promise so neither subtask
    // can complete until we explicitly release it. That lets us assert both
    // subtasks are simultaneously in flight before either finishes.
    const resolvers: Array<(value: string) => void> = [];
    const successJson = `\`\`\`json
{"result": {"artifacts": [], "summary": "done"}}
\`\`\``;
    (mockGateway.chat as any).mockImplementation(
      () => new Promise<string>((resolve) => resolvers.push(resolve)),
    );

    const runPromise = outerLoop.run("task-parallel", parallelPlan);

    // Both subtasks reached the model before either was allowed to resolve —
    // proof of genuine concurrency rather than serial execution (a serial loop
    // would block on the first deferred call and never issue the second).
    await vi.waitFor(() => {
      expect(mockGateway.chat).toHaveBeenCalledTimes(2);
    });
    expect(resolvers).toHaveLength(2);

    // Release both agents and let the run settle.
    resolvers.forEach((resolve) => resolve(successJson));
    await expect(runPromise).resolves.not.toThrow();

    const savedAgents = (mockStore.saveAgent as any).mock.calls.map((c: any[]) => c[1]);
    const completedSubtaskIds = savedAgents
      .filter((agent: any) => agent.status === "completed")
      .map((agent: any) => agent.subtaskId);
    expect(completedSubtaskIds).toContain("task-a");
    expect(completedSubtaskIds).toContain("task-b");
  });

  it("recovers when a retry succeeds before the kill switch trips", async () => {
    (mockGateway.chat as any)
      .mockRejectedValueOnce(new Error("transient timeout"))
      .mockResolvedValue(`\`\`\`json
{"result": {"artifacts": [], "summary": "Recovered on retry."}}
\`\`\``);

    await expect(outerLoop.run("task-retry", singleSubtaskPlan())).resolves.not.toThrow();

    const savedAgents = (mockStore.saveAgent as any).mock.calls.map((c: any[]) => c[1]);
    expect(savedAgents.some((agent: any) => agent.status === "completed")).toBe(true);
    // No kill-switch broadcast for a one-off transient failure.
    const killSwitchNotes = (mockBus.publish as any).mock.calls.filter(
      (call: any[]) => typeof call[1]?.note === "string" && call[1].note.includes("Kill switch"),
    );
    expect(killSwitchNotes).toHaveLength(0);
  });
});
