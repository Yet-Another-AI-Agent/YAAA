import type { WorkingFolder, WorkingFolderPatch, WorkingTreeFolder, WorkingTreeNode } from "../interfaces/working-directory-card.interfaces";

export function getCommonWorkingPath(folders: WorkingFolder[]): string | undefined {
  const paths: string[] = [];
  const visit = (nodes: WorkingTreeNode[] = []) => nodes.forEach((node) => node.type === "file" ? node.path && paths.push(node.path) : visit(node.children));
  folders.forEach((folder) => {
    visit(folder.children);
    folder.files?.forEach((file) => file.path && paths.push(file.path));
  });
  if (paths.length === 0) return undefined;
  const normalized = paths.map(normalizePath);
  const absolute = normalized.some((path) => isAbsolutePath(path));
  const comparable = absolute ? normalized.filter(isAbsolutePath) : normalized;
  const segments = comparable.map((path) => path.split("/").filter(Boolean));
  const first = segments[0] ?? [];
  let commonLength = first.length;
  for (const current of segments.slice(1)) {
    commonLength = Math.min(commonLength, current.findIndex((part, index) => part !== first[index]) === -1 ? current.length : current.findIndex((part, index) => part !== first[index]));
  }
  if (commonLength === first.length) commonLength = Math.max(0, commonLength - 1);
  const prefix = first.slice(0, commonLength).join("/");
  return absolute ? `/${prefix}`.replace(/\/$/, "") || "/" : prefix;
}

function normalizePath(value: string) { return value.replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/$/, ""); }
function isAbsolutePath(value: string) { return value.startsWith("/") || /^[A-Za-z]:\//.test(value); }

export function initWorkingFolders(folders: WorkingFolder[] = []): WorkingFolder[] {
  return folders.map((folder) => ({ ...folder }));
}

export function addWorkingFolder(folders: WorkingFolder[], folder: WorkingFolder, parentId?: string): WorkingFolder[] {
  if (parentId) return folders.map((current) => addToTree(current, folder, parentId));
  const existing = folders.findIndex((item) => item.id === folder.id);
  if (existing < 0) return [...folders, { ...folder }];
  return updateWorkingFolder(folders, folder.id, folder);
}

function addToTree(current: WorkingFolder, folder: WorkingFolder, parentId: string): WorkingFolder {
  if (current.id === parentId) return { ...current, children: [...(current.children ?? []), toTreeFolder(folder)] };
  return { ...current, children: updateChildren(current.children, (node) => node.type === "folder" ? addToTreeNode(node, folder, parentId) : node) };
}

function addToTreeNode(node: WorkingTreeFolder, folder: WorkingFolder, parentId: string): WorkingTreeFolder {
  if (node.id === parentId) return { ...node, children: [...(node.children ?? []), toTreeFolder(folder)] };
  return { ...node, children: updateChildren(node.children, (child) => child.type === "folder" ? addToTreeNode(child, folder, parentId) : child) };
}

function toTreeFolder(folder: WorkingFolder): WorkingTreeFolder {
  return { id: folder.id, name: folder.name, path: folder.path, type: "folder", children: folder.children ?? (folder.files ?? []).map((file) => ({ ...file, type: "file" as const })) };
}

export function updateWorkingFolder(
  folders: WorkingFolder[],
  id: string,
  patch: WorkingFolderPatch,
): WorkingFolder[] {
  return folders.map((folder) => updateFolderTree(folder, id, patch));
}

export function deleteWorkingFolder(folders: WorkingFolder[], id: string): WorkingFolder[] {
  return folders.filter((folder) => folder.id !== id).map((folder) => ({ ...folder, children: deleteFromTree(folder.children, id) }));
}

function updateFolderTree(folder: WorkingFolder, id: string, patch: WorkingFolderPatch): WorkingFolder {
  if (folder.id === id) return { ...folder, ...patch };
  return { ...folder, children: updateChildren(folder.children, (node) => node.type === "folder" ? updateTreeNode(node, id, patch) : node) };
}

function updateTreeNode(node: WorkingTreeFolder, id: string, patch: WorkingFolderPatch): WorkingTreeFolder {
  if (node.id === id) return { ...node, ...patch };
  return { ...node, children: updateChildren(node.children, (child) => child.type === "folder" ? updateTreeNode(child, id, patch) : child) };
}

function deleteFromTree(nodes: WorkingTreeNode[] | undefined, id: string): WorkingTreeNode[] | undefined {
  if (!nodes) return nodes;
  return nodes.filter((node) => node.id !== id).map((node) => node.type === "folder" ? { ...node, children: deleteFromTree(node.children, id) } : node);
}

function updateChildren(nodes: WorkingTreeNode[] | undefined, update: (node: WorkingTreeNode) => WorkingTreeNode): WorkingTreeNode[] | undefined {
  return nodes?.map(update);
}
