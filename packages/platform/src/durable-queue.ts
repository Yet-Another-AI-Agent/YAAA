import type { IQueueStore } from "@yaaa/interfaces";
import type { QueueClaim, QueueItem, QueueName } from "@yaaa/shared";

export interface IEventQueue {
  enqueue(item: QueueItem): Promise<void>;
  claim(queue: QueueName, taskId: string | undefined, consumerId: string, limit?: number, leaseMs?: number): Promise<QueueClaim[]>;
  acknowledge(claim: QueueClaim): Promise<void>;
  retry(claim: QueueClaim, availableAt?: string): Promise<void>;
  recoverExpired(queue?: QueueName): Promise<number>;
  waitForWork(taskId: string, timeoutMs?: number): Promise<void>;
}

/** Queue adapter adding wake signals around the store's lease protocol. */
export class DurableEventQueue implements IEventQueue {
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(private readonly store: IQueueStore) {}

  async enqueue(item: QueueItem): Promise<void> {
    await this.store.enqueueQueueItem(item);
    const waiters = this.waiters.get(item.taskId) ?? [];
    this.waiters.delete(item.taskId);
    for (const wake of waiters) wake();
  }

  claim(queue: QueueName, taskId: string | undefined, consumerId: string, limit = 20, leaseMs = 30_000): Promise<QueueClaim[]> {
    return this.store.claimQueueItems({ queue, taskId, consumerId, limit, leaseMs });
  }

  acknowledge(claim: QueueClaim): Promise<void> {
    return this.store.acknowledgeQueueItem({ id: claim.item.id, leaseId: claim.leaseId });
  }

  retry(claim: QueueClaim, availableAt?: string): Promise<void> {
    return this.store.retryQueueItem({ id: claim.item.id, leaseId: claim.leaseId, availableAt });
  }

  recoverExpired(queue?: QueueName): Promise<number> {
    return this.store.releaseExpiredQueueLeases(queue);
  }

  async waitForWork(taskId: string, timeoutMs = 30_000): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, timeoutMs));
      const wake = () => { clearTimeout(timer); resolve(); };
      const waiters = this.waiters.get(taskId) ?? [];
      waiters.push(wake);
      this.waiters.set(taskId, waiters);
    });
  }
}
