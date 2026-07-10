export interface ArtifactRef {
  path: string;
  mimeType: string;
  description: string;
}

export type AgentRunStatus = "planned" | "working" | "blocked" | "completed" | "failed" | "exited";

/** A durable, user-addressable agent assignment within a mission. */
export interface AgentRun {
  id: string;
  handle: string;
  displayName: string;
  taskId: string;
  subtaskId: string;
  role: string;
  modelRole: string;
  status: AgentRunStatus;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
}

/** A durable discussion space inside a mission. */
export interface Conversation {
  id: string;
  taskId: string;
  /** `public` is visible to the whole mission; agent threads are scoped to an agent. */
  kind: "public" | "agent_thread";
  title: string;
  participantIds: string[];
  agentId?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export type ConversationAuthorKind = "user" | "orchestrator" | "agent" | "system";

export interface Mention {
  /** The exact, canonical handle that appeared in the message, for example `@sage-1`. */
  handle: string;
  recipientId: string;
  recipientKind: "orchestrator" | "agent";
}

/** A durable message shown in a public conversation or a private agent thread. */
export interface ConversationMessage {
  id: string;
  taskId: string;
  conversationId: string;
  authorId: string;
  authorKind: ConversationAuthorKind;
  content: string;
  mentions: Mention[];
  createdAt: string;
}

/** The routing result produced when a message contains one or more @mentions. */
export interface MentionRoute {
  conversationId: string;
  messageId: string;
  recipientId: string;
  recipientKind: "orchestrator" | "agent";
  handle: string;
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
