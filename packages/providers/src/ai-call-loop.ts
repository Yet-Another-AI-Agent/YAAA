import crypto from "node:crypto";
import type { IMeshGateway, ChatOptions, ChatMessage, ChatResult, ModelRole } from "@yaaa/interfaces";
import type { AICallPriority, AICallQueueItem } from "@yaaa/shared";
import type { DBEngine } from "./db-engine.js";

export interface AICallLoopConfig {
  maxConcurrentCalls?: number;
  rateLimitPerMin?: number;
}

export class AICallLoop {
  private queue: AICallQueueItem[] = [];
  private activeCalls = 0;
  private maxConcurrent: number;

  constructor(
    private readonly meshGateway: IMeshGateway,
    private readonly dbEngine?: DBEngine,
    config: AICallLoopConfig = {},
  ) {
    this.maxConcurrent = config.maxConcurrentCalls ?? 5;
  }

  /**
   * Enqueues an AI call request into the priority queue and processes it.
   */
  async executeCall(
    taskId: string,
    consumerId: string,
    role: ModelRole,
    messages: ChatMessage[],
    options: Partial<ChatOptions> = {},
    priority: AICallPriority = "MEDIUM",
  ): Promise<ChatResult> {
    const item: AICallQueueItem = {
      id: `ai-call-${crypto.randomUUID()}`,
      taskId,
      consumerId,
      priority,
      modelRole: role,
      requestedModel: options.model,
      messages,
      tools: options.tools,
      options: options as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    };

    this.enqueue(item);
    return this.processQueueItem(item);
  }

  private enqueue(item: AICallQueueItem): void {
    const priorityScore = (p: AICallPriority) => (p === "HIGH" ? 3 : p === "MEDIUM" ? 2 : 1);
    const index = this.queue.findIndex((i) => priorityScore(i.priority) < priorityScore(item.priority));
    if (index === -1) {
      this.queue.push(item);
    } else {
      this.queue.splice(index, 0, item);
    }
  }

  private async processQueueItem(item: AICallQueueItem): Promise<ChatResult> {
    // Wait until concurrency slot is available AND this item is at the head of the priority queue
    while (this.activeCalls >= this.maxConcurrent || (this.queue.length > 0 && this.queue[0].id !== item.id)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Dequeue the item
    const queueIdx = this.queue.findIndex((i) => i.id === item.id);
    if (queueIdx !== -1) this.queue.splice(queueIdx, 1);

    this.activeCalls++;
    const startTime = Date.now();

    try {
      const chatOpts: ChatOptions = {
        modelRole: item.modelRole,
        model: item.requestedModel,
        ...(item.options as Partial<ChatOptions>),
      };

      const result = await this.meshGateway.chat(item.messages as ChatMessage[], chatOpts);
      const durationMs = Date.now() - startTime;

      if (this.dbEngine) {
        try {
          const db = this.dbEngine.getAICallLoopDb(item.taskId);
          const stmt = db.prepare(
            `INSERT INTO ai_call_logs (id, task_id, consumer_id, priority, model_used, prompt_tokens, completion_tokens, duration_ms, status, payload, timestamp)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          stmt.run(
            item.id,
            item.taskId,
            item.consumerId,
            item.priority,
            item.requestedModel ?? "mesh-default",
            0,
            0,
            durationMs,
            "completed",
            JSON.stringify({ role: item.modelRole, contentPreview: result.content.slice(0, 500) }),
            new Date().toISOString(),
          );
        } catch (err) {
          console.warn("[AICallLoop] Failed to log AI call result:", err);
        }
      }

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      if (this.dbEngine) {
        try {
          const db = this.dbEngine.getAICallLoopDb(item.taskId);
          const stmt = db.prepare(
            `INSERT INTO ai_call_logs (id, task_id, consumer_id, priority, model_used, prompt_tokens, completion_tokens, duration_ms, status, payload, timestamp)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          stmt.run(
            item.id,
            item.taskId,
            item.consumerId,
            item.priority,
            item.requestedModel ?? "unknown",
            0,
            0,
            durationMs,
            "failed",
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            new Date().toISOString(),
          );
        } catch (dbErr) {
          console.warn("[AICallLoop] Failed to log AI call failure:", dbErr);
        }
      }
      throw error;
    } finally {
      this.activeCalls--;
    }
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getActiveCallCount(): number {
    return this.activeCalls;
  }
}
