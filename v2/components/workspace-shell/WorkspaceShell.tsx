import React, { useState } from "react";
import { LeftBar } from "../left-bar/LeftBar";
import { SidePanel } from "../side-panel/SidePanel";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { WorkspaceHome } from "./WorkspaceHome";
import { WorkspaceChat } from "./WorkspaceChat";
import type { MessageDraft } from "../chat-content/interfaces/message.interfaces";
import type { TypingBarSendPayload } from "../typing-bar/interfaces/typing-bar.interfaces";
import type { WorkspaceShellProps } from "./interfaces/workspace-shell.interfaces";
import "./workspace-shell.css";
import "./workspace-shell-heading.css";

export function WorkspaceShell({ title = "New chat", initialMessages = [], responseText, initialBots = [], initialFolders = [], initialSideTabs = [], initialProjects = [], initialChats = [], activeChatId, homeTitle = "New chat", homePlaceholder, onHomeSend, className = "", onBack }: WorkspaceShellProps) {
  const [leftVisible, setLeftVisible] = useState(true);
  const [sidePanelVisible, setSidePanelVisible] = useState(true);
  const [isHome, setIsHome] = useState(false);
  const [chatMessages, setChatMessages] = useState<MessageDraft[]>(initialMessages);
  const [initialSend, setInitialSend] = useState<TypingBarSendPayload>();
  const goHome = () => { setIsHome(true); setInitialSend(undefined); onBack?.(); };
  const startChat = (payload: TypingBarSendPayload) => { onHomeSend?.(payload); setInitialSend(payload); setIsHome(false); };
  return <main className={`v2-workspace-shell ${className}`} aria-label="Chat workspace">
    <div className={`v2-workspace-left-shell ${leftVisible ? "is-visible" : "is-hidden"}`} aria-hidden={!leftVisible}>
      <LeftBar initialProjects={initialProjects} initialChats={initialChats} activeChatId={activeChatId} />
    </div>
    <section className="v2-workspace-main">
      <WorkspaceHeader title={isHome ? homeTitle : title} leftVisible={leftVisible} sidePanelVisible={sidePanelVisible} onBack={goHome} onToggleLeft={() => setLeftVisible((visible) => !visible)} onToggleSidePanel={() => setSidePanelVisible((visible) => !visible)} />
      {isHome ? <WorkspaceHome onSend={startChat} placeholder={homePlaceholder} /> : <WorkspaceChat initialMessages={chatMessages} responseText={responseText} initialBots={initialBots} initialFolders={initialFolders} initialSend={initialSend} />}
    </section>
    <div className={`v2-workspace-side-panel-shell ${sidePanelVisible ? "is-visible" : "is-hidden"}`} aria-hidden={!sidePanelVisible}>
      <SidePanel initialTabs={initialSideTabs} />
    </div>
  </main>;
}
