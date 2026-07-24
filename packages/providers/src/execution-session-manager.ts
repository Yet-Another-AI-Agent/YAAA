import type {
  ExecutionObservation,
  ExecutionSession,
  ExecutionSessionKind,
  ExecutionSessionState,
  IStore,
} from "@yaaa/interfaces";

/** Durable bookkeeping for long-lived shell/browser processes.
 * Providers own the actual process or browser; this manager owns lifecycle,
 * bounded observations, deadlines, and cleanup decisions.
 */
export class ExecutionSessionManager {
  private sessions = new Map<string, ExecutionSession>();
  private sequences = new Map<string, number>();

  constructor(private readonly store?: IStore) {}

  async create(input: Omit<ExecutionSession, "startedAt" | "state"> & { state?: ExecutionSessionState }): Promise<ExecutionSession> {
    const session: ExecutionSession = {
      ...input,
      state: input.state ?? "attached",
      startedAt: new Date().toISOString(),
      reattachCount: 0,
      maxReattachCycles: 5,
    };
    this.sessions.set(session.id, session);
    await this.store?.saveExecutionSession?.(session);
    return session;
  }

  async hydrate(taskId: string): Promise<ExecutionSession[]> {
    const saved = await this.store?.getExecutionSessions?.(taskId) ?? [];
    for (const session of saved) this.sessions.set(session.id, session);
    return saved;
  }

  get(id: string): ExecutionSession | undefined { return this.sessions.get(id); }

  async setState(id: string, state: ExecutionSessionState, patch: Partial<ExecutionSession> = {}): Promise<ExecutionSession> {
    const current = this.require(id);
    const next = { ...current, ...patch, state };
    this.sessions.set(id, next);
    await this.store?.saveExecutionSession?.(next);
    return next;
  }

  async observe(id: string, observation: Omit<ExecutionObservation, "sessionId" | "sequence" | "timestamp">): Promise<ExecutionObservation> {
    const session = this.require(id);
    const nextSequence = (this.sequences.get(id) ?? 0) + 1;
    this.sequences.set(id, nextSequence);
    const next: ExecutionObservation = { ...observation, sessionId: id, sequence: nextSequence, timestamp: new Date().toISOString() };
    await this.store?.saveExecutionObservation?.(session.taskId, next);
    await this.setState(id, session.state, { lastObservedAt: next.timestamp });
    return next;
  }

  async detach(id: string): Promise<ExecutionSession> { return this.setState(id, "detached"); }
  async reattach(id: string): Promise<ExecutionSession> {
    const current = this.require(id);
    const count = (current.reattachCount ?? 0) + 1;
    if (count > (current.maxReattachCycles ?? 5)) {
      throw new Error(`Execution session ${id} reached its maximum of ${current.maxReattachCycles ?? 5} reattach cycles; checkpoint required.`);
    }
    return this.setState(id, "attached", { reattachCount: count });
  }

  async cleanupTask(taskId: string, close: (session: ExecutionSession) => Promise<void> | void): Promise<void> {
    const targets = [...this.sessions.values()].filter((session) => session.taskId === taskId);
    for (const session of targets) {
      try { await close(session); } finally {
        await this.setState(session.id, session.state === "exited" ? "exited" : "failed");
        this.sessions.delete(session.id);
      }
    }
  }

  private require(id: string): ExecutionSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown execution session: ${id}`);
    return session;
  }
}

export type { ExecutionObservation, ExecutionSession, ExecutionSessionKind };
