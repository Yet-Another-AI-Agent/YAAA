import React from "react";
import type { ChatMessage } from "./interfaces/message.interfaces";
import type { SpecialFile } from "../special-file-opener/interfaces/file.interfaces";
import type { MarkdownLineComment } from "../markdown-commenter/interfaces/markdown-commenter.interfaces";
import type { ResponseReviewDecision } from "../response-review/interfaces/response-review.interfaces";
import type { QuestionAnswer } from "../question-carousel/interfaces/question-carousel.interfaces";
import { MessageBodyView } from "./MessageBody";

interface MessageCardProps {
  message: ChatMessage;
  onFormChange: (messageId: string, controlId: string, value: string | boolean) => void;
  onFormSubmit: (messageId: string, controlId?: string) => void;
  onFormToggle: (messageId: string) => void;
  onFileOpen: (messageId: string, file: SpecialFile) => void;
  onResponseReview: (messageId: string, decision: ResponseReviewDecision, comments: MarkdownLineComment[]) => void;
  onQuestionSubmit: (messageId: string, answers: QuestionAnswer[]) => void;
}

export function MessageCard({ message, onFormChange, onFormSubmit, onFormToggle, onFileOpen, onResponseReview, onQuestionSubmit }: MessageCardProps) {
  const initials = message.userName.slice(0, 1).toUpperCase();
  return <article className={`chat-v2-message chat-v2-message-${message.type}`} data-message-id={message.uuid}>
    <div className="chat-v2-avatar">{message.userProfilePic ? <img src={message.userProfilePic} alt="" /> : initials}</div>
    <div className="chat-v2-message-content">
      <div className="chat-v2-message-meta"><strong>{message.userName}</strong><span>{message.type.replaceAll("Message", "")}</span></div>
      <MessageBodyView body={message.messageBody} onFormChange={(id, value) => onFormChange(message.uuid, id, value)} onFormSubmit={(controlId) => onFormSubmit(message.uuid, controlId)} onFormToggle={() => onFormToggle(message.uuid)} onFileOpen={(file) => onFileOpen(message.uuid, file)} onResponseReview={(decision, comments) => onResponseReview(message.uuid, decision, comments)} onQuestionSubmit={(answers) => onQuestionSubmit(message.uuid, answers)} />
      {message.typing && <span className="chat-v2-typing-cursor" aria-label="typing" />}
      {(message.showInputTick ?? message.type !== "ResponseMessage") && <span className="chat-v2-ticks" aria-label={`delivery ${message.inputTickType}`}>{message.inputTickType === "Loading" ? "◌" : message.inputTickType === "Double" ? "✓✓" : "✓"}</span>}
    </div>
  </article>;
}
