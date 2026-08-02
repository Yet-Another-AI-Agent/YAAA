import type { ChatMessage, MessageDraft } from "../interfaces/message.interfaces";
import { InputTickType } from "../enums/message.enums";
import { cloneValue } from "../utils/clone";

export function createChatMessage(draft: MessageDraft, uuid: string, createdAt: number): ChatMessage {
  return {
    ...cloneValue(draft),
    uuid,
    typing: draft.typing ?? false,
    inputTickType: draft.inputTickType ?? InputTickType.Single,
    createdAt: draft.createdAt ?? createdAt,
  };
}
