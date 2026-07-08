export interface ArtifactRef {
  path: string;
  mimeType: string;
  description: string;
}

export interface TaskPlan {
  goal: string;
  subtasks: Subtask[];
}

export interface Subtask {
  id: string;
  title: string;
  capability: "docs" | "browser" | "shell" | "files" | "integration" | "verify";
  dependsOn: string[];
  riskLevel: "low" | "medium" | "high";
  successCriteria: string;
  state: "pending" | "running" | "completed" | "failed";
  assignedTo?: string;
  result?: string;
}

export interface ToolCall {
  id: string;
  capability: string;
  method: string;
  args: Record<string, any>;
}

export type AgentMessage =
  | { kind: "status"; from: string; taskId: string; state: "working" | "blocked" | "done"; note?: string }
  | { kind: "result"; from: string; taskId: string; artifacts: ArtifactRef[]; summary: string }
  | { kind: "info_request"; from: string; to: string; question: string }
  | { kind: "info_reply"; from: string; to: string; answer: string }
  | { kind: "help_request"; from: string; to: "orchestrator"; problem: string }
  | { kind: "approval_request"; from: string; to: "orchestrator"; action: ToolCall }
  | { kind: "thought"; from: string; content: string };

export interface LedgerEntry {
  timestamp: string;
  step: number;
  facts: string[];
  assumptions: string[];
  subtaskStates: Record<string, "pending" | "running" | "completed" | "failed">;
  nextStepStrategy: string;
}
