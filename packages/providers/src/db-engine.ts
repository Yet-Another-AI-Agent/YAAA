import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { WALRecord, CompactionCheckpoint } from "@yaaa/shared";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const SCHEMA_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
  {
    version: 2,
    name: "multi_loop_wal_and_compaction",
    sql: `
      CREATE TABLE IF NOT EXISTS wal_logs (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wal_logs_entity_seq
        ON wal_logs(entity_id, sequence ASC);

      CREATE TABLE IF NOT EXISTS compaction_checkpoints (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        summary TEXT NOT NULL,
        facts_extracted TEXT NOT NULL,
        files_touched TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_compaction_agent_seq
        ON compaction_checkpoints(agent_id, sequence DESC);

      CREATE TABLE IF NOT EXISTS outer_loop_state (
        task_id TEXT PRIMARY KEY,
        current_state TEXT NOT NULL,
        active_subtasks TEXT NOT NULL,
        facts TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_call_logs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        consumer_id TEXT NOT NULL,
        priority TEXT NOT NULL,
        model_used TEXT NOT NULL,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_call_logs_task_time
        ON ai_call_logs(task_id, timestamp ASC);
    `,
  },
];

export class DBEngine {
  private connections = new Map<string, Database.Database>();

  constructor(private readonly baseDir: string = "./.yaaa/tasks") {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Returns an isolated, WAL-enabled Database connection for a specific domain.
   */
  getIsolatedDb(dbKey: string, dbSubPath: string): Database.Database {
    let db = this.connections.get(dbKey);
    if (!db) {
      const fullPath = path.resolve(this.baseDir, dbSubPath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      db = new Database(fullPath);
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.pragma("busy_timeout = 5000");
      db.pragma("foreign_keys = ON");

      this.applyMigrations(db);
      this.connections.set(dbKey, db);
    }
    return db;
  }

  /** Gets or initializes the dedicated Outer Loop DB for a task. */
  getOuterLoopDb(taskId: string): Database.Database {
    return this.getIsolatedDb(`outer:${taskId}`, path.join(taskId, ".yaaa", "outer_loop.db"));
  }

  /** Gets or initializes the dedicated AI Call Loop DB for a task. */
  getAICallLoopDb(taskId: string): Database.Database {
    return this.getIsolatedDb(`ai:${taskId}`, path.join(taskId, ".yaaa", "ai_call_loop.db"));
  }

  /** Gets or initializes a dedicated Agent DB for a specific sub-agent. */
  getAgentDb(taskId: string, agentId: string): Database.Database {
    const safeId = agentId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "agent";
    return this.getIsolatedDb(`agent:${taskId}:${agentId}`, path.join(taskId, ".yaaa", "agents", safeId, "agent.db"));
  }

  /** Runs versioned migrations for database schema evolution. */
  private applyMigrations(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const appliedVersions = new Set<number>(
      (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version),
    );

    for (const migration of SCHEMA_MIGRATIONS) {
      if (!appliedVersions.has(migration.version)) {
        const runMigration = db.transaction(() => {
          db.exec(migration.sql);
          db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(
            migration.version,
            migration.name,
          );
        });
        runMigration();
      }
    }
  }

  /** Writes a Write-Ahead Log (WAL) record for an entity. */
  writeWALRecord(db: Database.Database, record: WALRecord): void {
    const stmt = db.prepare(
      "INSERT INTO wal_logs (id, entity_id, sequence, type, payload, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
    );
    stmt.run(
      record.id,
      record.entityId,
      record.sequence,
      record.type,
      JSON.stringify(record.payload),
      record.timestamp,
    );
  }

  /** Retrieves WAL records for recovery or inspection. */
  getWALRecords(db: Database.Database, entityId: string, fromSequence = 0): WALRecord[] {
    const rows = db
      .prepare("SELECT * FROM wal_logs WHERE entity_id = ? AND sequence >= ? ORDER BY sequence ASC")
      .all(entityId, fromSequence) as any[];

    return rows.map((r) => ({
      id: r.id,
      entityId: r.entity_id,
      sequence: r.sequence,
      type: r.type,
      payload: JSON.parse(r.payload),
      timestamp: r.timestamp,
    }));
  }

  /** Gets the latest WAL sequence number for an entity. */
  getLastWALSequence(db: Database.Database, entityId: string): number {
    const row = db
      .prepare("SELECT MAX(sequence) as max_seq FROM wal_logs WHERE entity_id = ?")
      .get(entityId) as { max_seq: number | null } | undefined;
    return row?.max_seq ?? 0;
  }

  /** Triggers a WAL checkpoint and compaction on the database connection. */
  walCheckpoint(db: Database.Database, mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE"): void {
    try {
      db.pragma(`wal_checkpoint(${mode})`);
    } catch {
      try {
        db.pragma("wal_checkpoint(PASSIVE)");
      } catch {
        // ignore lock
      }
    }
  }

  /** Saves a compaction checkpoint summary and prunes detailed raw WAL logs prior to checkpoint. */
  saveCompactionCheckpoint(db: Database.Database, checkpoint: CompactionCheckpoint): void {
    const insertStmt = db.prepare(
      "INSERT INTO compaction_checkpoints (id, agent_id, task_id, sequence, summary, facts_extracted, files_touched, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const deleteStmt = db.prepare(
      "DELETE FROM wal_logs WHERE entity_id = ? AND sequence <= ? AND type != 'CHECKPOINT'",
    );

    const runCompaction = db.transaction(() => {
      insertStmt.run(
        checkpoint.id,
        checkpoint.agentId,
        checkpoint.taskId,
        checkpoint.sequence,
        checkpoint.summary,
        JSON.stringify(checkpoint.factsExtracted),
        JSON.stringify(checkpoint.filesTouched),
        checkpoint.timestamp,
      );
      deleteStmt.run(checkpoint.agentId, checkpoint.sequence);
    });

    runCompaction();
    this.walCheckpoint(db, "PASSIVE");
  }

  /** Gets the latest compaction checkpoint for an agent. */
  getLatestCompactionCheckpoint(db: Database.Database, agentId: string): CompactionCheckpoint | null {
    const row = db
      .prepare("SELECT * FROM compaction_checkpoints WHERE agent_id = ? ORDER BY sequence DESC LIMIT 1")
      .get(agentId) as any;
    if (!row) return null;
    return {
      id: row.id,
      agentId: row.agent_id,
      taskId: row.task_id,
      sequence: row.sequence,
      summary: row.summary,
      factsExtracted: JSON.parse(row.facts_extracted),
      filesTouched: JSON.parse(row.files_touched),
      timestamp: row.timestamp,
    };
  }

  /** Closes all open connections safely. */
  closeAll(): void {
    for (const [key, db] of this.connections.entries()) {
      try {
        db.pragma("wal_checkpoint(TRUNCATE)");
        db.close();
      } catch (err) {
        console.warn(`[DBEngine] Failed to close DB ${key}:`, err);
      }
    }
    this.connections.clear();
  }
}
