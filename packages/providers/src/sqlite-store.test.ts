import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { AgentMessage, AgentRun, TaskPlan, LedgerEntry, RuntimeEvent } from "@yaaa/shared";

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
    agents: any[];
    conversations: any[];
    conversation_messages: any[];
    runtime_events: any[];
    queue_items: any[];
    autoId: number;
  }>();

  function getDb(dbPath: string) {
    if (!dbs.has(dbPath)) {
      dbs.set(dbPath, {
        messages: [], plans: [], ledger: [], audit_logs: [], agents: [], conversations: [], conversation_messages: [], runtime_events: [], queue_items: [], autoId: 1,
      });
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
        } else if (/INSERT INTO agents/.test(sql)) {
          const [id, data] = args;
          const index = db.agents.findIndex((row) => row.id === id);
          const row = { id, data, updated_at: new Date().toISOString() };
          if (index >= 0) db.agents[index] = row; else db.agents.push(row);
        } else if (/INSERT INTO conversations/.test(sql)) {
          const [id, task_id, kind, data] = args;
          const index = db.conversations.findIndex((row) => row.id === id);
          const row = { id, task_id, kind, data, updated_at: new Date().toISOString() };
          if (index >= 0) db.conversations[index] = row; else db.conversations.push(row);
        } else if (/INSERT INTO conversation_messages/.test(sql)) {
          const [id, task_id, conversation_id, data] = args;
          db.conversation_messages.push({ id, task_id, conversation_id, data, created_at: new Date().toISOString() });
        } else if (/INSERT OR REPLACE INTO runtime_events/.test(sql)) {
          const [id, task_id, topic, timestamp, agent_id, run_id, parent_event_id, payload] = args;
          const index = db.runtime_events.findIndex((row) => row.id === id);
          const row = { id, task_id, topic, timestamp, agent_id, run_id, parent_event_id, payload };
          if (index >= 0) db.runtime_events[index] = row; else db.runtime_events.push(row);
        } else if (/INSERT OR IGNORE INTO queue_items/.test(sql)) {
          const [id, task_id, queue, recipient_id, payload, created_at, available_at, attempts] = args;
          if (!db.queue_items.some((row) => row.id === id)) {
            db.queue_items.push({ id, task_id, queue, recipient_id, payload, created_at, available_at, attempts, status: "pending", lease_id: null, leased_until: null });
          }
          return { changes: 1 };
        } else if (/UPDATE queue_items SET status = 'leased'/.test(sql)) {
          const [lease_id, leased_until, id] = args;
          const row = db.queue_items.find((candidate) => candidate.id === id && candidate.status === "pending");
          if (!row) return { changes: 0 };
          row.status = "leased"; row.lease_id = lease_id; row.leased_until = leased_until; row.attempts += 1;
          return { changes: 1 };
        } else if (/UPDATE queue_items SET status = 'done'/.test(sql)) {
          const [id, lease_id] = args;
          const row = db.queue_items.find((candidate) => candidate.id === id && candidate.lease_id === lease_id);
          if (!row) return { changes: 0 };
          row.status = "done"; row.lease_id = null; row.leased_until = null;
          return { changes: 1 };
        } else if (/UPDATE queue_items SET status = 'pending'/.test(sql)) {
          const first = args[0];
          const row = db.queue_items.find((candidate) => candidate.id === args[1] && candidate.lease_id === args[2]);
          if (row) { row.status = "pending"; row.lease_id = null; row.leased_until = null; row.available_at = first; return { changes: 1 }; }
          return { changes: 0 };
        }
      };

      const get = (...args: any[]) => {
        if (/FROM plans WHERE taskId/.test(sql)) {
          return db.plans.find((r) => r.taskId === args[0]);
        }
        if (/FROM messages/.test(sql)) return db.messages[0];
        if (/FROM conversations WHERE id/.test(sql)) {
          return db.conversations.find((row) => row.id === args[0] && row.task_id === args[1]);
        }
        return undefined;
      };

      const all = (...args: any[]) => {
        if (/FROM messages/.test(sql)) return db.messages;
        if (/FROM plans/.test(sql)) return db.plans;
        if (/FROM ledger/.test(sql)) return db.ledger;
        if (/FROM audit_logs/.test(sql)) return db.audit_logs;
        if (/FROM agents/.test(sql)) return db.agents;
        if (/FROM conversations/.test(sql)) return db.conversations.filter((row) => row.task_id === args[0]);
        if (/FROM conversation_messages/.test(sql)) {
          return db.conversation_messages.filter((row) => row.task_id === args[0] && row.conversation_id === args[1]);
        }
        if (/FROM runtime_events/.test(sql)) {
          return db.runtime_events.filter((row) => row.task_id === args[0] && (!args[1] || row.topic === args[1]));
        }
        if (/FROM queue_items/.test(sql)) {
          if (/status = 'pending' AND available_at/.test(sql)) {
            return db.queue_items.filter((row) => row.task_id === args[0] && row.queue === args[1] && row.status === "pending");
          }
          if (/task_id = \? AND queue = \? AND status = \?/.test(sql)) {
            return db.queue_items.filter((row) => row.task_id === args[0] && row.queue === args[1] && row.status === args[2]);
          }
          if (/task_id = \? AND queue = \?/.test(sql)) {
            return db.queue_items.filter((row) => row.task_id === args[0] && row.queue === args[1]);
          }
          if (/task_id = \? AND status = \?/.test(sql)) {
            return db.queue_items.filter((row) => row.task_id === args[0] && row.status === args[1]);
          }
          return db.queue_items.filter((row) => row.task_id === args[0]);
        }
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
    const dbFileExists = fs.existsSync(path.join(testDbDir, taskId, "databases", "task.db"));
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

  it("should save and retrieve the ordered runtime event journal", async () => {
    const event: RuntimeEvent = {
      id: "event-1",
      taskId,
      topic: "task.test-task-123.agent.agent-1.llm_context",
      timestamp: new Date().toISOString(),
      agentId: "agent-1",
      payload: { turn: 1, messages: [{ role: "user", content: "hello" }] },
    };

    await store.saveRuntimeEvent(event);
    const events = await store.getRuntimeEvents(taskId, { topic: event.topic });
    expect(events).toEqual([event]);
  });

  it("should claim, acknowledge, and retry durable queue items", async () => {
    const item = {
      id: "queue-1",
      taskId,
      queue: "orchestrator" as const,
      payload: { content: "continue" },
      createdAt: new Date().toISOString(),
      availableAt: new Date(0).toISOString(),
      attempts: 0,
    };
    await store.enqueueQueueItem(item);
    const [claim] = await store.claimQueueItems({ queue: "orchestrator", taskId, consumerId: "test" });
    expect(claim.item.payload).toEqual(item.payload);
    // Agent DBs are separate and do not contain queue_items. Queue lifecycle
    // operations must target task DBs only, even after an agent DB is opened.
    fs.mkdirSync(path.join(testDbDir, taskId, ".yaaa", "agents", "agent-1"), { recursive: true });
    await store.getAgents(taskId);
    await store.retryQueueItem({ id: item.id, leaseId: claim.leaseId });
    const [secondClaim] = await store.claimQueueItems({ queue: "orchestrator", taskId, consumerId: "test-2" });
    await store.acknowledgeQueueItem({ id: item.id, leaseId: secondClaim.leaseId });
    await expect(store.getQueueItems(taskId, { status: "done" })).resolves.toHaveLength(1);
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

  it("persists the latest lifecycle state for each named agent", async () => {
    const agent: AgentRun = {
      id: "files-agent-1",
      handle: "@sage-1",
      displayName: "Sage",
      taskId,
      subtaskId: "subtask-1",
      role: "FilesAgent",
      modelRole: "worker",
      status: "working",
    };
    await store.saveAgent(taskId, agent);
    await store.saveAgent(taskId, { ...agent, status: "completed", summary: "Done" });

    await expect(store.getAgents(taskId)).resolves.toEqual([
      { ...agent, status: "completed", summary: "Done" },
    ]);
  });

  it("persists conversations independently from legacy runtime messages", async () => {
    const conversation = {
      id: "public-1",
      taskId,
      kind: "public" as const,
      title: "Mission chat",
      participantIds: ["orchestrator"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const message = {
      id: "chat-message-1",
      taskId,
      conversationId: conversation.id,
      authorId: "user-1",
      authorKind: "user" as const,
      content: "Hello @orchestrator",
      mentions: [{ handle: "@orchestrator", recipientId: "orchestrator", recipientKind: "orchestrator" as const }],
      createdAt: "2026-01-01T00:00:01.000Z",
    };

    await store.saveConversation(taskId, conversation);
    await store.saveConversationMessage(taskId, message);

    await expect(store.getConversation(taskId, conversation.id)).resolves.toEqual(conversation);
    await expect(store.getConversations(taskId)).resolves.toContainEqual(conversation);
    await expect(store.getConversationMessages(taskId, conversation.id)).resolves.toEqual([message]);
  });

  it("rejects conversation records assigned to another task", async () => {
    const otherTaskConversation = {
      id: "public-other",
      taskId: "other-task",
      kind: "public" as const,
      title: "Wrong task",
      participantIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await expect(store.saveConversation(taskId, otherTaskConversation)).rejects.toThrow(
      "Conversation taskId does not match",
    );

    await expect(
      store.saveConversationMessage(taskId, {
        id: "message-other",
        taskId: "other-task",
        conversationId: otherTaskConversation.id,
        authorId: "user-1",
        authorKind: "user",
        content: "Wrong task",
        mentions: [],
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    ).rejects.toThrow("Conversation message taskId does not match");
  });
});
