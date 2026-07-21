import type { AgentContextSnapshot, IStore, ITaskReader, TaskContextSnapshot } from "@yaaa/interfaces";
import type { RuntimeAction, RuntimeEvent } from "@yaaa/shared";

function actionFromEvent(event: RuntimeEvent): RuntimeAction | null {
  if (!/\.action_(requested|started|approved|denied|completed|failed)$/.test(event.topic)) return null;
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.actionId !== "string" || typeof payload.agentId !== "string" || typeof payload.capability !== "string" || typeof payload.method !== "string") return null;
  const status = event.topic.endsWith(".action_started") ? "started"
    : event.topic.endsWith(".action_approved") ? "approved"
      : event.topic.endsWith(".action_denied") ? "denied"
        : event.topic.endsWith(".action_completed") ? "completed"
          : event.topic.endsWith(".action_failed") ? "failed" : "requested";
  return {
    id: payload.actionId,
    taskId: event.taskId,
    agentId: payload.agentId,
    capability: payload.capability,
    method: payload.method,
    args: (payload.args as Record<string, unknown>) ?? {},
    status,
    timestamp: event.timestamp,
    ...("result" in payload ? { result: payload.result } : {}),
    ...(typeof payload.error === "string" ? { error: payload.error } : {}),
  };
}

export class SqliteTaskReader implements ITaskReader {
  constructor(private readonly store: IStore) {}

  async getTaskContext(taskId: string, options: { eventLimit?: number } = {}): Promise<TaskContextSnapshot> {
    const [plan, agents, ledger, messages, events] = await Promise.all([
      this.store.getPlan(taskId), this.store.getAgents(taskId), this.store.getLedgerEntries(taskId),
      this.store.getMessages(taskId), this.store.getRuntimeEvents?.(taskId, { limit: options.eventLimit ?? 500 }) ?? Promise.resolve([]),
    ]);
    return { taskId, plan, agents, ledger, messages, events };
  }

  async getAgentContext(taskId: string, agentId: string, options: { eventLimit?: number } = {}): Promise<AgentContextSnapshot> {
    const context = await this.getTaskContext(taskId, options);
    const agentEvents = context.events.filter((event) => event.agentId === agentId || event.topic.includes(`.agent.${agentId}.`));
    const actions = agentEvents.map(actionFromEvent).filter((action): action is RuntimeAction => Boolean(action));
    return { ...context, agentId, events: agentEvents, actions };
  }
}
