import type { QueueClaim, QueueItem, QueueItemStatus, QueueName } from "@yaaa/shared";

/** Persistence contract for restart-safe queue delivery. */
export interface IQueueStore {
  enqueueQueueItem(item: QueueItem): Promise<void>;
  claimQueueItems(input: {
    queue: QueueName;
    taskId?: string;
    consumerId: string;
    limit?: number;
    leaseMs?: number;
  }): Promise<QueueClaim[]>;
  acknowledgeQueueItem(input: { id: string; leaseId: string }): Promise<void>;
  retryQueueItem(input: { id: string; leaseId: string; availableAt?: string }): Promise<void>;
  releaseExpiredQueueLeases(queue?: QueueName): Promise<number>;
  getQueueItems(taskId: string, options?: { queue?: QueueName; status?: QueueItemStatus }): Promise<QueueItem[]>;
}
