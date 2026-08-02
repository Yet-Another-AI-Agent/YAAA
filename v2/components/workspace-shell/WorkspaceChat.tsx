import React from "react";
import { ChatShell } from "../chat-shell/ChatShell";
import { RightPane } from "../right-pane/RightPane";
import type { MessageDraft } from "../chat-content/interfaces/message.interfaces";
import type { Bot } from "../bot-holder/interfaces/bot-holder.interfaces";
import type { WorkingFolder } from "../working-directory-card/interfaces/working-directory-card.interfaces";
import type { TypingBarSendPayload } from "../typing-bar/interfaces/typing-bar.interfaces";

export function WorkspaceChat({ initialMessages, responseText, initialBots, initialFolders, initialSend }: { initialMessages: MessageDraft[]; responseText?: string; initialBots: Bot[]; initialFolders: WorkingFolder[]; initialSend?: TypingBarSendPayload }) {
  return <div className="v2-workspace-main-body"><section className="v2-workspace-chat"><ChatShell initialMessages={initialMessages} responseText={responseText} initialSend={initialSend} /></section><RightPane initialBots={initialBots} initialFolders={initialFolders} /></div>;
}
