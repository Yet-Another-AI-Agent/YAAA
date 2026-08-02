export type ModelRole = "planner" | "worker" | "verifier" | "utility";

/** Capabilities that can be granted to a worker or used by verification. */
export enum Capability {
  Docs = "docs",
  Browser = "browser",
  Shell = "shell",
  Files = "files",
  Integration = "integration",
  Verify = "verify",
}

/** String-literal form keeps JSON plans and test fixtures ergonomic. */
export type CapabilityValue = `${Capability}`;

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
  /** The initial goal shown as soon as the agent is spawned. */
  initialGoal?: string;
  /** The orchestrator's latest concrete assignment after preflight. */
  activeAssignment?: string;
  /** Concrete model used by this run, when resolved. */
  model?: string;
  /** Human-readable cost/capability rationale for the model choice. */
  modelReason?: string;
  status: AgentRunStatus;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  pokemonName?: string;
  pokemonImage?: string;
}

export interface AgentWorkspaceSnapshot {
  agentId: string;
  files: {
    handsOn: string | null;
    handOff: string | null;
    checkpoint?: string | null;
    proofOfWork?: string | null;
    incompleteWork: string | null;
  };
}

export type MissionNextAction =
  | "review_plan"
  | "resume_checkpoint"
  | "continue_work"
  | "review_results"
  | "none";

export interface MissionSnapshot {
  task: {
    id: string;
    prompt: string;
    status: string;
    createdAt: string;
    topic: string | null;
  };
  plan: TaskPlan | null;
  agents: AgentRun[];
  latestLedger: LedgerEntry | null;
  checkpoints: Array<{
    from: string;
    summary: string;
    artifacts: ArtifactRef[];
  }>;
  nextAction: MissionNextAction;
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
  /** LLM-generated execution policy for bounded, evidence-driven runtime work. */
  executionContract?: ExecutionContract;
  /** LLM-provided estimate and user-facing explanation for plan generation. */
  planningEstimate?: PlanningEstimate;
  /** Structured planning decisions shown in YAAA's implementation ledger. */
  planningAnalysis?: PlanningAnalysis;
  /** Detailed explanation of how YAAA will execute the work. */
  methodology?: string;
  /** Dependency-derived stages; subtasks in one parallel stage may run together. */
  executionGraph?: PlanExecutionStage[];
  /** Durable reassessment/correction history written after agent results. */
  corrections?: PlanCorrection[];
  /** Explicit verification strategy and known limits of the selected tools. */
  verification?: VerificationPlan;
  /** Findings reported by independent verification agents back to YAAA. */
  verificationFindings?: VerificationFinding[];
}

export interface ExecutionContract {
  contextPolicy?: ContextPolicy;
  requiredArtifacts: string[];
  targetWorkspace: string;
  expectedNextActions: string[];
  dependencyGraph: Array<{ subtaskId: string; dependsOn: string[] }>;
  preflight: { runOncePerAssignment: boolean; targetPaths: string[] };
  completionSignals: string[];
  noProgress: { correctionAfter: number; stopAfter: number };
  actionQueue: { useWhen: string[]; maxActions: number; maxDepth: number; stopOnError: boolean };
  verificationSurface: "files" | "electron" | "browser" | "shell" | "none";
}

export interface ContextPolicy {
  maxInputTokens: number;
  maxDependencyChars: number;
  maxHistoryTurns: number;
  maxFileExcerptLines: number;
  includeFullSkillDocs: boolean;
  allowOnDemandReads: boolean;
  allowedTools: string[];
}

export interface PlanningEstimate {
  message: string;
  considerations: string[];
  expectedDurationMs: number;
}

export interface PlanningAnalysis {
  implementationGoal: string;
  decompositionRationale: string;
  modelPolicy: string;
  stepReviews: PlanningStepReview[];
}

export interface PlanningStepReview {
  subtaskId: string;
  independentExecution: boolean;
  dependencyReason: string;
  selectedRole: string;
  roleExpectation: string;
  selectedModel: string;
  modelReason: string;
}

export interface PlanningRoleAssessment {
  agentTemplate: string;
  relevant: boolean;
  rationale: string;
}

/** User-controlled quality/cost policy applied to YAAA and every sub-agent. */
export type ModelPreference = "sota" | "balanced" | "cost-effective";

export interface PlanExecutionStage {
  stage: number;
  mode: "sequential" | "parallel";
  subtaskIds: string[];
  rationale?: string;
}

export interface PlanCorrection {
  id: string;
  timestamp: string;
  subtaskId: string;
  agentId?: string;
  action: string;
  reason: string;
  nextAgentTemplate?: string;
  nextModel?: string;
}

export interface VerificationPlan {
  required: boolean;
  strategy: string;
  stages: VerificationStage[];
  toolLimitations: string[];
  decisionPolicy: string;
}

export type VerificationKind = "artifact" | "automated" | "visual" | "research";
export interface VerificationStage {
  id: string;
  kind: VerificationKind;
  targetSubtaskIds: string[];
  capability: Capability;
  method: string;
  available: boolean;
  limitation?: string;
  fallback?: string;
}

export interface VerificationFinding {
  id: string;
  timestamp: string;
  subtaskId: string;
  agentId?: string;
  status: "open" | "resolved" | "accepted";
  summary: string;
  findings: string[];
  evidence: string[];
  limitations: string[];
  resolution?: string;
}

export interface SubSubtask {
  id: string;
  title: string;
  state: "pending" | "running" | "completed" | "failed";
  result?: string;
  completedAt?: string;
}

export interface Subtask {
  id: string;
  title: string;
  /** Concise statement of the concrete work and expected deliverable. */
  summary?: string;
  roles: string[];
  capabilities: CapabilityValue[];
  dependsOn: string[];
  riskLevel: "low" | "medium" | "high";
  successCriteria: string;
  /** Short model-generated explanations for the composite role assignment. */
  routingReason?: string;
  /** Model dynamically assigned by the planner. */
  model?: string;
  /** Short explanation of why this model fits the subtask. */
  modelReason?: string;
  /** Skill ids selected by the planner and required by the worker. */
  skills?: string[];
  /** Artifacts generated by the subtask execution. */
  artifacts?: ArtifactRef[];
  /** Supervisor-selected primary deliverables for the completed-result UI. */
  relevantArtifactPaths?: string[];
  state: "pending" | "running" | "completed" | "failed";
  assignedTo?: string;
  result?: string;
  /** Internal micro-tasks/sub-subtasks managed by the executing sub-agent. */
  subSubtasks?: SubSubtask[];
}

export interface ToolCall {
  id: string;
  capability: string;
  method: string;
  args: Record<string, any>;
}

export type AgentMessage =
  | { kind: "status"; from: string; taskId: string; state: "working" | "blocked" | "done"; note?: string }
  | { kind: "result"; from: string; taskId: string; artifacts: ArtifactRef[]; summary: string; incomplete?: boolean }
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

/** Durable append-only record for every runtime event, not only UI messages. */
export interface RuntimeEvent {
  id: string;
  taskId: string;
  topic: string;
  timestamp: string;
  payload: unknown;
  /** Optional correlation fields used to reconstruct a run or agent turn. */
  agentId?: string;
  runId?: string;
  parentEventId?: string;
}

export type QueueName = "orchestrator" | "agent";
export type QueueItemStatus = "pending" | "leased" | "done";

/** Generic durable work item. Payloads stay typed at the queue boundary. */
export interface QueueItem {
  id: string;
  taskId: string;
  queue: QueueName;
  recipientId?: string;
  payload: unknown;
  createdAt: string;
  availableAt: string;
  attempts: number;
}

export interface QueueClaim {
  item: QueueItem;
  leaseId: string;
  leasedUntil: string;
}

export type RuntimeActionStatus = "requested" | "started" | "approved" | "denied" | "completed" | "failed";

export interface RuntimeAction {
  id: string;
  taskId: string;
  agentId: string;
  capability: string;
  method: string;
  args: Record<string, unknown>;
  status: RuntimeActionStatus;
  timestamp: string;
  result?: unknown;
  error?: string;
}

/** Multi-Loop Architecture Types */
export type OuterLoopLifecycleState =
  | "CHAT_SPACE_ACTIVE"
  | "BACKGROUND_ISOLATED"
  | "GOING_HOME_SUSPENDED"
  | "RECOVERING";

export interface OuterLoopStateTransition {
  from: OuterLoopLifecycleState;
  to: OuterLoopLifecycleState;
  reason: string;
  timestamp: string;
}

export type AICallPriority = "HIGH" | "MEDIUM" | "LOW";

export interface AICallQueueItem {
  id: string;
  taskId: string;
  consumerId: string; // e.g. orchestrator or agentId
  priority: AICallPriority;
  modelRole: ModelRole;
  requestedModel?: string;
  messages: unknown[];
  tools?: unknown[];
  options?: Record<string, unknown>;
  createdAt: string;
}

export interface AICallResult {
  id: string;
  modelUsed: string;
  provider: string;
  content: string;
  toolCalls?: ToolCall[];
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  durationMs: number;
}

export interface WALRecord {
  id: string;
  entityId: string; // taskId or agentId
  sequence: number;
  type: string; // e.g. "TURN_START", "TOOL_CALL", "TOOL_OBSERVATION", "STATE_CHANGE", "CHECKPOINT"
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface CompactionCheckpoint {
  id: string;
  agentId: string;
  taskId: string;
  sequence: number;
  summary: string;
  factsExtracted: string[];
  filesTouched: string[];
  timestamp: string;
}

export interface CanvasCommentAnnotation {
  id: string;
  imageUrl: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  comment: string;
  author: string;
  timestamp: string;
}
