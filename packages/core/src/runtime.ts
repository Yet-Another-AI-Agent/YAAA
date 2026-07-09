import type { IBus, IStore, ModelRole } from "@yaaa/interfaces";
import { container, MessageBus, PermissionEngine } from "@yaaa/platform";
import { SqliteStore, FilesFs, MeshGateway } from "@yaaa/providers";
import { Supervisor } from "@yaaa/orchestrator";
import { type RuntimeEvent, type TaskRunResult, mapBusEvent } from "./events.js";

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
  run(goal: string): Promise<TaskRunResult>;
  dispose(): void;
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
  const store = new SqliteStore(config.tasksBaseDir);
  const bus = new MessageBus();
  const permissions = new PermissionEngine();
  const gateway = new MeshGateway({
    apiKey: config.apiKey,
    modelMapping: config.modelMapping as Record<ModelRole, string> | undefined,
  });
  const files = new FilesFs(config.workingDir);

  container.register("IStore", store);
  container.register("IBus", bus);
  container.register("PermissionEngine", permissions);
  container.register("IMeshGateway", gateway);
  container.register("capability:files", files);

  if (config.onApproval) {
    permissions.registerApprovalHandler(config.onApproval);
  }

  const emit = config.onEvent ?? (() => {});
  const { taskId } = config;

  // Bridge internal bus topics to the typed, frontend-facing event stream.
  const patterns = [
    `task.${taskId}.plan_updated`,
    `task.${taskId}.agent_message`,
    `task.${taskId}.started`,
    `task.${taskId}.agent.*.thought`,
    `task.${taskId}.agent.*.tool_requested`,
  ];
  for (const pattern of patterns) {
    bus.subscribe(pattern, (topic, msg) => {
      const event = mapBusEvent(taskId, topic, msg);
      if (event) emit(event);
    });
  }

  return {
    store,
    bus,
    async run(goal: string): Promise<TaskRunResult> {
      emit({ type: "task-started", taskId });
      const supervisor = new Supervisor();
      const result = await supervisor.runTask(goal, taskId);
      emit({ type: "complete", result });
      return result;
    },
    dispose(): void {
      store.closeAll();
    },
  };
}
