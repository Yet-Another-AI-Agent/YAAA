import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { SqliteStore, MeshGateway } from "@yaaa/providers";
import { ORCHESTRATOR_MD_HEADERS, type AgentMessage } from "@yaaa/shared";
import { createRuntime } from "./runtime.js";
import type { RuntimeEvent, TaskRunResult } from "./events.js";

export interface AppConfig {
  accessToken?: string;
  preferredModels?: Record<string, string>;
  userName?: string;
  userProfession?: string;
  userDescription?: string;
  skipOnboarding?: boolean;
}

export interface TaskRow {
  id: string;
  prompt: string;
  status: string;
  path: string;
  created_at: string;
}

export interface CreatedTask {
  taskId: string;
  taskDir: string;
  workingDir: string;
}

export interface RunTaskHooks {
  onEvent?: (event: RuntimeEvent) => void;
  onApproval?: (agentId: string, call: any) => Promise<boolean>;
}

export interface ResumeProfile {
  name: string;
  profession: string;
  description: string;
}

/**
 * Workspace owns all global, app-wide state (config.json + main.db) and the
 * per-task folder lifecycle. It is the single place these stores are touched —
 * both the previous CLI and the Electron main process now go through it rather
 * than reaching for `fs`/`better-sqlite3` directly.
 *
 * This is the concrete home for the "global repository" tier; a future
 * `IGlobalStore` interface can be extracted from this class without moving the
 * logic again.
 */
export class Workspace {
  private readonly yaaaDir: string;
  private readonly configPath: string;

  constructor(yaaaDir?: string) {
    this.yaaaDir =
      yaaaDir ?? process.env.YAAA_DATA_DIR ?? path.join(os.homedir(), ".yaaa");
    this.configPath = path.join(this.yaaaDir, "config.json");
    if (!fs.existsSync(this.yaaaDir)) {
      fs.mkdirSync(this.yaaaDir, { recursive: true });
    }
  }

  getYaaaDir(): string {
    return this.yaaaDir;
  }

  private get tasksDir(): string {
    return path.join(this.yaaaDir, "tasks");
  }

  // ---------------------------------------------------------------- config

  loadConfig(): AppConfig {
    if (!fs.existsSync(this.configPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    } catch {
      return {};
    }
  }

  saveConfig(config: AppConfig): void {
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  getOnboardingStatus(): { hasKey: boolean; hasProfile: boolean; skipped: boolean } {
    const c = this.loadConfig();
    return {
      hasKey: !!c.accessToken,
      hasProfile: !!c.userName,
      skipped: !!c.skipOnboarding,
    };
  }

  getOnboardingProfile(): { name: string; profession: string; description: string } {
    const c = this.loadConfig();
    return {
      name: c.userName ?? "",
      profession: c.userProfession ?? "",
      description: c.userDescription ?? "",
    };
  }

  saveKey(key: string): { success: boolean } {
    const c = this.loadConfig();
    c.accessToken = key;
    this.saveConfig(c);
    return { success: true };
  }

  saveProfile(profile: {
    name?: string;
    profession?: string;
    description?: string;
    skip?: boolean;
  }): { success: boolean } {
    const c = this.loadConfig();
    if (profile.name !== undefined) c.userName = profile.name;
    if (profile.profession !== undefined) c.userProfession = profile.profession;
    if (profile.description !== undefined) c.userDescription = profile.description;
    if (profile.skip) c.skipOnboarding = true;
    this.saveConfig(c);
    return { success: true };
  }

  // ----------------------------------------------------------- main.db (tasks)

  private openMainDb(): Database.Database {
    const db = new Database(path.join(this.yaaaDir, "main.db"));
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    return db;
  }

  listTasks(): TaskRow[] {
    const db = this.openMainDb();
    try {
      return db
        .prepare(
          "SELECT id, prompt, status, path, created_at FROM tasks ORDER BY created_at DESC",
        )
        .all() as TaskRow[];
    } finally {
      db.close();
    }
  }

  private updateTaskStatus(taskId: string, status: string): void {
    const db = this.openMainDb();
    try {
      db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, taskId);
    } finally {
      db.close();
    }
  }

  async getTaskHistory(taskId: string): Promise<AgentMessage[]> {
    if (!/^[a-zA-Z0-9-]+$/.test(taskId)) return [];
    const store = new SqliteStore(this.tasksDir);
    try {
      return await store.getMessages(taskId);
    } finally {
      store.closeAll();
    }
  }

  readOrchestrator(taskId: string): string | null {
    if (!/^[a-zA-Z0-9-]+$/.test(taskId)) return null;
    const mdPath = path.resolve(path.join(this.tasksDir, taskId, "orchestrator.md"));
    if (!mdPath.startsWith(path.resolve(this.tasksDir))) return null;
    try {
      return fs.existsSync(mdPath) ? fs.readFileSync(mdPath, "utf-8") : null;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------- task lifecycle

  /**
   * Scaffold a new task folder, seed its initial artifacts, and register it in
   * main.db. Returns immediately so a frontend can hand the id back to the user
   * before the (async) run starts.
   */
  createTask(goal: string): CreatedTask {
    const taskId = crypto.randomUUID();
    const taskDir = path.join(this.tasksDir, taskId);
    const workingDir = path.join(taskDir, "working");

    fs.mkdirSync(workingDir, { recursive: true });
    fs.mkdirSync(path.join(taskDir, "databases"), { recursive: true });
    fs.mkdirSync(path.join(taskDir, "resources"), { recursive: true });

    fs.writeFileSync(
      path.join(taskDir, "orchestrator.md"),
      `${ORCHESTRATOR_MD_HEADERS.TITLE}\n\n* **Task ID**: ${taskId}\n* **Prompt**: ${goal}\n* **Status**: pending\n* **Created At**: ${new Date().toISOString()}\n\n${ORCHESTRATOR_MD_HEADERS.PLAN}\n*(Generating plan...)*\n`,
      "utf-8",
    );

    const config = this.loadConfig();
    fs.writeFileSync(
      path.join(taskDir, "models"),
      JSON.stringify(config.preferredModels ?? {}, null, 2),
      "utf-8",
    );
    fs.writeFileSync(path.join(taskDir, "agents"), JSON.stringify([], null, 2), "utf-8");

    const db = this.openMainDb();
    try {
      db.prepare(
        "INSERT INTO tasks (id, prompt, status, path) VALUES (?, ?, ?, ?)",
      ).run(taskId, goal, "running", taskDir);
    } finally {
      db.close();
    }

    return { taskId, taskDir, workingDir };
  }

  /**
   * Execute a previously-created task through the shared core runtime and
   * persist its final artifacts. Streams typed events via `hooks.onEvent`.
   */
  async runTask(
    goal: string,
    task: CreatedTask,
    hooks: RunTaskHooks = {},
  ): Promise<TaskRunResult> {
    const { taskId, taskDir, workingDir } = task;
    const config = this.loadConfig();

    const runtime = createRuntime({
      taskId,
      tasksBaseDir: this.tasksDir,
      workingDir,
      apiKey: config.accessToken ?? process.env.MESH_API_KEY ?? undefined,
      modelMapping: config.preferredModels ?? undefined,
      onEvent: hooks.onEvent,
      onApproval: hooks.onApproval,
    });

    try {
      const result = await runtime.run(goal);
      this.updateTaskStatus(taskId, result.success ? "success" : "failed");
      const ledger = await runtime.store.getLedgerEntries(taskId);
      this.writeOrchestratorMd(
        taskDir,
        taskId,
        goal,
        result.success ? "success" : "failed",
        result.plan,
        ledger,
      );
      const messages = await runtime.store.getMessages(taskId);
      const agents = Array.from(
        new Set(
          messages
            .filter((m: any) => m.from && String(m.from).includes("agent-"))
            .map((m: any) => m.from),
        ),
      );
      fs.writeFileSync(
        path.join(taskDir, "agents"),
        JSON.stringify(agents, null, 2),
        "utf-8",
      );
      return result;
    } catch (err) {
      this.updateTaskStatus(taskId, "failed");
      try {
        const finalPlan = await runtime.store.getPlan(taskId);
        const ledger = await runtime.store.getLedgerEntries(taskId);
        this.writeOrchestratorMd(taskDir, taskId, goal, "failed", finalPlan, ledger);
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      runtime.dispose();
    }
  }

  // ------------------------------------------------------------- resume parse

  async parseResume(text: string): Promise<ResumeProfile> {
    const fallback: ResumeProfile = {
      name: "Mock User",
      profession: "Software Engineer",
      description: "Biography extracted from resume.",
    };
    const config = this.loadConfig();
    const apiKey = config.accessToken ?? process.env.MESH_API_KEY;
    if (!apiKey || !text) return fallback;

    try {
      const gateway = new MeshGateway({
        apiKey,
        modelMapping: config.preferredModels as any,
      });
      const resultText = await gateway.chat(
        [
          {
            role: "system" as const,
            content:
              'You are a resume data extractor. Respond ONLY with a valid JSON object matching the format: { "name": "...", "profession": "...", "description": "..." }.',
          },
          { role: "user" as const, content: text },
        ],
        { modelRole: "utility", jsonMode: true, temperature: 0 },
      );
      const parsed = JSON.parse(resultText);
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  // ------------------------------------------------------------------- md gen

  private writeOrchestratorMd(
    taskDir: string,
    taskId: string,
    prompt: string,
    status: string,
    plan: any,
    ledgerEntries: any[],
  ): void {
    let content = `${ORCHESTRATOR_MD_HEADERS.TITLE}\n\n`;
    content += `* **Task ID**: ${taskId}\n`;
    content += `* **Prompt**: ${prompt}\n`;
    content += `* **Status**: ${status}\n`;
    content += `* **Updated At**: ${new Date().toISOString()}\n\n`;

    if (plan) {
      content += `${ORCHESTRATOR_MD_HEADERS.PLAN}\n`;
      content += `Goal: ${plan.goal}\n\n`;
      for (const subtask of plan.subtasks ?? []) {
        content += `- **[${subtask.id}]** ${subtask.title}\n`;
        content += `  - Capability: \`${subtask.capability}\`\n`;
        content += `  - Status: \`${subtask.state || "pending"}\`\n`;
        content += `  - Success Criteria: *${subtask.successCriteria}*\n`;
        if (subtask.dependsOn && subtask.dependsOn.length > 0) {
          content += `  - Dependencies: [${subtask.dependsOn.join(", ")}]\n`;
        }
        content += `\n`;
      }
    }

    if (ledgerEntries && ledgerEntries.length > 0) {
      content += `${ORCHESTRATOR_MD_HEADERS.EXECUTION}\n\n`;
      for (const entry of ledgerEntries) {
        content += `${ORCHESTRATOR_MD_HEADERS.STEP} ${entry.step} (${entry.timestamp || new Date().toISOString()})\n`;
        content += `${ORCHESTRATOR_MD_HEADERS.STRATEGY} ${entry.nextStepStrategy}\n`;
        if (entry.facts && entry.facts.length > 0) {
          content += `${ORCHESTRATOR_MD_HEADERS.FACTS}\n`;
          for (const fact of entry.facts) content += `  - ${fact}\n`;
        }
        if (entry.assumptions && entry.assumptions.length > 0) {
          content += `${ORCHESTRATOR_MD_HEADERS.ASSUMPTIONS}\n`;
          for (const ass of entry.assumptions) content += `  - ${ass}\n`;
        }
        content += `\n`;
      }
    }

    fs.writeFileSync(path.join(taskDir, "orchestrator.md"), content, "utf-8");
  }
}
