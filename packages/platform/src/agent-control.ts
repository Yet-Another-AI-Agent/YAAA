/**
 * Cooperative master↔worker control channel. The orchestrator (or the UI, via an
 * @mention) posts directives for a specific running agent; the agent's inner
 * loop drains them between model turns (redirect / stop) and its wall-clock
 * watchdog drains them each tick (extend). This is the in-process equivalent of
 * a supervisor reaching into a running worker to correct it, grant it more time,
 * or wind it down — without killing and cold-restarting a fresh agent.
 *
 * Mirrors the {@link PauseController} singleton pattern in `pause.ts`.
 */
export type AgentControlDirective =
  /** Grant the worker more wall-clock time before its timebox fires. */
  | { type: "extend"; additionalMs: number; reason?: string }
  /** Hand the worker a corrected/new assignment to steer it mid-run. */
  | { type: "redirect"; handsOn: string; reason?: string }
  /** Ask the worker to wind up now and hand off its current progress. */
  | { type: "stop"; reason?: string };

export class AgentControlMailbox {
  private readonly mailboxes = new Map<string, AgentControlDirective[]>();

  /** Queue a directive for an agent. Order is preserved (FIFO). */
  post(agentId: string, directive: AgentControlDirective): void {
    const queue = this.mailboxes.get(agentId);
    if (queue) queue.push(directive);
    else this.mailboxes.set(agentId, [directive]);
  }

  /** Non-destructively check whether an agent has any pending directives. */
  hasPending(agentId: string): boolean {
    return (this.mailboxes.get(agentId)?.length ?? 0) > 0;
  }

  /**
   * Remove and return every pending directive for an agent (FIFO). Returns an
   * empty array when the mailbox is empty, so callers can drain unconditionally.
   */
  drain(agentId: string): AgentControlDirective[] {
    const queue = this.mailboxes.get(agentId);
    if (!queue || queue.length === 0) return [];
    this.mailboxes.set(agentId, []);
    return queue;
  }

  /**
   * Remove only live watchdog controls. Redirects remain queued for the next
   * model turn, while extensions and stops can affect an invocation already in
   * progress.
   */
  takeLive(agentId: string): { additionalMs: number; stopReason?: string } {
    const queue = this.mailboxes.get(agentId);
    if (!queue || queue.length === 0) return { additionalMs: 0 };
    let additionalMs = 0;
    let stopReason: string | undefined;
    const deferred: AgentControlDirective[] = [];
    for (const directive of queue) {
      if (directive.type === "extend") additionalMs += Math.max(0, directive.additionalMs);
      else if (directive.type === "stop") stopReason = directive.reason;
      else deferred.push(directive);
    }
    this.mailboxes.set(agentId, deferred);
    return { additionalMs, stopReason };
  }

  /** Drop any pending directives for an agent (call when its run ends). */
  clear(agentId: string): void {
    this.mailboxes.delete(agentId);
  }
}

/**
 * Process-wide controller shared by the runtime (whose inner loop drains it
 * between turns) and the orchestrator/UI layer (which posts directives).
 */
export const agentControl = new AgentControlMailbox();
