import { describe, expect, it } from "vitest";
import type { IConversationStore } from "@yaaa/interfaces";
import type { AgentMessage, AgentRun, Conversation, ConversationMessage, LedgerEntry, TaskPlan } from "@yaaa/shared";
import { ConversationCoordinator, resolveMentions } from "./conversations.js";

class MemoryConversationStore implements IConversationStore {
  readonly conversations: Conversation[] = [];
  readonly messages: ConversationMessage[] = [];
  readonly agents: AgentRun[];

  constructor(agents: AgentRun[] = []) {
    this.agents = agents;
  }

  async initTaskDb(_taskId: string): Promise<void> {}
  async saveMessage(_taskId: string, _message: AgentMessage): Promise<void> {}
  async getMessages(_taskId: string): Promise<AgentMessage[]> { return []; }
  async savePlan(_taskId: string, _plan: TaskPlan): Promise<void> {}
  async getPlan(_taskId: string): Promise<TaskPlan | null> { return null; }
  async saveLedgerEntry(_taskId: string, _entry: LedgerEntry): Promise<void> {}
  async getLedgerEntries(_taskId: string): Promise<LedgerEntry[]> { return []; }
  async saveAuditLog(_taskId: string, _log: { action: string; details: string; approvedBy?: string }): Promise<void> {}
  async getAuditLogs(_taskId: string): Promise<any[]> { return []; }
  async saveAgent(_taskId: string, _agent: AgentRun): Promise<void> {}
  async getAgents(_taskId: string): Promise<AgentRun[]> { return this.agents; }

  async saveConversation(_taskId: string, conversation: Conversation): Promise<void> {
    const index = this.conversations.findIndex((item) => item.id === conversation.id);
    if (index >= 0) this.conversations[index] = conversation;
    else this.conversations.push(conversation);
  }
  async getConversation(taskId: string, conversationId: string): Promise<Conversation | null> {
    return this.conversations.find((item) => item.taskId === taskId && item.id === conversationId) ?? null;
  }
  async getConversations(taskId: string): Promise<Conversation[]> {
    return this.conversations.filter((item) => item.taskId === taskId);
  }
  async saveConversationMessage(_taskId: string, message: ConversationMessage): Promise<void> {
    this.messages.push(message);
  }
  async getConversationMessages(taskId: string, conversationId: string): Promise<ConversationMessage[]> {
    return this.messages.filter((item) => item.taskId === taskId && item.conversationId === conversationId);
  }
}

const agent: AgentRun = {
  id: "agent-1",
  handle: "@sage-1",
  displayName: "Sage",
  taskId: "mission-1",
  subtaskId: "research",
  role: "Researcher",
  modelRole: "worker",
  status: "working",
};

describe("ConversationCoordinator", () => {
  it("creates one durable agent thread and routes known mentions once", async () => {
    const store = new MemoryConversationStore([agent]);
    let id = 0;
    const coordinator = new ConversationCoordinator(
      store,
      () => `id-${++id}`,
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    const publicChat = await coordinator.createPublicConversation({ taskId: agent.taskId });
    const firstThread = await coordinator.getOrCreateAgentThread(agent.taskId, agent);
    const secondThread = await coordinator.getOrCreateAgentThread(agent.taskId, agent);

    expect(firstThread).toEqual(secondThread);
    expect(store.conversations).toHaveLength(2);

    const posted = await coordinator.postMessage({
      taskId: agent.taskId,
      conversationId: publicChat.id,
      authorId: "user-1",
      authorKind: "user",
      content: "Please coordinate with @sage-1 and @orchestrator. @sage-1 is urgent.",
    });

    expect(posted.message.mentions).toEqual([
      { handle: "@sage-1", recipientId: agent.id, recipientKind: "agent" },
      { handle: "@orchestrator", recipientId: "orchestrator", recipientKind: "orchestrator" },
    ]);
    expect(posted.routes.map((route) => route.recipientId)).toEqual([agent.id, "orchestrator"]);
    await expect(coordinator.listMessages(agent.taskId, publicChat.id)).resolves.toEqual([posted.message]);
  });

  it("rejects blank messages, unknown conversations, and ignores unknown handles", async () => {
    const store = new MemoryConversationStore([agent]);
    const coordinator = new ConversationCoordinator(store, () => "fixed-id");
    const chat = await coordinator.createPublicConversation({ taskId: agent.taskId });

    await expect(coordinator.postMessage({
      taskId: agent.taskId, conversationId: chat.id, authorId: "user", authorKind: "user", content: "  ",
    })).rejects.toThrow("cannot be empty");
    await expect(coordinator.listMessages(agent.taskId, "missing")).rejects.toThrow("Conversation not found");
    expect(resolveMentions("Hello @missing and @SAGE-1", [agent])).toEqual([
      { handle: "@sage-1", recipientId: agent.id, recipientKind: "agent" },
    ]);
  });
});
