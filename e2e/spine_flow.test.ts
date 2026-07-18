import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { container, MessageBus, PermissionEngine } from "@yaaa/platform";
import { FilesFs, MeshGateway } from "@yaaa/providers";
import { Supervisor } from "@yaaa/orchestrator";
import { OuterLoop } from "@yaaa/agents";
import type { IStore } from "@yaaa/interfaces";
import type { AgentMessage, AgentRun, TaskPlan, LedgerEntry } from "@yaaa/shared";

// ---------------------------------------------------------------------------
// In-memory IStore mock — avoids better-sqlite3 native binary dependency so
// the E2E suite runs identically on macOS, Linux, and Windows.
// ---------------------------------------------------------------------------
function createInMemoryStore(): IStore & { closeAll: () => void } {
  const plans = new Map<string, TaskPlan>();
  const messages = new Map<string, AgentMessage[]>();
  const ledger = new Map<string, LedgerEntry[]>();
  const auditLogs = new Map<string, any[]>();
  const agents = new Map<string, AgentRun[]>();

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
    async saveAgent(taskId, agent) {
      const current = agents.get(taskId) ?? [];
      const index = current.findIndex((item) => item.id === agent.id);
      if (index >= 0) current[index] = agent; else current.push(agent);
      agents.set(taskId, current);
    },
    async getAgents(taskId) { return agents.get(taskId) ?? []; },
    closeAll() { plans.clear(); messages.clear(); ledger.clear(); auditLogs.clear(); agents.clear(); },
  };
}

import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";

class MockWorkerChatModel extends BaseChatModel {
  constructor(private readonly roleOrModel: string) {
    super({});
  }
  _llmType() {
    return "yaaa-mock-worker";
  }
  async _generate(messages: any[]): Promise<any> {
    const joined = messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    const isVerifier =
      this.roleOrModel === "verifier" ||
      this.roleOrModel === "QaTesterAgent" ||
      /"status"\s*:\s*"passed"\s*\|\s*"failed"/i.test(joined);
    if (isVerifier) {
      const text = JSON.stringify({ status: "passed", summary: "Mock verification: all stated criteria appear satisfied.", findings: [], evidence: ["Deterministic mock-mode verification"] });
      const message = new AIMessage({ content: text });
      return { generations: [{ text, message }] };
    }

    const hasToolResult = messages.some((m) => m.constructor.name === "ToolMessage" || m._getType?.() === "tool");
    if (!hasToolResult) {
      let toolCall: any = null;
      if (joined.includes("summary.txt")) {
        toolCall = {
          name: "write_file",
          args: {
            path: "summary.txt",
            content: "1. Solid-state batteries use solid electrolytes instead of liquid ones, significantly reducing fire risk.\n2. They offer higher energy density, allowing longer range or runtime in the same physical size.\n3. They support faster charging rates and have a longer overall lifecycle."
          },
          id: "call-1"
        };
      } else if (joined.includes("notes.txt")) {
        toolCall = {
          name: "write_file",
          args: {
            path: "notes.txt",
            content: "E2E plan persistence test"
          },
          id: "call-2"
        };
      } else if (joined.includes("reviewed.txt")) {
        toolCall = {
          name: "write_file",
          args: {
            path: "reviewed.txt",
            content: "approved"
          },
          id: "call-3"
        };
      }

      if (toolCall) {
        const message = new AIMessage({
          content: "",
          tool_calls: [toolCall]
        });
        return { generations: [{ text: "", message }] };
      }
    }

    const text = "Mock mode: subtask completed (no live model configured).";
    const message = new AIMessage({ content: text });
    return { generations: [{ text, message }] };
  }
  override bindTools() {
    return this;
  }
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
    container.register("ChatModelFactory", (role: string) => new MockWorkerChatModel(role));
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
    expect(result.summary.toLowerCase()).toContain("summary.txt");

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

  it("requires an explicit plan phase before agents execute and records their lifecycle", async () => {
    const supervisor = new Supervisor();
    const taskId = "reviewed-e2e-task";
    const plan = await supervisor.createPlan(
      "Create a file named reviewed.txt containing the word approved",
      taskId,
    );

    expect(plan.subtasks.length).toBeGreaterThan(0);
    expect(await store.getAgents(taskId)).toEqual([]);

    const result = await supervisor.runPlan(plan, taskId);
    expect(result.success).toBe(true);
    await expect(store.getAgents(taskId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ handle: expect.stringMatching(/^@[a-z0-9-]+-1$/), status: "completed" }),
      ]),
    );
  });
});
