export type WorkingFolderKind = "agent-space" | "agent-working";

export interface WorkingFile {
  id: string;
  name: string;
  path?: string;
  change?: "created" | "modified" | "deleted";
}

export interface WorkingTreeFolder {
  id: string;
  name: string;
  path: string;
  type: "folder";
  children?: WorkingTreeNode[];
}

export interface WorkingTreeFile extends WorkingFile {
  type: "file";
}

export type WorkingTreeNode = WorkingTreeFolder | WorkingTreeFile;

export interface WorkingFolder {
  id: string;
  name: string;
  path: string;
  kind: WorkingFolderKind;
  taskId?: string;
  agentId?: string;
  agentName?: string;
  itemCount?: number;
  updatedAt?: string;
  files?: WorkingFile[];
  children?: WorkingTreeNode[];
}

export type WorkingFolderPatch = Partial<Omit<WorkingFolder, "id">>;

export interface WorkingDirectoryCardHandle {
  init: (folders: WorkingFolder[]) => void;
  addFolder: (folder: WorkingFolder, parentId?: string) => void;
  updateFolder: (id: string, patch: WorkingFolderPatch) => void;
  deleteFolder: (id: string) => void;
}

export interface WorkingDirectoryCardProps {
  initialFolders?: WorkingFolder[];
  pageSize?: number;
  className?: string;
  onOpenFolder?: (folder: WorkingFolder) => void;
  onOpenFile?: (file: WorkingFile, fullPath: string, folder: WorkingFolder) => void;
  onEvent?: (event: WorkingDirectoryEvent) => void;
  openFolder?: (folder: WorkingFolder) => void | Promise<void>;
}

export interface WorkingDirectoryEvent {
  kind: "file-open";
  action: "open";
  fileName: string;
  path: string;
  file: WorkingFile;
  folder: WorkingFolder;
}
