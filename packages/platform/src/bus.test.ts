import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IStore } from "@yaaa/interfaces";
import type { AgentMessage } from "@yaaa/shared";
import { container } from "./di.js";
import { MessageBus } from "./bus.js";

describe("MessageBus", () => {
  let bus: MessageBus;
  let mockStore: IStore;

  beforeEach(() => {
    container.clear();
    bus = new MessageBus();

    // Create a mock store to check persistence
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

    container.register("IStore", mockStore);
    container.register("IBus", bus);
  });

  it("should publish and subscribe to exact topics", async () => {
    const callback = vi.fn();
    bus.subscribe("task.123.started", callback);

    const payload = { msg: "hello" };
    await bus.publish("task.123.started", payload);

    expect(callback).toHaveBeenCalledWith("task.123.started", payload);
  });

  it("should unsubscribe from topics correctly", async () => {
    const callback = vi.fn();
    const unsubscribe = bus.subscribe("task.123.started", callback);

    unsubscribe();
    await bus.publish("task.123.started", { msg: "hello" });

    expect(callback).not.toHaveBeenCalled();
  });

  it("should support wildcard subscriptions using matchTopic", async () => {
    const callback = vi.fn();
    bus.subscribe("task.*.started", callback);

    await bus.publish("task.123.started", { num: 1 });
    await bus.publish("task.456.started", { num: 2 });
    await bus.publish("task.789.completed", { num: 3 }); // should not match

    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("should persist parsed AgentMessage values to the Store", async () => {
    const agentMsg: AgentMessage = {
      kind: "status",
      from: "agent-1",
      taskId: "task-99",
      state: "working",
      note: "doing stuff",
    };

    await bus.publish("task.99.status", agentMsg);

    expect(mockStore.saveMessage).toHaveBeenCalledWith("task-99", agentMsg);
  });

  it("should not crash if store is not registered in the container", async () => {
    // Clear dependencies so IStore isn't registered
    container.clear();
    container.register("IBus", bus);

    const agentMsg: AgentMessage = {
      kind: "status",
      from: "agent-1",
      taskId: "task-99",
      state: "working",
    };

    // This should complete without throwing
    await expect(bus.publish("task.99.status", agentMsg)).resolves.not.toThrow();
  });

  it("isolates subscriber failures and continues notifying later subscribers", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const laterSubscriber = vi.fn();
    bus.subscribe("task.123.started", async () => {
      throw new Error("subscriber failed");
    });
    bus.subscribe("task.123.started", laterSubscriber);

    await expect(bus.publish("task.123.started", { msg: "hello" })).resolves.toBeUndefined();
    expect(laterSubscriber).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "Error in subscriber for topic task.123.started:",
      expect.any(Error),
    );
    error.mockRestore();
  });
});
