import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { SqliteStore, MeshGateway } from "@yaaa/providers";
import { pauseController } from "@yaaa/platform";
import { IntentRouter } from "@yaaa/orchestrator";
import {
  ORCHESTRATOR_MD_HEADERS,
  type AgentMessage,
  type AgentRun,
  type Conversation,
  type ConversationAuthorKind,
  type ConversationMessage,
  type MentionRoute,
  type TaskPlan,
} from "@yaaa/shared";
import { ConversationCoordinator } from "./conversations.js";
import {
  cloneMcpIntegrationDefinition,
  type McpIntegrationDefinition,
  type McpIntegrationScope,
  type McpIntegrationState,
  type McpIntegrationStateUpdate,
  type RegisteredMcpIntegration,
  validateMcpIntegrationDefinition,
} from "./mcp-integrations.js";
import {
  McpProvisioner,
  type CommandRunner,
  type McpInstallSource,
  type McpProvisionResult,
} from "./mcp-provisioner.js";
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
  topic: string | null;
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

interface McpIntegrationRow {
  definition: string;
  state: string;
  created_at: string;
  updated_at: string;
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
  private topicColumnEnsured = false;
  private readonly deletedTasks = new Set<string>();
  private readonly activeTaskRuns = new Set<string>();

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

  getOnboardingStatus(): {
    hasKey: boolean;
    hasProfile: boolean;
    skipped: boolean;
  } {
    const c = this.loadConfig();
    return {
      hasKey: !!c.accessToken,
      hasProfile: !!c.userName,
      skipped: !!c.skipOnboarding,
    };
  }

  getOnboardingProfile(): {
    name: string;
    profession: string;
    description: string;
  } {
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
    if (profile.description !== undefined)
      c.userDescription = profile.description;
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
      CREATE TABLE IF NOT EXISTS mcp_integrations (
        id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'task')),
        task_id TEXT NOT NULL DEFAULT '',
        definition TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, task_id, id)
      );
    `);
    // Every task-related call opens a fresh connection, so guard the
    // migration with an instance flag — otherwise this throws-and-catches a
    // "duplicate column" error on every single query for the process's
    // lifetime once the column already exists.
    if (!this.topicColumnEnsured) {
      try {
        db.exec("ALTER TABLE tasks ADD COLUMN topic TEXT");
      } catch {
        // Column already exists from a previous run.
      }
      this.topicColumnEnsured = true;
    }
    return db;
  }

  listTasks(): TaskRow[] {
    const db = this.openMainDb();
    try {
      return db
        .prepare(
          "SELECT id, prompt, status, path, created_at, topic FROM tasks ORDER BY created_at DESC",
        )
        .all() as TaskRow[];
    } finally {
      db.close();
    }
  }

  private updateTaskStatus(taskId: string, status: string): void {
    const db = this.openMainDb();
    try {
      db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(
        status,
        taskId,
      );
    } finally {
      db.close();
    }
  }

  /** Atomically move a reviewed task into running state, even across processes. */
  private claimTaskForRun(taskId: string): TaskRow {
    const db = this.openMainDb();
    try {
      const task = db
        .prepare(
          "SELECT id, prompt, status, path, created_at, topic FROM tasks WHERE id = ?",
        )
        .get(taskId) as TaskRow | undefined;
      if (!task) throw new Error("Task not found.");
      const claimed = db
        .prepare(
          "UPDATE tasks SET status = 'running' WHERE id = ? AND status = 'awaiting_confirmation'",
        )
        .run(taskId);
      if (claimed.changes !== 1) {
        throw new Error("Task is not awaiting plan confirmation.");
      }
      return task;
    } finally {
      db.close();
    }
  }

  private updateTaskTopic(taskId: string, topic: string): void {
    const db = this.openMainDb();
    try {
      db.prepare("UPDATE tasks SET topic = ? WHERE id = ?").run(topic, taskId);
    } finally {
      db.close();
    }
  }

  private getTask(taskId: string): TaskRow | null {
    if (!/^[a-zA-Z0-9-]+$/.test(taskId)) return null;
    const db = this.openMainDb();
    try {
      return (
        (db
          .prepare(
            "SELECT id, prompt, status, path, created_at, topic FROM tasks WHERE id = ?",
          )
          .get(taskId) as TaskRow | undefined) ?? null
      );
    } finally {
      db.close();
    }
  }

  private requireTask(taskId: string): TaskRow {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    return task;
  }

  private integrationScopeKey(scope: McpIntegrationScope): {
    kind: "global" | "task";
    taskId: string;
  } {
    if (scope.kind === "global") return { kind: "global", taskId: "" };
    this.requireTask(scope.taskId);
    return { kind: "task", taskId: scope.taskId };
  }

  private parseMcpIntegration(
    row: McpIntegrationRow,
    scope: McpIntegrationScope,
  ): RegisteredMcpIntegration {
    const definition: unknown = JSON.parse(row.definition);
    const state: unknown = JSON.parse(row.state);
    validateMcpIntegrationDefinition(definition);
    if (
      typeof state !== "object" ||
      state === null ||
      !("trust" in state) ||
      !("enabled" in state) ||
      (state.trust !== "trusted" && state.trust !== "untrusted") ||
      typeof state.enabled !== "boolean"
    ) {
      throw new Error("Stored MCP integration state is invalid.");
    }
    return {
      definition: cloneMcpIntegrationDefinition(definition),
      scope: scope.kind === "global" ? { kind: "global" } : { ...scope },
      state: { trust: state.trust, enabled: state.enabled },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Register metadata in a disabled, untrusted state. No server is installed or started. */
  registerMcpIntegration(
    scope: McpIntegrationScope,
    definition: McpIntegrationDefinition,
  ): RegisteredMcpIntegration {
    validateMcpIntegrationDefinition(definition);
    const key = this.integrationScopeKey(scope);
    const safeDefinition = cloneMcpIntegrationDefinition(definition);
    const safeState: McpIntegrationState = {
      trust: "untrusted",
      enabled: false,
    };
    const now = new Date().toISOString();
    const db = this.openMainDb();
    try {
      db.prepare(
        `INSERT INTO mcp_integrations
          (id, scope, task_id, definition, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, task_id, id) DO UPDATE SET
           definition = excluded.definition,
           state = excluded.state,
           updated_at = excluded.updated_at`,
      ).run(
        safeDefinition.id,
        key.kind,
        key.taskId,
        JSON.stringify(safeDefinition),
        JSON.stringify(safeState),
        now,
        now,
      );
      return this.getMcpIntegration(scope, safeDefinition.id)!;
    } finally {
      db.close();
    }
  }

  listMcpIntegrations(scope: McpIntegrationScope): RegisteredMcpIntegration[] {
    const key = this.integrationScopeKey(scope);
    const db = this.openMainDb();
    try {
      const rows = db
        .prepare(
          `SELECT definition, state, created_at, updated_at
           FROM mcp_integrations
           WHERE scope = ? AND task_id = ?
           ORDER BY id`,
        )
        .all(key.kind, key.taskId) as McpIntegrationRow[];
      return rows.map((row) => this.parseMcpIntegration(row, scope));
    } finally {
      db.close();
    }
  }

  getMcpIntegration(
    scope: McpIntegrationScope,
    integrationId: string,
  ): RegisteredMcpIntegration | null {
    const key = this.integrationScopeKey(scope);
    const db = this.openMainDb();
    try {
      const row = db
        .prepare(
          `SELECT definition, state, created_at, updated_at
           FROM mcp_integrations
           WHERE scope = ? AND task_id = ? AND id = ?`,
        )
        .get(key.kind, key.taskId, integrationId) as
        | McpIntegrationRow
        | undefined;
      return row ? this.parseMcpIntegration(row, scope) : null;
    } finally {
      db.close();
    }
  }

  updateMcpIntegrationState(
    scope: McpIntegrationScope,
    integrationId: string,
    update: McpIntegrationStateUpdate,
  ): RegisteredMcpIntegration {
    const existing = this.getMcpIntegration(scope, integrationId);
    if (!existing) throw new Error("MCP integration not found.");
    const state: McpIntegrationState = {
      trust: update.trust ?? existing.state.trust,
      enabled: update.enabled ?? existing.state.enabled,
    };
    if (state.enabled && state.trust !== "trusted") {
      throw new Error(
        "An MCP integration must be trusted before it can be enabled.",
      );
    }
    const key = this.integrationScopeKey(scope);
    const db = this.openMainDb();
    try {
      db.prepare(
        `UPDATE mcp_integrations SET state = ?, updated_at = ?
         WHERE scope = ? AND task_id = ? AND id = ?`,
      ).run(
        JSON.stringify(state),
        new Date().toISOString(),
        key.kind,
        key.taskId,
        integrationId,
      );
    } finally {
      db.close();
    }
    return this.getMcpIntegration(scope, integrationId)!;
  }

  removeMcpIntegration(
    scope: McpIntegrationScope,
    integrationId: string,
  ): boolean {
    const key = this.integrationScopeKey(scope);
    const db = this.openMainDb();
    try {
      return (
        db
          .prepare(
            "DELETE FROM mcp_integrations WHERE scope = ? AND task_id = ? AND id = ?",
          )
          .run(key.kind, key.taskId, integrationId).changes === 1
      );
    } finally {
      db.close();
    }
  }

  /**
   * Permanently purge a mission: remove its row from main.db and delete its
   * on-disk task directory (per-task SQLite databases, orchestrator.md,
   * working files). Safe to call on a task that is still running — the
   * caller is responsible for detaching its event stream first since this
   * does not abort in-flight agent work, only its persisted state.
   */
  deleteTask(taskId: string): void {
    const task = this.requireTask(taskId);
    this.deletedTasks.add(taskId);
    const db = this.openMainDb();
    try {
      db.prepare(
        "DELETE FROM mcp_integrations WHERE scope = 'task' AND task_id = ?",
      ).run(taskId);
      db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    } finally {
      db.close();
    }
    fs.rmSync(task.path, { recursive: true, force: true });
  }

  private async withConversationCoordinator<T>(
    operation: (conversations: ConversationCoordinator) => Promise<T>,
  ): Promise<T> {
    const store = new SqliteStore(this.tasksDir);
    try {
      return await operation(new ConversationCoordinator(store));
    } finally {
      store.closeAll();
    }
  }

  async getTaskHistory(taskId: string): Promise<AgentMessage[]> {
    this.requireTask(taskId);
    const store = new SqliteStore(this.tasksDir);
    try {
      return await store.getMessages(taskId);
    } finally {
      store.closeAll();
    }
  }

  async getTaskAgents(taskId: string): Promise<AgentRun[]> {
    this.requireTask(taskId);
    const store = new SqliteStore(this.tasksDir);
    try {
      return await store.getAgents(taskId);
    } finally {
      store.closeAll();
    }
  }

  async createPublicConversation(
    taskId: string,
    title?: string,
  ): Promise<Conversation> {
    this.requireTask(taskId);
    return this.withConversationCoordinator((conversations) =>
      conversations.createPublicConversation({ taskId, title }),
    );
  }

  async getOrCreateAgentThread(
    taskId: string,
    agentId: string,
  ): Promise<Conversation> {
    this.requireTask(taskId);
    const agents = await this.getTaskAgents(taskId);
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error("Agent not found for this mission.");
    return this.withConversationCoordinator((conversations) =>
      conversations.getOrCreateAgentThread(taskId, agent),
    );
  }

  async getTaskConversations(taskId: string): Promise<Conversation[]> {
    this.requireTask(taskId);
    return this.withConversationCoordinator((conversations) =>
      conversations.listConversations(taskId),
    );
  }

  async getConversationMessages(
    taskId: string,
    conversationId: string,
  ): Promise<ConversationMessage[]> {
    this.requireTask(taskId);
    return this.withConversationCoordinator((conversations) =>
      conversations.listMessages(taskId, conversationId),
    );
  }

  async postConversationMessage(input: {
    taskId: string;
    conversationId: string;
    authorId: string;
    authorKind: ConversationAuthorKind;
    content: string;
  }): Promise<{
    message: ConversationMessage;
    routes: MentionRoute[];
    pausedAgentIds: string[];
  }> {
    this.requireTask(input.taskId);
    const posted = await this.withConversationCoordinator((conversations) =>
      conversations.postMessage(input),
    );
    // Blueprint: "@agent-name pauses that specific agent's execution loop and
    // forces a sub-thread". Only user messages pause; agent/orchestrator
    // chatter must never freeze a colleague.
    const pausedAgentIds: string[] = [];
    if (input.authorKind === "user") {
      for (const route of posted.routes) {
        if (route.recipientKind === "agent") {
          pauseController.pause(route.recipientId);
          pausedAgentIds.push(route.recipientId);
        }
      }
    }
    return { ...posted, pausedAgentIds };
  }

  /** Release a paused agent's execution loop (end of the sub-thread). */
  resumeAgent(agentId: string): boolean {
    return pauseController.resume(agentId);
  }

  /** Agent ids currently paused by @mentions. */
  getPausedAgents(): string[] {
    return pauseController.pausedAgents();
  }

  readOrchestrator(taskId: string): string | null {
    if (!/^[a-zA-Z0-9-]+$/.test(taskId)) return null;
    const mdPath = path.resolve(
      path.join(this.tasksDir, taskId, "orchestrator.md"),
    );
    if (!mdPath.startsWith(path.resolve(this.tasksDir))) return null;
    try {
      return fs.existsSync(mdPath) ? fs.readFileSync(mdPath, "utf-8") : null;
    } catch {
      return null;
    }
  }

  /** Read a generated artifact's text content for in-app preview (Markdown/plaintext only). */
  readArtifact(taskId: string, artifactPath: string): string | null {
    if (!this.getTask(taskId)) return null;
    try {
      const workingDir = fs.realpathSync(
        path.join(this.tasksDir, taskId, "working"),
      );
      const filePath = fs.realpathSync(path.resolve(workingDir, artifactPath));
      const relativePath = path.relative(workingDir, filePath);
      if (
        relativePath === "" ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        return null;
      }
      if (!fs.statSync(filePath).isFile()) return null;
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Fetch and install a registered, trusted MCP server (git clone + npm
   * install) into the global MCP directory, then enable it. This is the
   * blueprint's "MCP Fetcher": registration records consent, provisioning
   * performs the actual dynamic fetch. Untrusted integrations are refused.
   */
  async provisionMcpIntegration(
    scope: McpIntegrationScope,
    integrationId: string,
    source: McpInstallSource,
    runCommand?: CommandRunner,
  ): Promise<McpProvisionResult> {
    const integration = this.getMcpIntegration(scope, integrationId);
    if (!integration) throw new Error("MCP integration not found.");
    const provisioner = new McpProvisioner(
      path.join(this.yaaaDir, "mcp-servers"),
      runCommand,
    );
    const result = await provisioner.provision(integration, source);
    this.updateMcpIntegrationState(scope, integrationId, { enabled: true });
    return result;
  }

  // ------------------------------------------------------------ intent routing

  /**
   * Classify a user message BEFORE any task machinery runs. Conversational
   * messages ("hi", "thanks", "what can you do?") get an orchestrator reply
   * and never create a task folder, DB row, UUID channel, or plan. Only
   * genuine work requests should proceed to {@link createTask}.
   */
  async routeUserMessage(
    message: string,
  ): Promise<{ kind: "conversation"; reply: string } | { kind: "task" }> {
    const config = this.loadConfig();
    const gateway = new MeshGateway({
      apiKey: config.accessToken ?? process.env.MESH_API_KEY ?? undefined,
      modelMapping: config.preferredModels as any,
    });
    const router = new IntentRouter(gateway);
    const decision = await router.route(message, { userName: config.userName });
    if (decision.intent === "conversation") {
      return {
        kind: "conversation",
        reply:
          decision.reply ??
          "Hello! I'm the YAAA orchestrator. What are we building or working on today?",
      };
    }
    return { kind: "task" };
  }

  /**
   * Read a binary artifact (image) as a data-URL for in-app preview. Applies
   * the same containment rules as {@link readArtifact}; refuses non-image
   * extensions and files over 8 MB.
   */
  readArtifactBinary(
    taskId: string,
    artifactPath: string,
  ): { dataUrl: string; mimeType: string } | null {
    const IMAGE_MIME: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
    };
    if (!this.getTask(taskId)) return null;
    const mimeType = IMAGE_MIME[path.extname(artifactPath).toLowerCase()];
    if (!mimeType) return null;
    try {
      const workingDir = fs.realpathSync(
        path.join(this.tasksDir, taskId, "working"),
      );
      const filePath = fs.realpathSync(path.resolve(workingDir, artifactPath));
      const relativePath = path.relative(workingDir, filePath);
      if (
        relativePath === "" ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        return null;
      }
      const stats = fs.statSync(filePath);
      if (!stats.isFile() || stats.size > 8 * 1024 * 1024) return null;
      const base64 = fs.readFileSync(filePath).toString("base64");
      return { dataUrl: `data:${mimeType};base64,${base64}`, mimeType };
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------- visual annotations

  /**
   * Persist canvas-commenter bounding boxes for an artifact and route the
   * JSON payload to @orchestrator through the mission's public conversation,
   * so the orchestrator can forward the visual fix to the owning agent.
   */
  async saveArtifactAnnotations(
    taskId: string,
    artifactPath: string,
    annotations: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      comment: string;
    }>,
  ): Promise<{ annotationPath: string; routes: MentionRoute[] }> {
    const task = this.requireTask(taskId);
    if (this.readArtifact(taskId, artifactPath) === null) {
      // Binary artifacts (images/PDFs) can't be read as text but are still
      // annotatable — verify containment + existence without reading.
      const workingDir = fs.realpathSync(path.join(task.path, "working"));
      let resolved: string;
      try {
        resolved = fs.realpathSync(path.resolve(workingDir, artifactPath));
      } catch {
        throw new Error("Annotated artifact was not found.");
      }
      const relative = path.relative(workingDir, resolved);
      if (
        relative === "" ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        !fs.statSync(resolved).isFile()
      ) {
        throw new Error("Annotated artifact was not found.");
      }
    }
    for (const box of annotations) {
      const dimensionsValid = [box.x, box.y, box.width, box.height].every(
        (value) => Number.isFinite(value) && value >= 0,
      );
      if (!dimensionsValid || typeof box.comment !== "string" || !box.comment.trim()) {
        throw new Error("Each annotation needs a bounding box and a comment.");
      }
    }

    const payload = {
      artifactPath,
      createdAt: new Date().toISOString(),
      annotations,
    };
    const annotationsDir = path.join(task.path, "annotations");
    fs.mkdirSync(annotationsDir, { recursive: true });
    const annotationPath = path.join(
      annotationsDir,
      `${artifactPath.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`,
    );
    fs.writeFileSync(annotationPath, JSON.stringify(payload, null, 2), "utf-8");

    const routed = await this.withConversationCoordinator(async (conversations) => {
      const existing = (await conversations.listConversations(taskId)).find(
        (conversation) => conversation.kind === "public" && !conversation.archivedAt,
      );
      const conversation =
        existing ?? (await conversations.createPublicConversation({ taskId }));
      return conversations.postMessage({
        taskId,
        conversationId: conversation.id,
        authorId: "user",
        authorKind: "user",
        content: `@orchestrator Visual feedback on ${artifactPath}: ${JSON.stringify(annotations)}`,
      });
    });

    return { annotationPath, routes: routed.routes };
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
    fs.writeFileSync(
      path.join(taskDir, "agents"),
      JSON.stringify([], null, 2),
      "utf-8",
    );

    const db = this.openMainDb();
    try {
      db.prepare(
        "INSERT INTO tasks (id, prompt, status, path) VALUES (?, ?, ?, ?)",
      ).run(taskId, goal, "planning", taskDir);
    } finally {
      db.close();
    }

    return { taskId, taskDir, workingDir };
  }

  /**
   * Ask the utility model for a short, human-readable channel topic and
   * persist it once ready. Runs in the background alongside planning — a slow
   * or failed call must never delay or block the plan the user is waiting on.
   */
  private requestTopicGeneration(
    goal: string,
    taskId: string,
    config: AppConfig,
    onEvent?: (event: RuntimeEvent) => void,
  ): void {
    const gateway = new MeshGateway({
      apiKey: config.accessToken ?? process.env.MESH_API_KEY ?? undefined,
      modelMapping: config.preferredModels as any,
    });
    gateway
      .chat(
        [
          {
            role: "system",
            content:
              "Generate a short channel topic slug (2-4 words, lowercase, hyphen-separated, no punctuation) that summarizes this request. Respond with ONLY the slug, nothing else.",
          },
          { role: "user", content: goal },
        ],
        { modelRole: "utility", temperature: 0.3 },
      )
      .then((raw) => {
        if (this.deletedTasks.has(taskId)) return;
        const topic = this.sanitizeTopic(raw);
        if (!topic) return;
        this.updateTaskTopic(taskId, topic);
        onEvent?.({ type: "topic-updated", taskId, topic });
      })
      .catch(() => {
        // Best-effort: the raw-slug channel name remains as a fallback.
      });
  }

  private sanitizeTopic(raw: string): string {
    return raw
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .split("-")
      .filter(Boolean)
      .slice(0, 4)
      .join("-")
      .substring(0, 40);
  }

  /** Generate the plan and leave this task waiting for a user decision. */
  async prepareTask(
    goal: string,
    task: CreatedTask,
    hooks: RunTaskHooks = {},
  ): Promise<TaskPlan> {
    const config = this.loadConfig();
    const runtime = createRuntime({
      taskId: task.taskId,
      tasksBaseDir: this.tasksDir,
      workingDir: task.workingDir,
      apiKey: config.accessToken ?? process.env.MESH_API_KEY ?? undefined,
      modelMapping: config.preferredModels ?? undefined,
      onEvent: (event) => {
        if (!this.deletedTasks.has(task.taskId)) hooks.onEvent?.(event);
      },
      onApproval: hooks.onApproval
        ? (agentId, call) =>
            this.deletedTasks.has(task.taskId)
              ? Promise.resolve(false)
              : hooks.onApproval!(agentId, call)
        : undefined,
      isCancelled: () => this.deletedTasks.has(task.taskId),
    });

    this.requestTopicGeneration(goal, task.taskId, config, hooks.onEvent);

    try {
      const plan = await runtime.plan(goal);
      if (this.deletedTasks.has(task.taskId))
        throw new Error("Task was deleted.");
      this.updateTaskStatus(task.taskId, "awaiting_confirmation");
      this.writeOrchestratorMd(
        task.taskDir,
        task.taskId,
        goal,
        "awaiting_confirmation",
        plan,
        [],
      );
      return plan;
    } catch (err) {
      if (!this.deletedTasks.has(task.taskId)) {
        this.updateTaskStatus(task.taskId, "failed");
      }
      throw err;
    } finally {
      runtime.dispose();
      if (this.deletedTasks.has(task.taskId)) {
        fs.rmSync(task.taskDir, { recursive: true, force: true });
      }
    }
  }

  /** Start a prepared plan only after an explicit user confirmation. */
  async confirmTask(
    taskId: string,
    hooks: RunTaskHooks = {},
  ): Promise<TaskRunResult> {
    const row = this.claimTaskForRun(taskId);

    const store = new SqliteStore(this.tasksDir);
    let plan: TaskPlan | null;
    try {
      plan = await store.getPlan(taskId);
    } finally {
      store.closeAll();
    }
    if (!plan) {
      this.updateTaskStatus(taskId, "failed");
      throw new Error("Task plan is missing; create a new mission instead.");
    }
    return this.runTask(
      row.prompt,
      { taskId, taskDir: row.path, workingDir: path.join(row.path, "working") },
      hooks,
      plan,
    );
  }

  /**
   * Execute a previously-created task through the shared core runtime and
   * persist its final artifacts. Streams typed events via `hooks.onEvent`.
   */
  async runTask(
    goal: string,
    task: CreatedTask,
    hooks: RunTaskHooks = {},
    preparedPlan?: TaskPlan,
  ): Promise<TaskRunResult> {
    const { taskId, taskDir, workingDir } = task;
    if (this.deletedTasks.has(taskId)) throw new Error("Task was deleted.");
    if (this.activeTaskRuns.has(taskId))
      throw new Error("Task is already running.");
    this.activeTaskRuns.add(taskId);
    const config = this.loadConfig();

    const runtime = createRuntime({
      taskId,
      tasksBaseDir: this.tasksDir,
      workingDir,
      apiKey: config.accessToken ?? process.env.MESH_API_KEY ?? undefined,
      modelMapping: config.preferredModels ?? undefined,
      onEvent: (event) => {
        if (!this.deletedTasks.has(taskId)) hooks.onEvent?.(event);
      },
      onApproval: hooks.onApproval
        ? (agentId, call) =>
            this.deletedTasks.has(taskId)
              ? Promise.resolve(false)
              : hooks.onApproval!(agentId, call)
        : undefined,
      isCancelled: () => this.deletedTasks.has(taskId),
    });

    try {
      const result = preparedPlan
        ? await runtime.runPlan(preparedPlan)
        : await runtime.run(goal);
      if (this.deletedTasks.has(taskId)) throw new Error("Task was deleted.");
      this.updateTaskStatus(taskId, result.success ? "success" : "failed");
      const ledger = await runtime.store.getLedgerEntries(taskId);
      if (this.deletedTasks.has(taskId)) throw new Error("Task was deleted.");
      this.writeOrchestratorMd(
        taskDir,
        taskId,
        goal,
        result.success ? "success" : "failed",
        result.plan,
        ledger,
      );
      const messages = await runtime.store.getMessages(taskId);
      if (this.deletedTasks.has(taskId)) throw new Error("Task was deleted.");
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
      if (this.deletedTasks.has(taskId)) throw err;
      this.updateTaskStatus(taskId, "failed");
      try {
        const finalPlan = await runtime.store.getPlan(taskId);
        const ledger = await runtime.store.getLedgerEntries(taskId);
        this.writeOrchestratorMd(
          taskDir,
          taskId,
          goal,
          "failed",
          finalPlan,
          ledger,
        );
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      runtime.dispose();
      this.activeTaskRuns.delete(taskId);
      if (this.deletedTasks.has(taskId)) {
        fs.rmSync(taskDir, { recursive: true, force: true });
      }
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
