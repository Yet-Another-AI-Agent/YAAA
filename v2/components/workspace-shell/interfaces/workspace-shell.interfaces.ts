import type { MessageDraft } from "../../chat-content/interfaces/message.interfaces";
import type { Bot } from "../../bot-holder/interfaces/bot-holder.interfaces";
import type { WorkingFolder } from "../../working-directory-card/interfaces/working-directory-card.interfaces";
import type { SidePanelTab } from "../../side-panel/interfaces/side-panel.interfaces";
import type { LeftBarChat, LeftBarProject } from "../../left-bar/interfaces/left-bar.interfaces";
import type { TypingBarSendPayload } from "../../typing-bar/interfaces/typing-bar.interfaces";

export interface WorkspaceShellProps {
  title?: string;
  initialMessages?: MessageDraft[];
  responseText?: string;
  initialBots?: Bot[];
  initialFolders?: WorkingFolder[];
  initialSideTabs?: SidePanelTab[];
  initialProjects?: LeftBarProject[];
  initialChats?: LeftBarChat[];
  activeChatId?: string;
  homeTitle?: string;
  homePlaceholder?: string;
  onHomeSend?: (payload: TypingBarSendPayload) => void;
  className?: string;
  onBack?: () => void;
}
