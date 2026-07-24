import type {
  ChatMessage,
  ChatOptions,
  IBus,
  IFiles,
  IMeshGateway,
  IStore,
  ITaskReader,
  ModelRole,
  ModelResolver,
  ChatResult,
} from "@yaaa/interfaces";
import { Container, DurableEventQueue, MessageBus, PermissionEngine, orchestratorMailbox } from "@yaaa/platform";
import type { IQueueStore } from "@yaaa/interfaces";
import { SqliteStore, SqliteTaskReader, FilesFs, MeshGateway, CmdTool, WebSearchTool, ChromiumTool, ExecutionSessionManager } from "@yaaa/providers";
import type { MeshModelCatalogEntry } from "@yaaa/providers";
import { buildPlannerModelMenu, isEligible, renderPlannerModelMenu, resolveModelFromCatalog } from "./model-catalog.js";
import { benchmarkRoleDefaults, selectBenchmarkModel } from "./benchmark-registry.js";
import { ChatOpenAI } from "@langchain/openai";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult as LcChatResult } from "@langchain/core/outputs";

/**
 * Deterministic stand-in for the worker/verifier chat model when no API key is
 * set — the ReAct-agent equivalent of MeshGateway's mock mode, so keyless demos
 * and tests still complete a task lifecycle without any network calls. It never
 * calls tools; it just reports completion (verifiers pass).
 */
class MockWorkerChatModel extends BaseChatModel {
  constructor(private readonly roleOrModel: string) {
    super({});
  }
  _llmType() {
    return "yaaa-mock-worker";
  }
  async _generate(messages: BaseMessage[]): Promise<LcChatResult> {
    // A verifier subtask is usually created with an explicit model id (e.g.
    // "anthropic/claude-haiku-4.5") rather than the bare "verifier" role, so the
    // role name alone isn't enough to know this is a verification turn. Detect
    // the verifier contract from the prompt too — the verifier system prompts all
    // require the {"status":"passed"|"failed"} JSON shape — so mock mode always
    // returns a well-formed verifier verdict instead of prose that fails parsing.
    const joined = messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    const isVerifier =
      this.roleOrModel === "verifier" ||
      /"status"\s*:\s*"passed"\s*\|\s*"failed"/i.test(joined);
    const text = isVerifier
      ? JSON.stringify({ status: "passed", summary: "Mock verification: all stated criteria appear satisfied.", findings: [], evidence: ["Deterministic mock-mode verification"] })
      : "Mock mode: subtask completed (no live model configured).";
    const message = new AIMessage({ content: text });
    return { generations: [{ text, message }] };
  }
  override bindTools() {
    return this;
  }
}
import { Supervisor, type PlanContext } from "@yaaa/orchestrator";
import type { AgentRun, Subtask, TaskPlan, ModelPreference } from "@yaaa/shared";
import {
  type RuntimeEvent,
  type TaskRunResult,
  mapBusEvent,
} from "./events.js";

export interface RuntimeConfig {
  /** Stable id for this task; also the scope key for the task store. */
  taskId: string;
  /** Base directory that holds per-task SQLite databases (e.g. ~/.yaaa/tasks). */
  tasksBaseDir: string;
  /** Jailed working directory the files capability is allowed to touch. */
  workingDir: string;
  /** Mesh API key; when omitted the gateway runs in deterministic mock mode. */
  apiKey?: string;
  /** Optional per-role model overrides. */
  modelMapping?: Record<string, string>;
  /** Persisted user quality/cost policy, applied to planner and workers. */
  modelPreference?: ModelPreference;
  /** Typed event sink — the only channel a frontend should render from. */
  onEvent?: (event: RuntimeEvent) => void;
  /** Human-in-the-loop approval hook for gated tool calls. */
  onApproval?: (agentId: string, call: any) => Promise<boolean>;
  /** Cooperative cancellation checked between model and file operations. */
  isCancelled?: () => boolean;
  /** API request timeout in milliseconds. */
  timeout?: number;
  /** Maximum number of retries for API requests. */
  maxRetries?: number;
}

/**
 * A composed, ready-to-run engine instance. Owns the DI wiring and the
 * bus→typed-event bridge, and exposes a minimal lifecycle. Frontends should
 * treat `store`/`bus` as read-only handles for post-run queries and never
 * reach past this object into the container.
 */
export interface Runtime {
  readonly store: IStore;
  readonly reader: ITaskReader;
  readonly bus: IBus;
  /** Create a durable draft plan; it does not start any agent work. */
  plan(goal: string, context?: PlanContext): Promise<TaskPlan>;
  /** Execute a plan that was already reviewed by the user. */
  runPlan(plan: TaskPlan): Promise<TaskRunResult>;
  run(goal: string): Promise<TaskRunResult>;
  dispose(): void;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "agent";
}

const PREFERENCE_DEFAULTS: Record<ModelPreference, string> = {
  sota: "openai/gpt-5.5-pro",
  balanced: "google/gemini-3.1-pro-preview",
  "cost-effective": "google/gemini-3.1-flash-lite-preview",
};

function preferenceDefault(preference: ModelPreference | undefined): string {
  return PREFERENCE_DEFAULTS[preference ?? "balanced"];
}

/** Apply the bundled benchmark policy. This is deliberately local and deterministic;
 * the Mesh catalog is used only to intersect the candidates with live availability. */
async function recommendPlanModels(
  plan: TaskPlan,
  preference: ModelPreference,
  catalog: MeshModelCatalogEntry[],
): Promise<void> {
  for (const subtask of plan.subtasks) {
    const role = subtask.agentTemplate === "PlannerAgent" ? "planner" : subtask.agentTemplate === "QaTesterAgent" ? "verifier" : "worker";
    const selected = selectBenchmarkModel(catalog, preference, role, subtask.capability as Parameters<typeof selectBenchmarkModel>[3]);
    subtask.model = selected.model;
    subtask.modelReason = selected.reason;
  }
}

function writeAgentLifecycleDocument(
  config: RuntimeConfig,
  agent: AgentRun,
  subtask?: Subtask,
): void {
  const legacyAgentDir = path.join(
    config.tasksBaseDir,
    safePathSegment(agent.taskId),
    "agent-workspaces",
    safePathSegment(agent.id),
  );
  const workspaceAgentDir = path.join(
    config.workingDir,
    "agent-workspaces",
    safePathSegment(agent.id),
  );
  fs.mkdirSync(legacyAgentDir, { recursive: true });
  fs.mkdirSync(workspaceAgentDir, { recursive: true });

  if (["planned", "working"].includes(agent.status)) {
    const handsOnPath = path.join(legacyAgentDir, "HANDS_ON.md");
    if (!fs.existsSync(handsOnPath)) {
      fs.writeFileSync(handsOnPath, `# handsOn\n\n- Task: ${agent.taskId}\n- Agent: ${agent.handle} (${agent.displayName})\n- Role: ${agent.role}\n- Subtask: ${agent.subtaskId}\n- Goal: ${subtask?.title ?? agent.initialGoal ?? "Not specified"}\n- Success criteria: ${subtask?.successCriteria ?? "Not specified"}\n- Status: ${agent.status}\n`, "utf-8");
    }
  }

  if (["completed", "failed", "exited"].includes(agent.status)) {
    const handsOff = `# handOff

- Task: ${agent.taskId}
- Agent: ${agent.handle} (${agent.displayName})
- Role: ${agent.role}
- Subtask: ${agent.subtaskId}
- Status: ${agent.status}
- Finished: ${agent.finishedAt ?? "Not recorded"}

## Summary

${agent.summary?.trim() || "No summary was provided."}

## Changed Files

- _Record changed files here._

## Tests

- _Record tests run and their outcomes here._

## Risks

- _Record residual risks or write None identified._

## Follow-up Work

- _Record follow-up work or write None._
`;
    const legacyHandoffPath = path.join(legacyAgentDir, "HANDS_OFF.md");
    if (!fs.existsSync(legacyHandoffPath)) {
      fs.writeFileSync(legacyHandoffPath, handsOff, "utf-8");
    }
  }
}

/**
 * Compose the engine for a single task: register providers behind their
 * interfaces in the DI container, bridge the internal message bus to the typed
 * {@link RuntimeEvent} stream, and hand back a small lifecycle object.
 *
 * This is the shared composition root previously inlined in `apps/cli`. Both
 * the CLI and the Electron main process are expected to call this rather than
 * wiring providers themselves — keeping a single place where concrete
 * implementations are bound to interfaces.
 */
export function createRuntime(config: RuntimeConfig): Runtime {
  const assertActive = () => {
    if (config.isCancelled?.()) throw new Error("Task was cancelled.");
  };
  assertActive();
  const store = new SqliteStore(config.tasksBaseDir);
  // The bus persists to THIS task's store (injected), not a global one — so two
  // concurrent task runtimes never write through each other's connection.
  const bus = new MessageBus(store);
  const durableQueue = new DurableEventQueue(store as IQueueStore);
  orchestratorMailbox.attachQueue(config.taskId, durableQueue);
  const permissions = new PermissionEngine();
  const preference = config.modelPreference ?? "balanced";
  const roleDefaults = benchmarkRoleDefaults(preference);
  const meshGateway = new MeshGateway({
    apiKey: config.apiKey,
    modelPreference: preference,
    modelMapping: {
      planner: roleDefaults.planner,
      worker: roleDefaults.worker,
      verifier: roleDefaults.verifier,
      utility: roleDefaults.utility,
      ...(config.modelMapping as Record<ModelRole, string> | undefined),
    },
    timeout: config.timeout,
    maxRetries: config.maxRetries,
  });
  const filesProvider = new FilesFs(config.workingDir);
  const shellProvider = new CmdTool();
  const browserProvider = new ChromiumTool(config.workingDir);
  const executionSessions = new ExecutionSessionManager(store);
  const recordLlmEvent = async (topic: string, payload: unknown) => {
    await store.saveRuntimeEvent?.({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      taskId: config.taskId,
      topic,
      timestamp: new Date().toISOString(),
      payload,
    });
  };
  const gateway: IMeshGateway = {
    async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
      assertActive();
      const callId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await recordLlmEvent("llm.call.started", { callId, messages, options });
      try {
        const response = await meshGateway.chat(messages, options);
        assertActive();
        await recordLlmEvent("llm.call.completed", { callId, messages, options, response });
        return response;
      } catch (error) {
        await recordLlmEvent("llm.call.failed", {
          callId,
          messages,
          options,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    async *chatStream(
      messages: ChatMessage[],
      options: ChatOptions,
    ): AsyncIterable<string> {
      assertActive();
      for await (const chunk of meshGateway.chatStream(messages, options)) {
        assertActive();
        yield chunk;
      }
    },
    async generateImage(prompt: string, options?: { model?: string }): Promise<string> {
      assertActive();
      const response = await meshGateway.generateImage(prompt, options);
      assertActive();
      return response;
    },
  };
  const files: IFiles = {
    async readFile(targetPath: string): Promise<string> {
      assertActive();
      return filesProvider.readFile(targetPath);
    },
    async readLines(targetPath: string, startLine?: number, endLine?: number): Promise<{ content: string; startLine: number; endLine: number; totalLines: number }> {
      assertActive();
      return filesProvider.readLines(targetPath, startLine, endLine);
    },
    async writeFile(targetPath: string, content: string | Buffer): Promise<void> {
      assertActive();
      return filesProvider.writeFile(targetPath, content);
    },
    async downloadFile(url: string, targetPath: string, options?: { timeoutMs?: number; maxBytes?: number }) {
      assertActive();
      const result = await filesProvider.downloadFile(url, targetPath, options);
      assertActive();
      return result;
    },
    async writeLines(targetPath: string, startLine: number, endLine: number, content: string): Promise<void> {
      assertActive();
      return filesProvider.writeLines(targetPath, startLine, endLine, content);
    },
    async delete(targetPath: string, recursive?: boolean): Promise<void> {
      assertActive();
      return filesProvider.delete(targetPath, recursive);
    },
    async deleteLines(targetPath: string, startLine: number, endLine: number): Promise<void> {
      assertActive();
      return filesProvider.deleteLines(targetPath, startLine, endLine);
    },
    async createDirectory(targetPath: string): Promise<void> {
      assertActive();
      return filesProvider.createDirectory(targetPath);
    },
    async move(source: string, destination: string): Promise<void> {
      assertActive();
      return filesProvider.move(source, destination);
    },
    async copy(source: string, destination: string): Promise<void> {
      assertActive();
      return filesProvider.copy(source, destination);
    },
    async stat(targetPath: string): Promise<{ size: number; isFile: boolean; isDirectory: boolean; createdAt: string; modifiedAt: string }> {
      assertActive();
      return filesProvider.stat(targetPath);
    },
    async screenshot(targetPath: string, outputPath: string, startLine?: number, endLine?: number): Promise<unknown> {
      assertActive();
      return filesProvider.screenshot(targetPath, outputPath, startLine, endLine);
    },
    async listFiles(dirPath: string): Promise<string[]> {
      assertActive();
      return filesProvider.listFiles(dirPath);
    },
    async searchFiles(pattern: string, dirPath: string): Promise<string[]> {
      assertActive();
      return filesProvider.searchFiles(pattern, dirPath);
    },
  };

  // A per-task DI scope. Previously providers were registered into a global
  // singleton container, so a second concurrent task would overwrite the first
  // task's store/bus/files and corrupt it. Each runtime now owns its own scope.
  const scope = new Container();
  scope.register("IStore", store);
  scope.register("IBus", bus);
  scope.register("IEventQueue", durableQueue);
  scope.register("PermissionEngine", permissions);
  scope.register("IMeshGateway", gateway);
  // The agent's file-permission scope must be anchored to the SAME directory the
  // file provider writes to (config.workingDir), not process.cwd() — the Electron
  // process cwd is a different directory from the per-task workspace, and that
  // mismatch previously denied legitimate task-relative writes.
  scope.register("workingDir", config.workingDir);

  // Role defaults, used both by the chat-model factory below and as the model
  // resolver's fallback when the planner's choice is unavailable.
  const WORKER_MODEL_DEFAULTS: Record<ModelRole, string> = {
    planner: roleDefaults.planner,
    worker: roleDefaults.worker,
    verifier: roleDefaults.verifier,
    utility: roleDefaults.utility,
  };

  // YAAA reads Mesh's live catalog once per runtime, then resolves every agent's
  // model against it. Availability and pricing stay Mesh's knowledge; YAAA only
  // decides whether the model the planner asked for is actually on offer and,
  // when it is not, what to fall back to.
  let catalogLookup: Promise<MeshModelCatalogEntry[]> | undefined;
  const loadCatalog = (): Promise<MeshModelCatalogEntry[]> => {
    if (!catalogLookup) {
      catalogLookup = (async () => {
        try {
          const catalog = await meshGateway.listModels();
          console.log("[YAAA] Mesh model catalog loaded", {
            catalogModels: catalog.length,
            eligibleModels: catalog.filter(isEligible).length,
          });
          return catalog;
        } catch (error) {
          console.warn("[YAAA] Mesh model catalog unavailable; using planner/model-role routing", {
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      })();
    }
    return catalogLookup;
  };
  const modelResolver: ModelResolver = async (requested) => {
    // Fall back to the configured role defaults before the catalog's cheapest
    // entry: the cheapest of hundreds of tool-capable models is a free or tiny
    // one, which is not a sane model to run an unattended agent on.
    const resolution = resolveModelFromCatalog(await loadCatalog(), requested, [
      ...new Set(Object.values({ ...WORKER_MODEL_DEFAULTS, ...(config.modelMapping ?? {}) })),
    ]);
    console.log("[YAAA] Mesh model resolution", {
      requestedModel: requested ?? null,
      selectedModel: resolution.model ?? null,
    });
    return resolution;
  };
  scope.register("modelResolver", modelResolver);
  // The planner picks a model per subtask from Mesh's live catalog rather than a
  // hardcoded rubric, so newly released models become selectable on their own.
  // It receives the menu already rendered: the orchestrator package cannot
  // import this one without a dependency cycle.
  scope.register("modelCatalogProvider", loadCatalog);
  scope.register("modelMenuProvider", async (): Promise<string> => {
    const menu = buildPlannerModelMenu(await loadCatalog());
    console.log("[YAAA] Planner model menu", { options: menu.length });
    return menu.length ? renderPlannerModelMenu(menu) : "";
  });

  const hasApiKey = Boolean(config.apiKey || process.env.MESH_API_KEY);
  const timeout = config.timeout ?? (process.env.YAAA_TIMEOUT ? Number(process.env.YAAA_TIMEOUT) : (process.env.MESH_TIMEOUT ? Number(process.env.MESH_TIMEOUT) : 60000));
  const maxRetries = config.maxRetries ?? (process.env.YAAA_MAX_RETRIES ? Number(process.env.YAAA_MAX_RETRIES) : (process.env.MESH_MAX_RETRIES ? Number(process.env.MESH_MAX_RETRIES) : 3));
  const chatModelFactory = (roleOrModel: string): BaseChatModel => {
    const isKnownRole = roleOrModel in WORKER_MODEL_DEFAULTS;
    const model = isKnownRole
      ? WORKER_MODEL_DEFAULTS[roleOrModel as ModelRole]
      : roleOrModel;
    // `temperature` is intentionally omitted: it is an optional sampling
    // parameter, and Bedrock-backed models (which Mesh routes several providers
    // to) now reject it outright with `ValidationException: temperature is
    // deprecated for this model`. Leaving it undefined drops it from the request
    // body entirely, so it works across every model. An operator who knows their
    // models accept it can still force one via YAAA_TEMPERATURE.
    const rawTemperature = process.env.YAAA_TEMPERATURE;
    const temperature =
      rawTemperature && Number.isFinite(Number(rawTemperature))
        ? Number(rawTemperature)
        : undefined;
    if (!hasApiKey) {
      return new MockWorkerChatModel(roleOrModel);
    }

    const rawChatModel = new ChatOpenAI({
      apiKey: config.apiKey || process.env.MESH_API_KEY,
      model,
      temperature,
      configuration: { baseURL: process.env.MESH_BASE_URL || "https://api.meshapi.ai/v1" },
      timeout,
      maxRetries,
    });

    return rawChatModel;
  };
  scope.register("ChatModelFactory", chatModelFactory);

  scope.register("capability:files", files);
  scope.register("ExecutionSessionManager", executionSessions);
  scope.register("capability:shell", shellProvider);
  scope.register("capability:web", new WebSearchTool());
  scope.register("capability:browser", browserProvider);

  if (config.onApproval) {
    permissions.registerApprovalHandler(config.onApproval);
  }

  const emit = config.onEvent ?? (() => {});
  const { taskId } = config;
  let activePlan: TaskPlan | null = null;

  // Bridge internal bus topics to the typed, frontend-facing event stream.
  const patterns = [
    `task.${taskId}.plan_updated`,
    `task.${taskId}.agent_message`,
    `task.${taskId}.started`,
    `task.${taskId}.agent.*.lifecycle`,
    `task.${taskId}.agent.*.thought`,
    `task.${taskId}.agent.*.llm_context`,
    `task.${taskId}.agent.*.llm_response`,
    `task.${taskId}.agent.*.tool_requested`,
    `task.${taskId}.agent.*.action_requested`,
    `task.${taskId}.agent.*.action_started`,
    `task.${taskId}.agent.*.action_approved`,
    `task.${taskId}.agent.*.action_denied`,
    `task.${taskId}.agent.*.action_completed`,
    `task.${taskId}.agent.*.action_failed`,
    `task.${taskId}.agent.*.execution-attached`,
    `task.${taskId}.agent.*.execution-output`,
    `task.${taskId}.agent.*.execution-screenshot`,
    `task.${taskId}.agent.*.execution-detached`,
    `task.${taskId}.agent.*.execution-exited`,
  ];
  for (const pattern of patterns) {
    bus.subscribe(pattern, (topic, msg) => {
      const event = mapBusEvent(taskId, topic, msg);
      if (event?.type === "agent-status") {
        const subtask = activePlan?.subtasks.find(
          (candidate) => candidate.id === event.agent.subtaskId,
        );
        writeAgentLifecycleDocument(config, event.agent, subtask);
      }
      if (event) emit(event);
    });
  }

  return {
    store,
    reader: new SqliteTaskReader(store),
    bus,
    async plan(goal: string, context?: PlanContext): Promise<TaskPlan> {
      assertActive();
      emit({ type: "task-started", taskId });
      emit({
        type: "thought",
        from: "orchestrator",
        content: context?.priorSummary
          ? "Reviewing your follow-up and the previous mission evidence before revising the strategy."
          : "Preparing the implementation strategy and checking the task dependencies.",
      });
      const progressHeartbeat = setInterval(() => {
        emit({
          type: "thought",
          from: "orchestrator",
          content: context?.priorSummary
            ? "The planner is still incorporating your follow-up into the revised strategy."
            : "The planner is still evaluating the best execution path and model assignments.",
        });
      }, 12_000);
      const supervisor = new Supervisor(scope);
      try {
        const plan = await supervisor.createPlan(goal, taskId, context);
        emit({
          type: "thought",
          from: "orchestrator",
          content: `${plan.planningEstimate?.message || "The planner is finalizing the execution strategy."} Expected planning time: ${Math.ceil((plan.planningEstimate?.expectedDurationMs ?? 30_000) / 1000)}s. Considering: ${(plan.planningEstimate?.considerations ?? []).join(", ")}.`,
        });
        emit({
          type: "thought",
          from: "orchestrator",
          content: "Strategy draft received. Validating subtasks, dependencies, and model assignments.",
        });
        await recommendPlanModels(plan, preference, await loadCatalog());
        assertActive();
        emit({
          type: "thought",
          from: "orchestrator",
          content: "Strategy is ready. YAAA is preparing the plan review for you.",
        });
        return plan;
      } finally {
        clearInterval(progressHeartbeat);
      }
    },
    async runPlan(plan: TaskPlan): Promise<TaskRunResult> {
      assertActive();
      activePlan = plan;
      const supervisor = new Supervisor(scope);
      const result = await supervisor.runPlan(plan, taskId);
      assertActive();
      emit({ type: "complete", result });
      return result;
    },
    async run(goal: string): Promise<TaskRunResult> {
      const plan = await this.plan(goal);
      return this.runPlan(plan);
    },
    dispose(): void {
      orchestratorMailbox.detachQueue(taskId);
      void executionSessions.cleanupTask(taskId, (session) => {
        if (session.kind === "shell") shellProvider.close(session.backendId);
        else return browserProvider.close(session.backendId);
      }).finally(() => store.closeAll());
      // Release the per-task scope so its providers don't linger after the run.
      scope.clear();
    },
  };
}
import fs from "node:fs";
import path from "node:path";
