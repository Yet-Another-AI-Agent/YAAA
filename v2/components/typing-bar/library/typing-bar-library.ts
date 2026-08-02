import type { ModelTier } from "../enums/typing-bar.enums";
import type { TypingAttachment, TypingBarSendPayload } from "../interfaces/typing-bar.interfaces";
import { createTypingBarState, type TypingBarState } from "../models/typing-bar.models";
import { ModelTier as ModelTierValues } from "../enums/typing-bar.enums";

export class TypingBarLibrary {
  private state: TypingBarState;

  public constructor(modelTier: ModelTier = ModelTierValues.Mid) {
    this.state = createTypingBarState(modelTier);
  }

  public setText(text: string): void { this.state.text = text; }
  public setModelTier(modelTier: ModelTier): void { this.state.modelTier = modelTier; }
  public addAttachments(attachments: TypingAttachment[]): void { this.state.attachments = [...this.state.attachments, ...attachments]; }
  public removeAttachment(id: string): void { this.state.attachments = this.state.attachments.filter((attachment) => attachment.id !== id); }
  public getAttachments(): TypingAttachment[] { return [...this.state.attachments]; }
  public createSendPayload(): TypingBarSendPayload { return { text: this.state.text.trim(), attachments: [...this.state.attachments], modelTier: this.state.modelTier }; }
  public clear(): void { this.state = createTypingBarState(this.state.modelTier); }
}
