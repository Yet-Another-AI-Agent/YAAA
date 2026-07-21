import type { IEventQueue } from "./durable-queue.js";
import type { QueueClaim } from "@yaaa/shared";

/** Durable-in-process mailbox between Workspace/UI producers and the running
 * orchestrator event loop. Messages are intentionally FIFO and are never
 * silently dropped when a run is busy. */
export interface OrchestratorMessage {
  id: string;
  taskId: string;
  from: "user" | "orchestrator" | "agent";
  /** Agent identity for agent-originated messages, retained across durable queue recovery. */
  agentId?: string;
  content: string;
  createdAt: string;
}

class OrchestratorMailbox {
  private readonly queues = new Map<string, OrchestratorMessage[]>();
  private readonly durableQueues = new Map<string, IEventQueue>();
  private readonly claims = new Map<string, QueueClaim>();
  private readonly localPending = new Map<string, Set<string>>();
  private readonly pendingWrites = new Map<string, Map<string, Promise<void>>>();

  attachQueue(taskId: string, queue: IEventQueue): void {
    this.durableQueues.set(taskId, queue);
  }

  detachQueue(taskId: string): void {
    this.durableQueues.delete(taskId);
    this.localPending.delete(taskId);
    this.pendingWrites.delete(taskId);
  }

  post(message: OrchestratorMessage): void {
    const queue = this.queues.get(message.taskId) ?? [];
    queue.push(message);
    this.queues.set(message.taskId, queue);
    const pending = this.localPending.get(message.taskId) ?? new Set<string>();
    pending.add(message.id);
    this.localPending.set(message.taskId, pending);
    const durable = this.durableQueues.get(message.taskId);
    if (durable) {
      const write = durable.enqueue({
        id: message.id,
        taskId: message.taskId,
        queue: "orchestrator",
        payload: message,
        createdAt: message.createdAt,
        availableAt: message.createdAt,
        attempts: 0,
      }).catch((error) => console.warn("[OrchestratorMailbox] durable enqueue failed", error));
      const writes = this.pendingWrites.get(message.taskId) ?? new Map<string, Promise<void>>();
      writes.set(message.id, write);
      this.pendingWrites.set(message.taskId, writes);
    }
  }

  /** Recover pending messages after process restart and claim them with a lease. */
  async hydrate(taskId: string, consumerId: string): Promise<void> {
    const durable = this.durableQueues.get(taskId);
    if (!durable) return;
    // Ensure a just-posted local message is visible to the claim query before
    // draining the local fast path; otherwise the same message could be
    // processed once locally and once after its durable insert completes.
    await Promise.all(this.pendingWrites.get(taskId)?.values() ?? []);
    const claims = await durable.claim("orchestrator", taskId, consumerId);
    const queue = this.queues.get(taskId) ?? [];
    const pending = this.localPending.get(taskId) ?? new Set<string>();
    for (const claim of claims) {
      this.claims.set(claim.item.id, claim);
      if (pending.has(claim.item.id)) {
        await this.acknowledge(claim.item.id);
        continue;
      }
      const message = claim.item.payload as OrchestratorMessage;
      if (!message || message.taskId !== taskId || typeof message.content !== "string") {
        await this.acknowledge(claim.item.id);
        continue;
      }
      queue.push(message);
      pending.add(message.id);
    }
    this.queues.set(taskId, queue);
    this.localPending.set(taskId, pending);
  }

  drain(taskId: string): OrchestratorMessage[] {
    const queue = this.queues.get(taskId) ?? [];
    this.queues.delete(taskId);
    this.localPending.delete(taskId);
    return queue;
  }

  /** Put messages back at the front when the orchestrator has not spawned a
   * worker yet. This prevents an early event-loop tick from losing input. */
  requeue(taskId: string, messages: OrchestratorMessage[]): void {
    if (messages.length === 0) return;
    const existing = this.queues.get(taskId) ?? [];
    this.queues.set(taskId, [...messages, ...existing]);
    const pending = this.localPending.get(taskId) ?? new Set<string>();
    for (const message of messages) {
      pending.add(message.id);
      const claim = this.claims.get(message.id);
      if (claim) void this.retry(claim);
    }
    this.localPending.set(taskId, pending);
  }

  async acknowledge(messageId: string): Promise<void> {
    const claim = this.claims.get(messageId);
    if (!claim) return;
    const queue = this.durableQueues.get(claim.item.taskId);
    if (queue) await queue.acknowledge(claim);
    this.claims.delete(messageId);
    for (const writes of this.pendingWrites.values()) writes.delete(messageId);
  }

  private async retry(claim: QueueClaim): Promise<void> {
    const queue = this.durableQueues.get(claim.item.taskId);
    if (queue) await queue.retry(claim);
    this.claims.delete(claim.item.id);
  }

  clear(taskId: string): void {
    this.queues.delete(taskId);
    this.localPending.delete(taskId);
  }
}

export const orchestratorMailbox = new OrchestratorMailbox();
