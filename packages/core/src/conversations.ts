import crypto from "node:crypto";
import type { IConversationStore } from "@yaaa/interfaces";
import type {
  AgentRun,
  Conversation,
  ConversationAuthorKind,
  ConversationMessage,
  Mention,
  MentionRoute,
} from "@yaaa/shared";

const ORCHESTRATOR_HANDLE = "@orchestrator";
const ORCHESTRATOR_ID = "orchestrator";
const MENTION_PATTERN = /(?:^|[\s([{])@([a-z0-9][a-z0-9_-]*)\b/gi;

export interface CreateConversationInput {
  taskId: string;
  title?: string;
}

export interface PostConversationMessageInput {
  taskId: string;
  conversationId: string;
  authorId: string;
  authorKind: ConversationAuthorKind;
  content: string;
}

export interface PostedConversationMessage {
  message: ConversationMessage;
  routes: MentionRoute[];
}

/**
 * The conversation coordinator deliberately has no runtime or UI dependency.
 * It owns the invariants shared by Electron IPC, an API server, and agents:
 * one public channel per caller, agent-thread membership, and deterministic
 * @mention routing.
 */
export class ConversationCoordinator {
  constructor(
    private readonly store: IConversationStore,
    private readonly createId: () => string = crypto.randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createPublicConversation(input: CreateConversationInput): Promise<Conversation> {
    return this.saveConversation({
      id: this.createId(),
      taskId: input.taskId,
      kind: "public",
      title: input.title?.trim() || "Mission chat",
      participantIds: [ORCHESTRATOR_ID],
      createdAt: this.timestamp(),
      updatedAt: this.timestamp(),
    });
  }

  async getOrCreateAgentThread(taskId: string, agent: AgentRun): Promise<Conversation> {
    const existing = (await this.store.getConversations(taskId)).find(
      (conversation) => conversation.kind === "agent_thread" && conversation.agentId === agent.id && !conversation.archivedAt,
    );
    if (existing) return existing;

    const createdAt = this.timestamp();
    return this.saveConversation({
      id: this.createId(),
      taskId,
      kind: "agent_thread",
      title: `${agent.displayName} · ${agent.role}`,
      participantIds: [ORCHESTRATOR_ID, agent.id],
      agentId: agent.id,
      createdAt,
      updatedAt: createdAt,
    });
  }

  async listConversations(taskId: string): Promise<Conversation[]> {
    return this.store.getConversations(taskId);
  }

  async listMessages(taskId: string, conversationId: string): Promise<ConversationMessage[]> {
    await this.requireConversation(taskId, conversationId);
    return this.store.getConversationMessages(taskId, conversationId);
  }

  async postMessage(input: PostConversationMessageInput): Promise<PostedConversationMessage> {
    const content = input.content.trim();
    if (!content) throw new Error("A conversation message cannot be empty.");
    await this.requireConversation(input.taskId, input.conversationId);

    const agents = await this.store.getAgents(input.taskId);
    const mentions = resolveMentions(content, agents);
    const createdAt = this.timestamp();
    const message: ConversationMessage = {
      id: this.createId(),
      taskId: input.taskId,
      conversationId: input.conversationId,
      authorId: input.authorId,
      authorKind: input.authorKind,
      content,
      mentions,
      createdAt,
    };
    await this.store.saveConversationMessage(input.taskId, message);

    return {
      message,
      routes: mentions.map((mention) => ({
        conversationId: input.conversationId,
        messageId: message.id,
        recipientId: mention.recipientId,
        recipientKind: mention.recipientKind,
        handle: mention.handle,
      })),
    };
  }

  private async saveConversation(conversation: Conversation): Promise<Conversation> {
    await this.store.saveConversation(conversation.taskId, conversation);
    return conversation;
  }

  private async requireConversation(taskId: string, conversationId: string): Promise<Conversation> {
    const conversation = await this.store.getConversation(taskId, conversationId);
    if (!conversation) throw new Error("Conversation not found for this mission.");
    if (conversation.archivedAt) throw new Error("Conversation is archived.");
    return conversation;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

/** Parse known, callable handles only. Unknown mentions stay as plain message text. */
export function resolveMentions(content: string, agents: AgentRun[]): Mention[] {
  const recipients = new Map<string, Mention>();
  recipients.set(ORCHESTRATOR_HANDLE, {
    handle: ORCHESTRATOR_HANDLE,
    recipientId: ORCHESTRATOR_ID,
    recipientKind: "orchestrator",
  });
  for (const agent of agents) {
    const handle = normaliseHandle(agent.handle);
    if (handle) {
      recipients.set(handle, { handle: agent.handle, recipientId: agent.id, recipientKind: "agent" });
    }
  }

  const mentions: Mention[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(MENTION_PATTERN)) {
    const handle = `@${match[1].toLowerCase()}`;
    const mention = recipients.get(handle);
    if (mention && !seen.has(mention.recipientId)) {
      mentions.push(mention);
      seen.add(mention.recipientId);
    }
  }
  return mentions;
}

function normaliseHandle(handle: string): string | null {
  const normalized = handle.trim().toLowerCase();
  return /^@[a-z0-9][a-z0-9_-]*$/.test(normalized) ? normalized : null;
}
