import type { ModelTier } from "../enums/typing-bar.enums";
import type { TypingAttachment } from "../interfaces/typing-bar.interfaces";

export interface TypingBarState {
  text: string;
  attachments: TypingAttachment[];
  modelTier: ModelTier;
}

export function createTypingBarState(modelTier: ModelTier): TypingBarState {
  return { text: "", attachments: [], modelTier };
}
