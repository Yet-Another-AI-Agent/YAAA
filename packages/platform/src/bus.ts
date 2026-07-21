import { EventEmitter } from "node:events";
import type { IBus, BusCallback, IStore } from "@yaaa/interfaces";
import { matchTopic, AgentMessageSchema, type AgentMessage } from "@yaaa/shared";
import { container } from "./di.js";

interface Subscription {
  pattern: string;
  callback: BusCallback;
}

export class MessageBus implements IBus {
  private emitter = new EventEmitter();
  private subscriptions: Subscription[] = [];
  private readonly injectedStore?: IStore;

  /**
   * @param store Persistence target for AgentMessages. Injected by the runtime
   * so each task's bus writes to its own (scoped) store instead of resolving a
   * process-global one. Falls back to the global container when omitted (tests).
   */
  constructor(store?: IStore) {
    this.injectedStore = store;
    this.emitter.setMaxListeners(100);
  }

  async publish(topic: string, message: any): Promise<void> {
    // 1. Emit to local listeners matching the pattern
    for (const sub of this.subscriptions) {
      if (matchTopic(sub.pattern, topic)) {
        try {
          await sub.callback(topic, message);
        } catch (err) {
          console.error(`Error in subscriber for topic ${topic}:`, err);
        }
      }
    }

    // Keep an append-only journal for every task-scoped event. AgentMessage
    // persistence below remains for the existing read model and compatibility.
    const taskId = this.getTaskIdFromTopic(topic) ?? this.getTaskIdFromMessage(message);
    if (taskId) {
      try {
        const store = this.injectedStore ?? container.resolve<IStore>("IStore");
        await store.saveRuntimeEvent?.({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          taskId,
          topic,
          timestamp: new Date().toISOString(),
          payload: message,
          ...(typeof message === "object" && message !== null && typeof message.from === "string"
            ? { agentId: message.from }
            : {}),
        });
      } catch (err) {
        // Test/embedded runtimes may intentionally omit persistence. Keep the
        // bus best-effort just as the legacy AgentMessage projection is.
        if (!/Dependency injection token not found/.test(err instanceof Error ? err.message : String(err))) {
          console.warn(`[MessageBus] runtime event persistence failed for ${topic}`, err);
        }
      }
    }

    // 2. Persist messages of type AgentMessage to the store
    const parseResult = AgentMessageSchema.safeParse(message);
    if (parseResult.success) {
      const agentMsg = parseResult.data;
      const taskId = this.getTaskIdFromMessage(agentMsg);
      if (taskId) {
        try {
          // Prefer the injected (task-scoped) store; fall back to the global
          // container for callers that still register it there (tests).
          const store = this.injectedStore ?? container.resolve<IStore>("IStore");
          await store.saveMessage(taskId, agentMsg);
        } catch (err) {
          // Store might not be initialized or registered yet in unit tests, ignore
        }
      }
    }
  }

  subscribe<T = any>(topicPattern: string, callback: BusCallback<T>): () => void {
    const sub: Subscription = { pattern: topicPattern, callback };
    this.subscriptions.push(sub);

    return () => {
      this.subscriptions = this.subscriptions.filter((s) => s !== sub);
    };
  }

  private getTaskIdFromMessage(msg: AgentMessage): string | null {
    if ("taskId" in msg) {
      return msg.taskId;
    }
    // thoughts don't have taskId directly, they may be prefixed or scoped.
    // For M1, we assume all agent actions are bound to tasks.
    return null;
  }

  private getTaskIdFromTopic(topic: string): string | null {
    const match = topic.match(/^task\.([^.]+)/);
    return match?.[1] ?? null;
  }
}
