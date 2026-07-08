import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { IStore } from "@yaaa/interfaces";
import type { AgentMessage, TaskPlan, LedgerEntry } from "@yaaa/shared";

export class SqliteStore implements IStore {
  private baseDir: string;
  private connections = new Map<string, Database.Database>();

  constructor(baseDir = "./.yaaa/tasks") {
    this.baseDir = path.resolve(baseDir);
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private getDb(taskId: string): Database.Database {
    let db = this.connections.get(taskId);
    if (!db) {
      const dbPath = path.join(this.baseDir, `${taskId}.db`);
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

  closeAll(): void {
    for (const [taskId, db] of this.connections) {
      db.close();
    }
    this.connections.clear();
  }
}
