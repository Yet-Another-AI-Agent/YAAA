import type { Bot, BotHolderEvent, BotPatch } from "../../bot-holder/interfaces/bot-holder.interfaces";
import type { WorkingDirectoryEvent, WorkingFolder, WorkingFolderPatch } from "../../working-directory-card/interfaces/working-directory-card.interfaces";
import type { SubTask, TaskListEvent, TaskListHandle } from "../../task-list/interfaces/task-list.interfaces";

export type RightPaneEvent = BotHolderEvent | WorkingDirectoryEvent | TaskListEvent | {
  kind: "bot-init" | "bot-add" | "bot-update" | "folder-init" | "folder-add" | "folder-update" | "folder-delete" | "task-init";
  bots?: Bot[];
  bot?: Bot;
  botId?: string;
  botPatch?: BotPatch;
  folders?: WorkingFolder[];
  folder?: WorkingFolder;
  folderId?: string;
  folderPatch?: WorkingFolderPatch;
  parentId?: string;
  subtasks?: SubTask[];
  subtask?: SubTask;
  subtaskId?: string;
  subtaskPatch?: Partial<Omit<SubTask, "id">>;
};

export interface RightPaneHandle {
  emit: (event: RightPaneEvent) => void;
}

export interface RightPaneProps {
  initialBots?: Bot[];
  initialFolders?: WorkingFolder[];
  initialSubtasks?: SubTask[];
  inputEvent?: RightPaneEvent;
  className?: string;
  onEvent?: (event: RightPaneEvent) => void;
}
