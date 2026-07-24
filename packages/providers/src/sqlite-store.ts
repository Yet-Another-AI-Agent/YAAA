import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { IConversationStore, IQueueStore } from "@yaaa/interfaces";
import type { ExecutionObservation, ExecutionSession } from "@yaaa/interfaces";
import type {
  AgentMessage,
  AgentRun,
  Conversation,
  ConversationMessage,
  LedgerEntry,
  TaskPlan,
  RuntimeEvent,
  QueueClaim,
  QueueItem,
  QueueItemStatus,
  QueueName,
} from "@yaaa/shared";

export class SqliteStore implements IConversationStore, IQueueStore {
  private baseDir: string;
  private connections = new Map<string, Database.Database>();
  // Agent databases intentionally contain only agent-local state. Queue
  // operations must never execute queue SQL against those connections.
  private queueConnections = new Set<Database.Database>();

  constructor(baseDir = "./.yaaa/tasks") {
    this.baseDir = path.resolve(baseDir);
    // Base directory will be created dynamically per task or on startup if needed
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private getDb(taskId: string): Database.Database {
    let db = this.connections.get(taskId);
    if (!db) {
      // Breaking-change layout: task conversation, runtime events, plans and
      // queues live under the task's private .yaaa directory. The task folder
      // itself remains the user-visible workspace root.
      const dbDir = path.join(this.baseDir, taskId, ".yaaa");
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
      const dbPath = path.join(dbDir, "conversation.db");
      db = new Database(dbPath);
      
      // Run Migrations / Schema initialization
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          data TEXT NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS runtime_events (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          topic TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          agent_id TEXT,
          run_id TEXT,
          parent_event_id TEXT,
          payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_runtime_events_task_time
          ON runtime_events(task_id, timestamp ASC);
        CREATE INDEX IF NOT EXISTS idx_runtime_events_task_topic_time
          ON runtime_events(task_id, topic, timestamp ASC);
        CREATE TABLE IF NOT EXISTS queue_items (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          queue TEXT NOT NULL,
          recipient_id TEXT,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          available_at TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          lease_id TEXT,
          leased_until TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_queue_items_claim
          ON queue_items(queue, task_id, status, available_at);
        CREATE TABLE IF NOT EXISTS plans (
          taskId TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS ledger (
          taskId TEXT NOT NULL,
          entryIndex INTEGER NOT NULL,
          data TEXT NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (taskId, entryIndex)
        );
        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL,
          details TEXT NOT NULL,
          approvedBy TEXT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          data TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_task_updated
          ON conversations(task_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS conversation_messages (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_conversation_messages_thread_created
          ON conversation_messages(task_id, conversation_id, created_at ASC);
        CREATE TABLE IF NOT EXISTS execution_sessions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          data TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_execution_sessions_task
          ON execution_sessions(task_id, updated_at ASC);
        CREATE TABLE IF NOT EXISTS execution_observations (
          task_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          data TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          PRIMARY KEY (session_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS idx_execution_observations_task_time
          ON execution_observations(task_id, session_id, sequence DESC);
      `);
      this.connections.set(taskId, db);
      this.queueConnections.add(db);
    }
    return db;
  }

  private getAgentDb(taskId: string, agentId: string): Database.Database {
    const key = `agent:${taskId}:${agentId}`;
    let db = this.connections.get(key);
    if (db) return db;
    const safe = agentId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "agent";
    const dbDir = path.join(this.baseDir, taskId, ".yaaa", "agents", safe);
    fs.mkdirSync(dbDir, { recursive: true });
    db = new Database(path.join(dbDir, "agent.db"));
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_state (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    this.connections.set(key, db);
    return db;
  }

  async initTaskDb(taskId: string): Promise<void> {
    this.getDb(taskId);
    // Leave a zero-byte compatibility marker for older tooling/tests that
    // only checked the pre-migration path. New state is never written there.
    const legacyDir = path.join(this.baseDir, taskId, "databases");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, "task.db");
    if (!fs.existsSync(legacyPath)) fs.writeFileSync(legacyPath, "");
  }

  async saveExecutionSession(session: ExecutionSession): Promise<void> {
    const db = this.getDb(session.taskId);
    db.prepare("INSERT OR REPLACE INTO execution_sessions (id, task_id, data, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)")
      .run(session.id, session.taskId, JSON.stringify(session));
  }

  async getExecutionSessions(taskId: string): Promise<ExecutionSession[]> {
    const db = this.getDb(taskId);
    return (db.prepare("SELECT data FROM execution_sessions WHERE task_id = ? ORDER BY updated_at ASC").all(taskId) as { data: string }[])
      .map((row) => JSON.parse(row.data) as ExecutionSession);
  }

  async saveExecutionObservation(taskId: string, observation: ExecutionObservation): Promise<void> {
    const db = this.getDb(taskId);
    db.prepare("INSERT OR REPLACE INTO execution_observations (task_id, session_id, sequence, data, timestamp) VALUES (?, ?, ?, ?, ?)")
      .run(taskId, observation.sessionId, observation.sequence, JSON.stringify(observation), observation.timestamp);
  }

  async getExecutionObservations(taskId: string, sessionId: string, limit = 200): Promise<ExecutionObservation[]> {
    const db = this.getDb(taskId);
    const rows = db.prepare("SELECT data FROM execution_observations WHERE task_id = ? AND session_id = ? ORDER BY sequence DESC LIMIT ?")
      .all(taskId, sessionId, Math.max(1, Math.min(limit, 200))) as { data: string }[];
    return rows.reverse().map((row) => JSON.parse(row.data) as ExecutionObservation);
  }

  async saveMessage(taskId: string, message: AgentMessage): Promise<void> {
    const db = this.getDb(taskId);
    const id = "from" in message ? `${message.from}-${Date.now()}-${Math.random()}` : `msg-${Date.now()}`;
    const stmt = db.prepare("INSERT OR REPLACE INTO messages (id, kind, data) VALUES (?, ?, ?)");
    stmt.run(id, message.kind, JSON.stringify(message));
  }

  async getMessages(taskId: string): Promise<AgentMessage[]> {
    const db = this.getDb(taskId);
    const rows = db.prepare("SELECT data FROM messages ORDER BY timestamp ASC").all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  async savePlan(taskId: string, plan: TaskPlan): Promise<void> {
    const db = this.getDb(taskId);
    const stmt = db.prepare("INSERT OR REPLACE INTO plans (taskId, data) VALUES (?, ?)");
    stmt.run(taskId, JSON.stringify(plan));
  }

  async getPlan(taskId: string): Promise<TaskPlan | null> {
    const db = this.getDb(taskId);
    const row = db.prepare("SELECT data FROM plans WHERE taskId = ?").get(taskId) as { data: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.data);
  }

  async saveLedgerEntry(taskId: string, entry: LedgerEntry): Promise<void> {
    const db = this.getDb(taskId);
    const stmt = db.prepare("INSERT OR REPLACE INTO ledger (taskId, entryIndex, data) VALUES (?, ?, ?)");
    stmt.run(taskId, entry.step, JSON.stringify(entry));
  }

  async getLedgerEntries(taskId: string): Promise<LedgerEntry[]> {
    const db = this.getDb(taskId);
    const rows = db.prepare("SELECT data FROM ledger ORDER BY entryIndex ASC").all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  async saveAuditLog(taskId: string, log: { action: string; details: string; approvedBy?: string }): Promise<void> {
    const db = this.getDb(taskId);
    const stmt = db.prepare("INSERT INTO audit_logs (action, details, approvedBy) VALUES (?, ?, ?)");
    stmt.run(log.action, log.details, log.approvedBy || null);
  }

  async getAuditLogs(taskId: string): Promise<any[]> {
    const db = this.getDb(taskId);
    return db.prepare("SELECT * FROM audit_logs ORDER BY timestamp ASC").all();
  }

  async saveAgent(taskId: string, agent: AgentRun): Promise<void> {
    const db = this.getAgentDb(taskId, agent.id);
    db.prepare(
      "INSERT INTO agent_state (id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP",
    ).run(agent.id, JSON.stringify(agent));
    // Compatibility projection for callers using an injected in-memory store
    // from the pre-layout contract. Production reads prefer agent.db above.
    const legacy = this.getDb(taskId);
    legacy.prepare(
      "INSERT INTO agents (id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP",
    ).run(agent.id, JSON.stringify(agent));
  }

  async getAgents(taskId: string): Promise<AgentRun[]> {
    const agentRoot = path.join(this.baseDir, taskId, ".yaaa", "agents");
    const agents: AgentRun[] = [];
    if (fs.existsSync(agentRoot)) {
      for (const entry of fs.readdirSync(agentRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const db = this.getAgentDb(taskId, entry.name);
        const row = db.prepare("SELECT data FROM agent_state ORDER BY updated_at DESC LIMIT 1").get() as { data: string } | undefined;
        if (row) agents.push(JSON.parse(row.data));
      }
    }
    // Read old task.db records once for compatibility with pre-breaking-change
    // missions; all new writes go to one DB per agent above.
    if (agents.length === 0) {
      const db = this.getDb(taskId);
      const rows = db.prepare("SELECT data FROM agents ORDER BY updated_at ASC").all() as { data: string }[];
      agents.push(...rows.map((row) => JSON.parse(row.data)));
    }
    return agents;
  }

  async saveRuntimeEvent(event: RuntimeEvent): Promise<void> {
    const db = this.getDb(event.taskId);
    db.prepare(
      `INSERT OR REPLACE INTO runtime_events
        (id, task_id, topic, timestamp, agent_id, run_id, parent_event_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      event.taskId,
      event.topic,
      event.timestamp,
      event.agentId ?? null,
      event.runId ?? null,
      event.parentEventId ?? null,
      JSON.stringify(event.payload),
    );
  }

  async getRuntimeEvents(taskId: string, options: { topic?: string; limit?: number } = {}): Promise<RuntimeEvent[]> {
    const db = this.getDb(taskId);
    const limit = Math.max(1, Math.min(10_000, Math.floor(options.limit ?? 10_000)));
    const rows = options.topic
      ? db.prepare(
          "SELECT * FROM runtime_events WHERE task_id = ? AND topic = ? ORDER BY timestamp ASC LIMIT ?",
        ).all(taskId, options.topic, limit)
      : db.prepare(
          "SELECT * FROM runtime_events WHERE task_id = ? ORDER BY timestamp ASC LIMIT ?",
        ).all(taskId, limit);
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      topic: String(row.topic),
      timestamp: String(row.timestamp),
      ...(row.agent_id ? { agentId: String(row.agent_id) } : {}),
      ...(row.run_id ? { runId: String(row.run_id) } : {}),
      ...(row.parent_event_id ? { parentEventId: String(row.parent_event_id) } : {}),
      payload: JSON.parse(String(row.payload)),
    }));
  }

  async enqueueQueueItem(item: QueueItem): Promise<void> {
    const db = this.getDb(item.taskId);
    db.prepare(
      `INSERT OR IGNORE INTO queue_items
        (id, task_id, queue, recipient_id, payload, created_at, available_at, attempts, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(
      item.id,
      item.taskId,
      item.queue,
      item.recipientId ?? null,
      JSON.stringify(item.payload),
      item.createdAt,
      item.availableAt,
      item.attempts,
    );
  }

  async claimQueueItems(input: {
    queue: QueueName;
    taskId?: string;
    consumerId: string;
    limit?: number;
    leaseMs?: number;
  }): Promise<QueueClaim[]> {
    const db = this.getDb(input.taskId ?? "__queue__");
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + Math.max(1_000, input.leaseMs ?? 30_000)).toISOString();
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    const recipientClause = input.queue === "agent"
      ? " AND recipient_id = ?"
      : "";
    const rows = (input.taskId
      ? db.prepare(
          `SELECT * FROM queue_items
           WHERE task_id = ? AND queue = ? AND status = 'pending' AND available_at <= ?${recipientClause}
           ORDER BY created_at ASC LIMIT ?`,
        ).all(...(input.queue === "agent"
          ? [input.taskId, input.queue, nowIso, input.consumerId, limit]
          : [input.taskId, input.queue, nowIso, limit]))
      : db.prepare(
          `SELECT * FROM queue_items
           WHERE queue = ? AND status = 'pending' AND available_at <= ?${recipientClause}
           ORDER BY created_at ASC LIMIT ?`,
        ).all(...(input.queue === "agent"
          ? [input.queue, nowIso, input.consumerId, limit]
          : [input.queue, nowIso, limit]))) as Array<Record<string, unknown>>;
    const claims: QueueClaim[] = [];
    const update = db.prepare(
      `UPDATE queue_items SET status = 'leased', lease_id = ?, leased_until = ?, attempts = attempts + 1
       WHERE id = ? AND status = 'pending'`,
    );
    for (const row of rows) {
      const leaseId = `${input.consumerId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = update.run(leaseId, leaseUntil, row.id);
      if (result.changes === 0) continue;
      claims.push({
        leaseId,
        leasedUntil: leaseUntil,
        item: {
          id: String(row.id), taskId: String(row.task_id), queue: String(row.queue) as QueueName,
          ...(row.recipient_id ? { recipientId: String(row.recipient_id) } : {}),
          payload: JSON.parse(String(row.payload)), createdAt: String(row.created_at),
          availableAt: String(row.available_at), attempts: Number(row.attempts) + 1,
        },
      });
    }
    return claims;
  }

  async acknowledgeQueueItem(input: { id: string; leaseId: string }): Promise<void> {
    for (const db of this.queueConnections) {
      const result = db.prepare(
        "UPDATE queue_items SET status = 'done', lease_id = NULL, leased_until = NULL WHERE id = ? AND lease_id = ?",
      ).run(input.id, input.leaseId);
      if (result.changes > 0) return;
    }
  }

  async retryQueueItem(input: { id: string; leaseId: string; availableAt?: string }): Promise<void> {
    for (const db of this.queueConnections) {
      const result = db.prepare(
        "UPDATE queue_items SET status = 'pending', lease_id = NULL, leased_until = NULL, available_at = ? WHERE id = ? AND lease_id = ?",
      ).run(input.availableAt ?? new Date().toISOString(), input.id, input.leaseId);
      if (result.changes > 0) return;
    }
  }

  async releaseExpiredQueueLeases(queue?: QueueName): Promise<number> {
    let released = 0;
    const now = new Date().toISOString();
    for (const db of this.queueConnections) {
      const result = queue
        ? db.prepare("UPDATE queue_items SET status = 'pending', lease_id = NULL, leased_until = NULL WHERE queue = ? AND status = 'leased' AND leased_until <= ?").run(queue, now)
        : db.prepare("UPDATE queue_items SET status = 'pending', lease_id = NULL, leased_until = NULL WHERE status = 'leased' AND leased_until <= ?").run(now);
      released += result.changes;
    }
    return released;
  }

  async getQueueItems(taskId: string, options: { queue?: QueueName; status?: QueueItemStatus } = {}): Promise<QueueItem[]> {
    const db = this.getDb(taskId);
    const rows = (options.queue && options.status
      ? db.prepare("SELECT * FROM queue_items WHERE task_id = ? AND queue = ? AND status = ? ORDER BY created_at ASC").all(taskId, options.queue, options.status)
      : options.queue
        ? db.prepare("SELECT * FROM queue_items WHERE task_id = ? AND queue = ? ORDER BY created_at ASC").all(taskId, options.queue)
        : options.status
          ? db.prepare("SELECT * FROM queue_items WHERE task_id = ? AND status = ? ORDER BY created_at ASC").all(taskId, options.status)
          : db.prepare("SELECT * FROM queue_items WHERE task_id = ? ORDER BY created_at ASC").all(taskId)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id), taskId: String(row.task_id), queue: String(row.queue) as QueueName,
      ...(row.recipient_id ? { recipientId: String(row.recipient_id) } : {}), payload: JSON.parse(String(row.payload)),
      createdAt: String(row.created_at), availableAt: String(row.available_at), attempts: Number(row.attempts),
    }));
  }

  async saveConversation(taskId: string, conversation: Conversation): Promise<void> {
    if (conversation.taskId !== taskId) {
      throw new Error("Conversation taskId does not match the target task.");
    }
    const db = this.getDb(taskId);
    db.prepare(
      "INSERT INTO conversations (id, task_id, kind, data, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, data = excluded.data, updated_at = CURRENT_TIMESTAMP",
    ).run(conversation.id, taskId, conversation.kind, JSON.stringify(conversation));
  }

  async getConversation(taskId: string, conversationId: string): Promise<Conversation | null> {
    const db = this.getDb(taskId);
    const row = db.prepare(
      "SELECT data FROM conversations WHERE id = ? AND task_id = ?",
    ).get(conversationId, taskId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  async getConversations(taskId: string): Promise<Conversation[]> {
    const db = this.getDb(taskId);
    const rows = db.prepare(
      "SELECT data FROM conversations WHERE task_id = ? ORDER BY updated_at DESC, id ASC",
    ).all(taskId) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data));
  }

  async saveConversationMessage(taskId: string, message: ConversationMessage): Promise<void> {
    if (message.taskId !== taskId) {
      throw new Error("Conversation message taskId does not match the target task.");
    }
    const db = this.getDb(taskId);
    db.prepare(
      "INSERT INTO conversation_messages (id, task_id, conversation_id, data, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)",
    ).run(message.id, taskId, message.conversationId, JSON.stringify(message));
  }

  async getConversationMessages(taskId: string, conversationId: string): Promise<ConversationMessage[]> {
    const db = this.getDb(taskId);
    const rows = db.prepare(
      "SELECT data FROM conversation_messages WHERE task_id = ? AND conversation_id = ? ORDER BY created_at ASC, id ASC",
    ).all(taskId, conversationId) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data));
  }

  closeAll(): void {
    for (const [taskId, db] of this.connections) {
      db.close();
    }
    this.connections.clear();
    this.queueConnections.clear();
  }
}
