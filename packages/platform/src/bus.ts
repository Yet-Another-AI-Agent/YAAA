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

  constructor() {
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

    // 2. Persist messages of type AgentMessage to the store
    const parseResult = AgentMessageSchema.safeParse(message);
    if (parseResult.success) {
      const agentMsg = parseResult.data;
      const taskId = this.getTaskIdFromMessage(agentMsg);
      if (taskId) {
        try {
          // Resolve store dynamically to prevent circular dependencies at container initialization
          const store = container.resolve<IStore>("IStore");
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
}
