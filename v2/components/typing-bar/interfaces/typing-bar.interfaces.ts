import type { AttachmentKind, ModelTier } from "../enums/typing-bar.enums";

export interface TypingAttachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  mimeType: string;
  size: number;
  file?: File | Blob;
}

export interface VoiceNote extends TypingAttachment {
  kind: typeof AttachmentKind.Audio;
  durationMs?: number;
}

export interface TypingBarSendPayload {
  text: string;
  attachments: TypingAttachment[];
  modelTier: ModelTier;
}

export interface TypingBarProps {
  onSend: (payload: TypingBarSendPayload) => void;
  initialModelTier?: ModelTier;
  placeholder?: string;
  className?: string;
}
