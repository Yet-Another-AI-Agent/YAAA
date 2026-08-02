import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TypingBarSendPayload } from "../interfaces/typing-bar.interfaces";
import { TypingBar } from "../TypingBar";
import "../typing-bar.css";
import "./showcase.css";

function TypingBarShowcase() {
  const [sent, setSent] = useState<TypingBarSendPayload | null>(null);
  return <main className="typing-bar-showcase"><TypingBar onSend={setSent} /><output className="typing-bar-send-output" data-testid="send-output">{sent ? JSON.stringify({ text: sent.text, attachments: sent.attachments.map(({ name, kind }) => ({ name, kind })), modelTier: sent.modelTier }) : "No message sent yet"}</output></main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><TypingBarShowcase /></StrictMode>);
