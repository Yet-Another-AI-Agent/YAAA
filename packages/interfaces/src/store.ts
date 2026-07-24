import type {
  AgentMessage,
  AgentRun,
  Conversation,
  ConversationMessage,
  LedgerEntry,
  TaskPlan,
  RuntimeEvent,
} from "@yaaa/shared";
import type { ExecutionObservation, ExecutionSession } from "./execution.js";

export interface IStore {
  initTaskDb(taskId: string): Promise<void>;
  
  saveMessage(taskId: string, message: AgentMessage): Promise<void>;
  getMessages(taskId: string): Promise<AgentMessage[]>;
  
  savePlan(taskId: string, plan: TaskPlan): Promise<void>;
  getPlan(taskId: string): Promise<TaskPlan | null>;
  
  saveLedgerEntry(taskId: string, entry: LedgerEntry): Promise<void>;
  getLedgerEntries(taskId: string): Promise<LedgerEntry[]>;
  
  saveAuditLog(taskId: string, log: { action: string; details: string; approvedBy?: string }): Promise<void>;
  getAuditLogs(taskId: string): Promise<any[]>;

  saveAgent(taskId: string, agent: AgentRun): Promise<void>;
  getAgents(taskId: string): Promise<AgentRun[]>;

  /** Optional append-only journal. Implementations may add this incrementally. */
  saveRuntimeEvent?(event: RuntimeEvent): Promise<void>;
  getRuntimeEvents?(taskId: string, options?: { topic?: string; limit?: number }): Promise<RuntimeEvent[]>;

  saveExecutionSession?(session: ExecutionSession): Promise<void>;
  getExecutionSessions?(taskId: string): Promise<ExecutionSession[]>;
  saveExecutionObservation?(taskId: string, observation: ExecutionObservation): Promise<void>;
  getExecutionObservations?(taskId: string, sessionId: string, limit?: number): Promise<ExecutionObservation[]>;

}

/** Optional persistence capability used by the multi-agent conversation layer. */
export interface IConversationStore extends IStore {
  saveConversation(taskId: string, conversation: Conversation): Promise<void>;
  getConversation(taskId: string, conversationId: string): Promise<Conversation | null>;
  getConversations(taskId: string): Promise<Conversation[]>;

  saveConversationMessage(taskId: string, message: ConversationMessage): Promise<void>;
  getConversationMessages(taskId: string, conversationId: string): Promise<ConversationMessage[]>;
}
