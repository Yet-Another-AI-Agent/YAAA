import React from "react";
import { TypingBar } from "../typing-bar/TypingBar";
import type { TypingBarSendPayload } from "../typing-bar/interfaces/typing-bar.interfaces";

export function WorkspaceHome({ onSend, placeholder }: { onSend: (payload: TypingBarSendPayload) => void; placeholder?: string }) {
  return <section className="v2-workspace-home" aria-label="New chat"><div className="v2-workspace-home-composer"><TypingBar onSend={onSend} placeholder={placeholder} /></div></section>;
}
