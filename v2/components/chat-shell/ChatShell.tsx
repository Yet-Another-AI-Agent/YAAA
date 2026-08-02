import React from "react";
import { CreateChat } from "../chat-content/CreateChat";
import { TypingBar } from "../typing-bar/TypingBar";
import type { ChatShellProps } from "./interfaces/chat-shell.interfaces";
import { useChatShellViewModel } from "./viewmodels/useChatShellViewModel";
import "./chat-shell.css";

export function ChatShell({ initialMessages = [], responseText, initialSend, className = "" }: ChatShellProps) {
  const viewModel = useChatShellViewModel(initialMessages, responseText, initialSend);
  return <main className={`v2-chat-shell ${className}`} aria-label="Chat"><div className="v2-chat-shell-window"><CreateChat initialMessages={viewModel.messages} /></div><div className="v2-chat-shell-composer"><TypingBar onSend={viewModel.send} /></div></main>;
}
