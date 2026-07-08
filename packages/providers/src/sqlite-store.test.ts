import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { AgentMessage, TaskPlan, LedgerEntry } from "@yaaa/shared";

// ---------------------------------------------------------------------------
// Mock better-sqlite3 with a pure in-memory implementation so tests run on
// macOS, Linux, and Windows without requiring a platform-native binary build.
// ---------------------------------------------------------------------------
vi.mock("better-sqlite3", async () => {
  const nodeFs = await import("node:fs");

  // Each "database file" gets its own in-memory tables.
  const dbs = new Map<string, {
    messages: any[];
    plans: any[];
    ledger: any[];
    audit_logs: any[];
    autoId: number;
  }>();

  function getDb(dbPath: string) {
    if (!dbs.has(dbPath)) {
      dbs.set(dbPath, { messages: [], plans: [], ledger: [], audit_logs: [], autoId: 1 });
    }
    return dbs.get(dbPath)!;
  }

  function makePrepare(dbPath: string) {
    return (sql: string) => {
      const db = getDb(dbPath);

      const run = (...args: any[]) => {
        if (/INSERT OR REPLACE INTO messages/.test(sql)) {
          const [id, kind, data] = args;
          const idx = db.messages.findIndex((r) => r.id === id);
          const row = { id, kind, data, timestamp: new Date().toISOString() };
          if (idx >= 0) db.messages[idx] = row; else db.messages.push(row);
        } else if (/INSERT OR REPLACE INTO plans/.test(sql)) {
          const [taskId, data] = args;
          const idx = db.plans.findIndex((r) => r.taskId === taskId);
          const row = { taskId, data, timestamp: new Date().toISOString() };
          if (idx >= 0) db.plans[idx] = row; else db.plans.push(row);
        } else if (/INSERT OR REPLACE INTO ledger/.test(sql)) {
          const [taskId, entryIndex, data] = args;
          const idx = db.ledger.findIndex((r) => r.taskId === taskId && r.entryIndex === entryIndex);
          const row = { taskId, entryIndex, data, timestamp: new Date().toISOString() };
          if (idx >= 0) db.ledger[idx] = row; else db.ledger.push(row);
        } else if (/INSERT INTO audit_logs/.test(sql)) {
          const [action, details, approvedBy] = args;
          db.audit_logs.push({ id: db.autoId++, action, details, approvedBy: approvedBy ?? null, timestamp: new Date().toISOString() });
        }
      };

      const get = (...args: any[]) => {
        if (/FROM plans WHERE taskId/.test(sql)) {
          return db.plans.find((r) => r.taskId === args[0]);
        }
        if (/FROM messages/.test(sql)) return db.messages[0];
        return undefined;
      };

      const all = () => {
        if (/FROM messages/.test(sql)) return db.messages;
        if (/FROM plans/.test(sql)) return db.plans;
        if (/FROM ledger/.test(sql)) return db.ledger;
        if (/FROM audit_logs/.test(sql)) return db.audit_logs;
        return [];
      };

      return { run, get, all };
    };
  }

  const MockDatabase = vi.fn().mockImplementation((dbPath: string) => {
    getDb(dbPath); // ensure entry exists
    // Touch the file so fs.existsSync checks behave the same as with real sqlite
    if (!nodeFs.existsSync(dbPath)) {
      nodeFs.writeFileSync(dbPath, "");
    }
    return {
      exec: vi.fn(),
      prepare: makePrepare(dbPath),
      close: vi.fn(() => { dbs.delete(dbPath); }),
    };
  });

  return { default: MockDatabase };
});

import { SqliteStore } from "./sqlite-store.js";

describe("SqliteStore", () => {
  // Use os.tmpdir() so directory creation and cleanup work on all platforms
  const testDbDir = path.join(os.tmpdir(), `yaaa-test-tasks-${Date.now()}`);
  let store: InstanceType<typeof SqliteStore>;
  const taskId = "test-task-123";

  beforeAll(() => {
    store = new SqliteStore(testDbDir);
  });

  afterAll(() => {
    store.closeAll();
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
  });

  it("should initialize task DB and create tables", async () => {
    await expect(store.initTaskDb(taskId)).resolves.not.toThrow();
    const dbFileExists = fs.existsSync(path.join(testDbDir, `${taskId}.db`));
    expect(dbFileExists).toBe(true);
  });

  it("should save and retrieve AgentMessage", async () => {
    const msg: AgentMessage = {
      kind: "status",
      from: "agent-1",
      taskId,
      state: "working",
      note: "progress note",
    };

    await store.saveMessage(taskId, msg);
    const messages = await store.getMessages(taskId);
    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual(msg);
  });

  it("should save and retrieve TaskPlan", async () => {
    const plan: TaskPlan = {
      goal: "Write battery report",
      subtasks: [
        {
          id: "1",
          title: "subtask 1",
          capability: "files",
          dependsOn: [],
          riskLevel: "low",
          successCriteria: "criteria",
          state: "pending",
        },
      ],
    };

    await store.savePlan(taskId, plan);
    const retrieved = await store.getPlan(taskId);
    expect(retrieved).toEqual(plan);
  });

  it("should return null if no plan is found", async () => {
    const retrieved = await store.getPlan("non-existent-task");
    expect(retrieved).toBeNull();
  });

  it("should save and retrieve LedgerEntries", async () => {
    const entry: LedgerEntry = {
      timestamp: new Date().toISOString(),
      step: 1,
      facts: ["Fact 1"],
      assumptions: ["Assumption 1"],
      subtaskStates: { "task-1": "running" },
      nextStepStrategy: "next step",
    };

    await store.saveLedgerEntry(taskId, entry);
    const entries = await store.getLedgerEntries(taskId);
    expect(entries.length).toBe(1);
    expect(entries[0]).toEqual(entry);
  });

  it("should save and retrieve AuditLogs", async () => {
    const log = {
      action: "files.writeFile",
      details: "wrote summary.txt",
      approvedBy: "user",
    };

    await store.saveAuditLog(taskId, log);
    const logs = await store.getAuditLogs(taskId);
    expect(logs.length).toBe(1);
    expect(logs[0].action).toBe(log.action);
    expect(logs[0].details).toBe(log.details);
    expect(logs[0].approvedBy).toBe(log.approvedBy);
  });
});
