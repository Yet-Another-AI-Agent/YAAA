import { describe, expect, it, vi } from "vitest";
import { ExecutionSessionManager } from "./execution-session-manager.js";

describe("ExecutionSessionManager", () => {
  it("records bounded lifecycle and observations without killing the backend", async () => {
    const store = {
      saveExecutionSession: vi.fn(),
      saveExecutionObservation: vi.fn(),
    } as any;
    const manager = new ExecutionSessionManager(store);
    await manager.create({ id: "s1", taskId: "t1", agentId: "a1", kind: "shell", backendId: "pty-1", state: "running" });
    const observation = await manager.observe("s1", { kind: "stdout", summary: "install still progressing" });
    expect(observation.sequence).toBe(1);
    expect(manager.get("s1")?.state).toBe("running");
    await manager.detach("s1");
    expect(manager.get("s1")?.state).toBe("detached");
    expect(store.saveExecutionObservation).toHaveBeenCalledOnce();
  });

  it("cleans all sessions for a task through the provider callback", async () => {
    const manager = new ExecutionSessionManager();
    await manager.create({ id: "s1", taskId: "t1", agentId: "a1", kind: "browser", backendId: "browser-1" });
    const close = vi.fn();
    await manager.cleanupTask("t1", close);
    expect(close).toHaveBeenCalledOnce();
    expect(manager.get("s1")).toBeUndefined();
  });
});
