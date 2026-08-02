import React from "react";
import type { ChatContentEvent, MessageDraft } from "./interfaces/message.interfaces";
import { MessageCard } from "./MessageCard";
import { useChatContentViewModel } from "./viewmodels/useChatContentViewModel";
import "./create-chat.css";

export interface CreateChatProps {
  initialMessages?: MessageDraft[];
  className?: string;
  onEvent?: (event: ChatContentEvent) => void;
}

export function CreateChat({ initialMessages = [], className = "", onEvent }: CreateChatProps) {
  const { messages, scrollRef, submitForm, toggleForm, changeForm, openFile, submitResponseReview, submitQuestionAnswers } = useChatContentViewModel(initialMessages, onEvent);

  return <section className={`chat-v2-message-list ${className}`} ref={scrollRef} aria-label="Chat messages">
      {messages.map((message) => <MessageCard key={message.uuid} message={message} onFormChange={changeForm} onFormSubmit={submitForm} onFormToggle={toggleForm} onFileOpen={openFile} onResponseReview={submitResponseReview} onQuestionSubmit={submitQuestionAnswers} />)}
      {messages.length === 0 && <div className="chat-v2-empty"><span>✦</span><strong>Your conversation starts here</strong><small>Create a message with the library or use the composer below.</small></div>}
  </section>;
}
