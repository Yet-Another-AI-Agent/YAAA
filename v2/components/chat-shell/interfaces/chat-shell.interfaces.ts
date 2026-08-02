import type { MessageDraft } from "../../chat-content/interfaces/message.interfaces";
import type { TypingBarSendPayload } from "../../typing-bar/interfaces/typing-bar.interfaces";

export interface ChatShellProps {
  initialMessages?: MessageDraft[];
  responseText?: string;
  className?: string;
  initialSend?: TypingBarSendPayload;
}
