import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { container, MessageBus, PermissionEngine } from "@yaaa/platform";
import { FilesFs, MeshGateway } from "@yaaa/providers";
import { Supervisor } from "@yaaa/orchestrator";
import { OuterLoop } from "@yaaa/agents";
import type { IStore } from "@yaaa/interfaces";
import type { AgentMessage, TaskPlan, LedgerEntry } from "@yaaa/shared";

// ---------------------------------------------------------------------------
// In-memory IStore mock — avoids better-sqlite3 native binary dependency so
// the E2E suite runs identically on macOS, Linux, and Windows.
// ---------------------------------------------------------------------------
function createInMemoryStore(): IStore & { closeAll: () => void } {
  const plans = new Map<string, TaskPlan>();
  const messages = new Map<string, AgentMessage[]>();
  const ledger = new Map<string, LedgerEntry[]>();
  const auditLogs = new Map<string, any[]>();

  return {
    async initTaskDb(taskId) { /* no-op */ },
    async saveMessage(taskId, msg) {
      const list = messages.get(taskId) ?? [];
      list.push(msg);
      messages.set(taskId, list);
    },
    async getMessages(taskId) { return messages.get(taskId) ?? []; },
    async savePlan(taskId, plan) { plans.set(taskId, plan); },
    async getPlan(taskId) { return plans.get(taskId) ?? null; },
    async saveLedgerEntry(taskId, entry) {
      const list = ledger.get(taskId) ?? [];
      list.push(entry);
      ledger.set(taskId, list);
    },
    async getLedgerEntries(taskId) { return ledger.get(taskId) ?? []; },
    async saveAuditLog(taskId, log) {
      const list = auditLogs.get(taskId) ?? [];
      list.push(log);
      auditLogs.set(taskId, list);
    },
    async getAuditLogs(taskId) { return auditLogs.get(taskId) ?? []; },
    closeAll() { plans.clear(); messages.clear(); ledger.clear(); auditLogs.clear(); },
  };
}

describe("E2E Spine Integration Scenario", () => {
  // Use os.tmpdir() so directory creation and cleanup work on macOS, Linux, and Windows
  const e2eDir = path.join(os.tmpdir(), `yaaa-e2e-workspace-${Date.now()}`);
  let store: IStore & { closeAll: () => void };

  beforeAll(async () => {
    await fs.mkdir(e2eDir, { recursive: true });

    container.clear();

    store = createInMemoryStore();
    const bus = new MessageBus();
    const permissions = new PermissionEngine();
    const gateway = new MeshGateway(); // mock mode — no MESH_API_KEY needed
    const filesProvider = new FilesFs(e2eDir);

    container.register("IStore", store);
    container.register("IBus", bus);
    container.register("PermissionEngine", permissions);
    container.register("IMeshGateway", gateway);
    container.register("capability:files", filesProvider);
  });

  afterAll(async () => {
    store.closeAll();
    await fs.rm(e2eDir, { recursive: true, force: true });
  });

  it("should successfully coordinate planning, execution, and verification of a file creation task", async () => {
    const supervisor = new Supervisor();
    const result = await supervisor.runTask(
      "Create a file named summary.txt listing three facts about solid-state batteries"
    );

    expect(result.success).toBe(true);
    expect(result.summary).toContain("Verified that summary.txt exists");

    const filePath = path.join(e2eDir, "summary.txt");
    const fileContent = await fs.readFile(filePath, "utf-8");
    expect(fileContent).toContain("Solid-state batteries use solid electrolytes");
    expect(fileContent).toContain("higher energy density");
    expect(fileContent).toContain("longer overall lifecycle");
  });

  it("should return success: false when task execution throws", async () => {
    const runSpy = vi.spyOn(OuterLoop.prototype, "run").mockRejectedValue(
      new Error("Simulated inner-loop failure")
    );

    try {
      const supervisor = new Supervisor();
      const result = await supervisor.runTask("Trigger a failure scenario");

      expect(result.success).toBe(false);
      expect(result.summary).toContain("Execution failed");
    } finally {
      runSpy.mockRestore();
    }
  });

  it("should persist plan to in-memory store after supervisor.runTask", async () => {
    let capturedTaskId: string | null = null;
    const realSavePlan = store.savePlan.bind(store);
    vi.spyOn(store, "savePlan").mockImplementation(async (taskId, plan) => {
      capturedTaskId = taskId;
      return realSavePlan(taskId, plan);
    });

    try {
      const supervisor = new Supervisor();
      await supervisor.runTask(
        "Create a file named notes.txt with a single line: E2E plan persistence test"
      );

      expect(capturedTaskId).not.toBeNull();
      const persistedPlan = await store.getPlan(capturedTaskId!);
      expect(persistedPlan).not.toBeNull();
      expect(Array.isArray(persistedPlan!.subtasks)).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
