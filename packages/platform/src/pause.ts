/**
 * Cooperative pause/resume for agent execution loops. Mentioning an agent
 * (@handle) in chat pauses that specific agent's inner loop before its next
 * model turn; resuming releases every waiter. This is the in-process
 * equivalent of the blueprint's "pause that agent and force a sub-thread".
 */
export class PauseController {
  private readonly paused = new Map<
    string,
    { promise: Promise<void>; resolve: () => void }
  >();

  pause(agentId: string): void {
    if (this.paused.has(agentId)) return;
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    this.paused.set(agentId, { promise, resolve });
  }

  /** Returns true when the agent was actually paused. */
  resume(agentId: string): boolean {
    const entry = this.paused.get(agentId);
    if (!entry) return false;
    this.paused.delete(agentId);
    entry.resolve();
    return true;
  }

  isPaused(agentId: string): boolean {
    return this.paused.has(agentId);
  }

  pausedAgents(): string[] {
    return [...this.paused.keys()];
  }

  /** Resolves immediately unless the agent is paused; then blocks until resume. */
  async waitIfPaused(agentId: string): Promise<void> {
    const entry = this.paused.get(agentId);
    if (entry) await entry.promise;
  }
}

/**
 * Process-wide controller shared by the runtime (which checks it between
 * agent turns) and the workspace/IPC layer (which flips it on @mentions).
 */
export const pauseController = new PauseController();
