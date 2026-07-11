import type {
  ChatMessage,
  ChatOptions,
  IBus,
  IFiles,
  IMeshGateway,
  IStore,
  ModelRole,
  ChatResult,
} from "@yaaa/interfaces";
import { Container, MessageBus, PermissionEngine } from "@yaaa/platform";
import { SqliteStore, FilesFs, MeshGateway } from "@yaaa/providers";
import { Supervisor, type PlanContext } from "@yaaa/orchestrator";
import type { AgentRun, Subtask, TaskPlan } from "@yaaa/shared";
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
  /** Typed event sink — the only channel a frontend should render from. */
  onEvent?: (event: RuntimeEvent) => void;
  /** Human-in-the-loop approval hook for gated tool calls. */
  onApproval?: (agentId: string, call: any) => Promise<boolean>;
  /** Cooperative cancellation checked between model and file operations. */
  isCancelled?: () => boolean;
}

/**
 * A composed, ready-to-run engine instance. Owns the DI wiring and the
 * bus→typed-event bridge, and exposes a minimal lifecycle. Frontends should
 * treat `store`/`bus` as read-only handles for post-run queries and never
 * reach past this object into the container.
 */
export interface Runtime {
  readonly store: IStore;
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

function writeAgentLifecycleDocument(
  config: RuntimeConfig,
  agent: AgentRun,
  subtask?: Subtask,
): void {
  const agentDir = path.join(
    config.tasksBaseDir,
    safePathSegment(agent.taskId),
    "agent-workspaces",
    safePathSegment(agent.id),
  );
  fs.mkdirSync(agentDir, { recursive: true });

  if (agent.status === "working") {
    const handsOn = `# HANDS_ON

- Task: ${agent.taskId}
- Agent: ${agent.handle} (${agent.displayName})
- Role: ${agent.role}
- Subtask: ${agent.subtaskId}
- Started: ${agent.startedAt ?? "Not recorded"}

## Boundaries

- Assigned objective: ${subtask?.title ?? "Complete the assigned subtask."}
- Success criteria: ${subtask?.successCriteria ?? "Meet the reviewed plan's success criteria."}
- Capability: ${subtask?.capability ?? agent.role}
- Work only inside the task workspace and request approval for gated actions.
- Report changed files, tests, residual risks, and follow-up work in HANDS_OFF.md.
`;
    fs.writeFileSync(path.join(agentDir, "HANDS_ON.md"), handsOn, "utf-8");
    return;
  }

  if (["completed", "failed", "exited"].includes(agent.status)) {
    const handsOff = `# HANDS_OFF

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
    fs.writeFileSync(path.join(agentDir, "HANDS_OFF.md"), handsOff, "utf-8");
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
  const permissions = new PermissionEngine();
  const meshGateway = new MeshGateway({
    apiKey: config.apiKey,
    modelMapping: config.modelMapping as Record<ModelRole, string> | undefined,
  });
  const filesProvider = new FilesFs(config.workingDir);
  const gateway: IMeshGateway = {
    async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
      assertActive();
      const response = await meshGateway.chat(messages, options);
      assertActive();
      return response;
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
  };
  const files: IFiles = {
    async readFile(targetPath: string): Promise<string> {
      assertActive();
      return filesProvider.readFile(targetPath);
    },
    async writeFile(targetPath: string, content: string): Promise<void> {
      assertActive();
      return filesProvider.writeFile(targetPath, content);
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
  scope.register("PermissionEngine", permissions);
  scope.register("IMeshGateway", gateway);
  scope.register("capability:files", files);

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
    `task.${taskId}.agent.*.tool_requested`,
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
    bus,
    async plan(goal: string, context?: PlanContext): Promise<TaskPlan> {
      assertActive();
      emit({ type: "task-started", taskId });
      const supervisor = new Supervisor(scope);
      const plan = await supervisor.createPlan(goal, taskId, context);
      assertActive();
      return plan;
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
      store.closeAll();
      // Release the per-task scope so its providers don't linger after the run.
      scope.clear();
    },
  };
}
import fs from "node:fs";
import path from "node:path";
