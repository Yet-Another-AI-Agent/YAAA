import React, { forwardRef, useImperativeHandle, useRef } from "react";
import { BotHolder } from "../bot-holder/BotHolder";
import type { BotHolderHandle } from "../bot-holder/interfaces/bot-holder.interfaces";
import { WorkingDirectoryCard } from "../working-directory-card/WorkingDirectoryCard";
import type { WorkingDirectoryCardHandle } from "../working-directory-card/interfaces/working-directory-card.interfaces";
import { TaskList } from "../task-list/TaskList";
import type { TaskListHandle } from "../task-list/interfaces/task-list.interfaces";
import type { RightPaneEvent, RightPaneHandle, RightPaneProps } from "./interfaces/right-pane.interfaces";
import "./right-pane.css";

export const RightPane = forwardRef<RightPaneHandle, RightPaneProps>(function RightPane({ initialBots = [], initialFolders = [], initialSubtasks = [], inputEvent, className = "", onEvent }, ref) {
  const botRef = useRef<BotHolderHandle>(null);
  const folderRef = useRef<WorkingDirectoryCardHandle>(null);
  const taskRef = useRef<TaskListHandle>(null);
  const emit = (event: RightPaneEvent) => {
    switch (event.kind) {
      case "bot-init": botRef.current?.init(event.bots ?? []); break;
      case "bot-add": if (event.bot) botRef.current?.addBot(event.bot); break;
      case "bot-update": if (event.botId && event.botPatch) botRef.current?.updateBot(event.botId, event.botPatch); break;
      case "folder-init": folderRef.current?.init(event.folders ?? []); break;
      case "folder-add": if (event.folder) folderRef.current?.addFolder(event.folder, event.parentId); break;
      case "folder-update": if (event.folderId && event.folderPatch) folderRef.current?.updateFolder(event.folderId, event.folderPatch); break;
      case "folder-delete": if (event.folderId) folderRef.current?.deleteFolder(event.folderId); break;
      case "subtask-add": if (event.subtask) taskRef.current?.addSubtask(event.subtask); break;
      case "subtask-update": if (event.subtaskId) taskRef.current?.updateSubtask(event.subtaskId, event.patch); break;
      case "subtask-complete": if (event.subtaskId) taskRef.current?.completeSubtask(event.subtaskId); break;
      case "subtask-delete": if (event.subtaskId) taskRef.current?.deleteSubtask(event.subtaskId); break;
      case "microtask-add": taskRef.current?.addMicroTask(event.subtaskId, event.microTask); break;
      case "microtask-update": taskRef.current?.updateMicroTask(event.subtaskId, event.microTaskId, event.patch); break;
      case "microtask-complete": taskRef.current?.completeMicroTask(event.subtaskId, event.microTaskId); break;
      case "microtask-delete": taskRef.current?.deleteMicroTask(event.subtaskId, event.microTaskId); break;
      case "task-init": taskRef.current?.init(event.subtasks ?? []); break;
    }
  };
  React.useEffect(() => { if (inputEvent) emit(inputEvent); }, [inputEvent]);
  useImperativeHandle(ref, () => ({ emit }), []);
  return <aside className={`v2-right-pane ${className}`} aria-label="Right pane">
    <BotHolder ref={botRef} initialBots={initialBots} onEvent={onEvent} />
    <WorkingDirectoryCard ref={folderRef} initialFolders={initialFolders} onEvent={onEvent} />
    <TaskList ref={taskRef} initialSubtasks={initialSubtasks} onEvent={onEvent} />
  </aside>;
});
