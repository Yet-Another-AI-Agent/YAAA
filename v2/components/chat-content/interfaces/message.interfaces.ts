import type { FormControlKind, InputTickType, MessageType, ViewerKind } from "../enums/message.enums";
import type { SpecialFile } from "../../special-file-opener/interfaces/file.interfaces";
import type { MarkdownLineComment } from "../../markdown-commenter/interfaces/markdown-commenter.interfaces";
import type { ResponseReviewDecision } from "../../response-review/interfaces/response-review.interfaces";
import type { CarouselQuestion, QuestionAnswer } from "../../question-carousel/interfaces/question-carousel.interfaces";

export interface TextMessageBody {
  kind: "text";
  text: string;
}

export interface RequestMessageBody {
  kind: "request";
  text: string;
  attachments: SpecialFile[];
}

export interface ViewerMessageBody {
  kind: "viewer";
  viewer: ViewerKind;
  title: string;
  fileName?: string;
  previewText?: string;
}

export interface FileMessageBody {
  kind: "file";
  file: SpecialFile;
}

export interface MarkdownMessageBody { kind: "markdown"; content: string; title?: string; }
export interface CodeMessageBody { kind: "code"; content: string; language?: string; title?: string; }
export interface CodeDiffMessageBody { kind: "code-diff"; before: string; after: string; language?: string; title?: string; }
export interface MarkdownCommentMessageBody { kind: "markdown-commenter"; content: string; title?: string; }
export interface ResponseReviewMessageBody { kind: "response-review"; content: string; title?: string; }
export interface QuestionCarouselMessageBody { kind: "question-carousel"; questions: CarouselQuestion[]; title?: string; }

export interface FormControl {
  id: string;
  kind: FormControlKind;
  label: string;
  value?: string | boolean;
  defaultValue?: string | boolean;
  options?: Array<{ label: string; value: string }>;
  disabled?: boolean;
  action?: (value: string | boolean) => void;
}

export interface FormMessageBody {
  kind: "form";
  title: string;
  collapsible?: boolean;
  collapsed?: boolean;
  submitted?: boolean;
  decision?: "accepted" | "rejected";
  controls: FormControl[];
  submitLabel?: string;
}

export type MessageBody = TextMessageBody | RequestMessageBody | ViewerMessageBody | FileMessageBody | MarkdownMessageBody | CodeMessageBody | CodeDiffMessageBody | MarkdownCommentMessageBody | ResponseReviewMessageBody | QuestionCarouselMessageBody | FormMessageBody;

export interface MessageDraft {
  uuid?: string;
  type: MessageType;
  userProfilePic?: string;
  userName: string;
  typing?: boolean;
  /** Show delivery/loading ticks for this message. User-facing responses hide them by default. */
  showInputTick?: boolean;
  messageBody: MessageBody;
  inputTickType?: InputTickType;
  createdAt?: number;
}

export interface ChatMessage extends MessageDraft {
  uuid: string;
  typing: boolean;
  inputTickType: InputTickType;
  createdAt: number;
}

export type MessagePatch = Partial<Omit<ChatMessage, "uuid" | "messageBody">> & {
  messageBody?: Record<string, unknown>;
};

export interface MessageLibraryEvents {
  onChange?: (messages: ChatMessage[]) => void;
}

export interface ChatContentEvent {
  kind: "control-change" | "form-action" | "file-open" | "response-review" | "question-carousel";
  action: "change" | "submit" | "button" | "open" | "submit-answers" | ResponseReviewDecision;
  messageId: string;
  messageData: ChatMessage;
  controlId?: string;
  controlLabel?: string;
  value?: string | boolean;
  fileData?: SpecialFile;
  commentData?: MarkdownLineComment[];
  answerData?: QuestionAnswer[];
}
