import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatContentEvent, ChatMessage, MessageDraft } from "../interfaces/message.interfaces";
import type { SpecialFile } from "../../special-file-opener/interfaces/file.interfaces";
import type { MarkdownLineComment } from "../../markdown-commenter/interfaces/markdown-commenter.interfaces";
import type { ResponseReviewDecision } from "../../response-review/interfaces/response-review.interfaces";
import type { QuestionAnswer } from "../../question-carousel/interfaces/question-carousel.interfaces";
import { MessageLibrary } from "../library/message-library";

export function useChatContentViewModel(initialMessages: MessageDraft[], onEvent?: (event: ChatContentEvent) => void) {
  const library = useMemo(() => {
    const instance = new MessageLibrary();
    instance.createMassMessages(initialMessages);
    return instance;
  }, [initialMessages]);
  const [messages, setMessages] = useState<ChatMessage[]>(() => library.getMessages());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages(library.getMessages());
  }, [library]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof element.scrollTo !== "function") return;
    if (typeof requestAnimationFrame !== "function") { element.scrollTo({ top: element.scrollHeight, behavior: "smooth" }); return; }
    const frame = requestAnimationFrame(() => element.scrollTo({ top: element.scrollHeight, behavior: "auto" }));
    return () => cancelAnimationFrame(frame);
  }, [messages.length, messages[messages.length - 1]?.messageBody]);

  const refresh = () => setMessages(library.getMessages());
  const submitForm = (messageId: string, controlId?: string) => {
    const currentMessage = library.getMessageData(messageId);
    if (currentMessage?.messageBody.kind !== "form" || currentMessage.messageBody.submitted) return;
    const control = controlId ? currentMessage.messageBody.controls.find((item) => item.id === controlId) : undefined;
    const isDecision = Boolean(control?.kind === "button" && /^(accept|reject)\b/i.test(control.label.trim()));
    if (!controlId || isDecision) library.updateMessage(messageId, { messageBody: { submitted: true, ...(isDecision ? { decision: /^accept\b/i.test(control!.label.trim()) ? "accepted" : "rejected" } : {}) } });
    const messageData = library.getMessageData(messageId);
    if (messageData) onEvent?.({ kind: "form-action", action: controlId ? "button" : "submit", messageId, messageData, controlId });
    refresh();
  };
  const toggleForm = (messageId: string) => {
    const message = library.getMessageData(messageId);
    if (message?.messageBody.kind !== "form") return;
    library.updateMessage(messageId, { messageBody: { collapsed: !message.messageBody.collapsed } });
    refresh();
  };
  const changeForm = (messageId: string, controlId: string, value: string | boolean) => {
    library.updateMessage(messageId, { messageBody: { controls: [{ id: controlId, value }] } });
    const messageData = library.getMessageData(messageId);
    const control = messageData?.messageBody.kind === "form" ? messageData.messageBody.controls.find((item) => item.id === controlId) : undefined;
    if (messageData) onEvent?.({ kind: "control-change", action: "change", messageId, messageData, controlId, controlLabel: control?.label, value });
    refresh();
  };

  const openFile = (messageId: string, file: SpecialFile) => {
    onEvent?.({ kind: "file-open", action: "open", messageId, messageData: library.getMessageData(messageId)!, fileData: file });
  };

  const submitResponseReview = (messageId: string, decision: ResponseReviewDecision, comments: MarkdownLineComment[]) => {
    const messageData = library.getMessageData(messageId);
    if (messageData) onEvent?.({ kind: "response-review", action: decision, messageId, messageData, commentData: comments });
  };
  const submitQuestionAnswers = (messageId: string, answers: QuestionAnswer[]) => {
    const messageData = library.getMessageData(messageId);
    if (messageData) onEvent?.({ kind: "question-carousel", action: "submit-answers", messageId, messageData, answerData: answers });
  };

  return { messages, scrollRef, submitForm, toggleForm, changeForm, openFile, submitResponseReview, submitQuestionAnswers };
}
