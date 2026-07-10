import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { IConversationStore } from "@yaaa/interfaces";
import type {
  AgentMessage,
  AgentRun,
  Conversation,
  ConversationMessage,
  LedgerEntry,
  TaskPlan,
} from "@yaaa/shared";

export class SqliteStore implements IConversationStore {
  private baseDir: string;
  private connections = new Map<string, Database.Database>();

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
      const dbDir = path.join(this.baseDir, taskId, "databases");
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
      const dbPath = path.join(dbDir, "task.db");
      db = new Database(dbPath);
      
      // Run Migrations / Schema initialization
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          data TEXT NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );
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
      `);
      this.connections.set(taskId, db);
    }
    return db;
  }

  async initTaskDb(taskId: string): Promise<void> {
    this.getDb(taskId);
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
    const db = this.getDb(taskId);
    db.prepare(
      "INSERT INTO agents (id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP",
    ).run(agent.id, JSON.stringify(agent));
  }

  async getAgents(taskId: string): Promise<AgentRun[]> {
    const db = this.getDb(taskId);
    const rows = db.prepare("SELECT data FROM agents ORDER BY updated_at ASC").all() as { data: string }[];
    return rows.map((row) => JSON.parse(row.data));
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
  }
}
