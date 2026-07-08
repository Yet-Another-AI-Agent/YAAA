import type { AgentMessage, TaskPlan, LedgerEntry } from "@yaaa/shared";

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
}
