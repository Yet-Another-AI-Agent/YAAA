/** Durable-in-process mailbox between Workspace/UI producers and the running
 * orchestrator event loop. Messages are intentionally FIFO and are never
 * silently dropped when a run is busy. */
export interface OrchestratorMessage {
  id: string;
  taskId: string;
  from: "user" | "orchestrator" | "agent";
  content: string;
  createdAt: string;
}

class OrchestratorMailbox {
  private readonly queues = new Map<string, OrchestratorMessage[]>();

  post(message: OrchestratorMessage): void {
    const queue = this.queues.get(message.taskId) ?? [];
    queue.push(message);
    this.queues.set(message.taskId, queue);
  }

  drain(taskId: string): OrchestratorMessage[] {
    const queue = this.queues.get(taskId) ?? [];
    this.queues.delete(taskId);
    return queue;
  }

  /** Put messages back at the front when the orchestrator has not spawned a
   * worker yet. This prevents an early event-loop tick from losing input. */
  requeue(taskId: string, messages: OrchestratorMessage[]): void {
    if (messages.length === 0) return;
    const existing = this.queues.get(taskId) ?? [];
    this.queues.set(taskId, [...messages, ...existing]);
  }

  clear(taskId: string): void {
    this.queues.delete(taskId);
  }
}

export const orchestratorMailbox = new OrchestratorMailbox();
