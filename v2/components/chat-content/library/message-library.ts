import type { ChatMessage, MessageDraft, MessageLibraryEvents, MessagePatch } from "../interfaces/message.interfaces";
import { cloneValue } from "../utils/clone";
import { createMessageId } from "../utils/ids";
import { mergeRecursive } from "../utils/recursive-data";
import { createChatMessage } from "../models/message.models";

export class MessageLibrary {
  private readonly messages = new Map<string, ChatMessage>();
  private readonly onChange?: MessageLibraryEvents["onChange"];

  public constructor(events: MessageLibraryEvents = {}) {
    this.onChange = events.onChange;
  }

  public createMessage(draft: MessageDraft): string {
    const uuid = draft.uuid ?? createMessageId();
    const message: ChatMessage = createChatMessage(draft, uuid, Date.now());
    this.messages.set(uuid, message);
    this.emitChange();
    return uuid;
  }

  public createMassMessages(drafts: MessageDraft[]): string[] {
    const ids = drafts.map((draft) => this.createMessage(draft));
    return ids;
  }

  public addMessage(uuid: string, data: unknown): ChatMessage {
    return this.mergeMessage(uuid, data);
  }

  public getMessageData(uuid: string): ChatMessage | undefined {
    const message = this.messages.get(uuid);
    return message ? cloneValue(message) : undefined;
  }

  public updateMessage(uuid: string, patch: MessagePatch): ChatMessage {
    return this.mergeMessage(uuid, patch);
  }

  public getMessages(): ChatMessage[] {
    return [...this.messages.values()].map(cloneValue);
  }

  private mergeMessage(uuid: string, data: unknown): ChatMessage {
    const current = this.messages.get(uuid);
    if (!current) throw new Error(`Message not found: ${uuid}`);
    const next = mergeRecursive(current, data);
    this.messages.set(uuid, next);
    this.emitChange();
    return cloneValue(next);
  }

  private emitChange(): void {
    this.onChange?.(this.getMessages());
  }
}
