import type { AgentMessage, AgentRun, LedgerEntry, RuntimeAction, RuntimeEvent, TaskPlan } from "@yaaa/shared";

export interface TaskContextSnapshot {
  taskId: string;
  plan: TaskPlan | null;
  agents: AgentRun[];
  ledger: LedgerEntry[];
  messages: AgentMessage[];
  events: RuntimeEvent[];
}

export interface AgentContextSnapshot extends TaskContextSnapshot {
  agentId: string;
  actions: RuntimeAction[];
}

/** Read-side abstraction used by orchestration and diagnostics. */
export interface ITaskReader {
  getTaskContext(taskId: string, options?: { eventLimit?: number }): Promise<TaskContextSnapshot>;
  getAgentContext(taskId: string, agentId: string, options?: { eventLimit?: number }): Promise<AgentContextSnapshot>;
}
