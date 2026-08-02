import { useEffect, useRef, useState } from "react";
import { InputTickType, MessageType } from "../../chat-content/enums/message.enums";
import type { MessageDraft } from "../../chat-content/interfaces/message.interfaces";
import type { TypingBarSendPayload } from "../../typing-bar/interfaces/typing-bar.interfaces";
import { inferFileKind } from "../../special-file-opener/models/file.models";

const defaultResponse = "Thanks — I received your request and will take it from here.";

export function useChatShellViewModel(initialMessages: MessageDraft[] = [], responseText = defaultResponse, initialSend?: TypingBarSendPayload) {
  const [messages, setMessages] = useState(initialMessages);
  const sequence = useRef(0);
  const queue = useRef<Array<{ id: string; text: string; cursor: number }>>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialSendStarted = useRef(false);
  const pumpQueue = () => {
    if (timer.current || queue.current.length === 0) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const job = queue.current[0];
      if (!job) return;
      job.cursor += 1;
      const complete = job.cursor >= job.text.length;
      setMessages((current) => current.map((message) => message.uuid === job.id ? { ...message, typing: !complete, inputTickType: complete ? InputTickType.Single : InputTickType.Loading, messageBody: { kind: "text", text: job.text.slice(0, job.cursor) } } : message));
      if (complete) queue.current.shift();
      pumpQueue();
    }, 12);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const send = ({ text, attachments }: TypingBarSendPayload) => {
    sequence.current += 1;
    const responseId = `chat-shell-response-${sequence.current}`;
    const request: MessageDraft = { uuid: `chat-shell-request-${sequence.current}`, type: MessageType.RequestMessage, userName: "User", showInputTick: true, inputTickType: InputTickType.Single, messageBody: { kind: "request", text, attachments: attachments.map((attachment) => ({ name: attachment.name, kind: inferFileKind(attachment.name, attachment.mimeType), mimeType: attachment.mimeType, size: attachment.size })) } };
    const response: MessageDraft = { uuid: responseId, type: MessageType.ResponseMessage, userName: "YAAA", typing: true, showInputTick: false, inputTickType: InputTickType.Loading, messageBody: { kind: "text", text: "" } };
    setMessages((current) => [...current, request, response]);
    queue.current.push({ id: responseId, text: responseText, cursor: 0 });
    pumpQueue();
  };
  useEffect(() => { if (initialSend && !initialSendStarted.current) { initialSendStarted.current = true; send(initialSend); } }, [initialSend]);
  return { messages, send };
}
