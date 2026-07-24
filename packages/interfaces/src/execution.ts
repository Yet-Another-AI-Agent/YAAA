export type ExecutionSessionKind = "shell" | "browser";
export type ExecutionSessionState = "attached" | "detached" | "running" | "exited" | "failed";

export interface ExecutionSession {
  id: string;
  taskId: string;
  agentId: string;
  kind: ExecutionSessionKind;
  backendId: string;
  state: ExecutionSessionState;
  startedAt: string;
  lastObservedAt?: string;
  deadlineAt?: string;
  cwd?: string;
  url?: string;
  pid?: number;
  reattachCount?: number;
  maxReattachCycles?: number;
}

export interface ExecutionObservation {
  sessionId: string;
  sequence: number;
  timestamp: string;
  kind: "stdout" | "stderr" | "browser-state" | "screenshot" | "exit";
  summary?: string;
  outputPath?: string;
  exitCode?: number;
  timedOut?: boolean;
}

export interface ExecutionSessionManagerLike {
  create(input: Omit<ExecutionSession, "startedAt" | "state"> & { state?: ExecutionSessionState }): Promise<ExecutionSession>;
  setState(id: string, state: ExecutionSessionState, patch?: Partial<ExecutionSession>): Promise<ExecutionSession>;
  detach(id: string): Promise<ExecutionSession>;
  reattach(id: string): Promise<ExecutionSession>;
  observe(id: string, observation: Omit<ExecutionObservation, "sessionId" | "sequence" | "timestamp">): Promise<ExecutionObservation>;
}
