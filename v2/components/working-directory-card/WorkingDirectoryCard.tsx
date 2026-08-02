import React, { forwardRef, useImperativeHandle } from "react";
import type { WorkingDirectoryCardHandle, WorkingDirectoryCardProps, WorkingFile, WorkingFolder, WorkingTreeNode } from "./interfaces/working-directory-card.interfaces";
import { useWorkingDirectoryCardViewModel } from "./viewmodels/useWorkingDirectoryCardViewModel";
import { Tabs } from "../tabs/Tabs";
import "./working-directory-card.css";
import "./working-directory-card-interactions.css";

export const WorkingDirectoryCard = forwardRef<WorkingDirectoryCardHandle, WorkingDirectoryCardProps>(function WorkingDirectoryCard(
  { initialFolders = [], pageSize = 5, className = "", onOpenFolder, onOpenFile, onEvent, openFolder }, ref,
) {
  const viewModel = useWorkingDirectoryCardViewModel(initialFolders, Math.max(1, pageSize));
  useImperativeHandle(ref, () => ({ init: viewModel.init, addFolder: viewModel.addFolder, updateFolder: viewModel.updateFolder, deleteFolder: viewModel.deleteFolder }), [viewModel.addFolder, viewModel.deleteFolder, viewModel.init, viewModel.updateFolder]);

  const [tab, setTab] = React.useState<"working" | "agent-space">("working");
  const [workingPage, setWorkingPage] = React.useState(0);
  const workingFolder = viewModel.agentSpaceFolders[0];
  const workingRootEntries = workingFolder ? folderChildren(workingFolder) : [];
  const workingPageCount = Math.max(1, Math.ceil(workingRootEntries.length / Math.max(1, pageSize)));
  const workingCurrentPage = Math.min(workingPage, workingPageCount - 1);
  const pagedWorkingRootEntries = workingRootEntries.slice(workingCurrentPage * Math.max(1, pageSize), (workingCurrentPage + 1) * Math.max(1, pageSize));
  const activePage = tab === "working" ? workingCurrentPage : viewModel.page;
  const activePageCount = tab === "working" ? workingPageCount : viewModel.pageCount;
  const changeTab = (nextTab: "working" | "agent-space") => { setTab(nextTab); setWorkingPage(0); viewModel.setPage(0); };
  const handleOpen = (folder: WorkingFolder) => {
    onOpenFolder?.(folder);
    void (openFolder ? openFolder(folder) : openFolderInElectron(folder));
  };

  return <aside className={`v2-working-directory-card ${className}`} aria-label="Working directories">
    <header className="v2-working-directory-header"><div><strong>Working directory</strong><small>{viewModel.folders.length} folder{viewModel.folders.length === 1 ? "" : "s"}</small></div><span className="v2-working-directory-live"><i /> Workspace</span></header>
    <Tabs<"working" | "agent-space"> value={tab} onChange={changeTab} ariaLabel="Working directory views" tabs={[{ id: "working", label: "Working folder", count: workingRootEntries.length }, { id: "agent-space", label: "Agent Space", count: viewModel.agentWorkingFolders.length }]} />
    {tab === "working" ? <section className="v2-working-directory-section" aria-labelledby="v2-working-folder-title"><div className="v2-working-directory-section-title" id="v2-working-folder-title">Mission files and folders</div>{viewModel.agentSpaceFolders.length === 0 ? <Empty label="No mission working folder." /> : viewModel.agentSpaceFolders.map((folder, index) => <FolderRow key={folder.id} folder={folder} displayRoot={viewModel.commonPath} visibleChildren={index === 0 ? pagedWorkingRootEntries : undefined} onOpen={handleOpen} onOpenFile={onOpenFile} onEvent={onEvent} expandable />)}</section> : <section className="v2-working-directory-section" aria-labelledby="v2-agent-working-title"><div className="v2-working-directory-section-title" id="v2-agent-working-title">Private agent files</div>{viewModel.pagedWorkingFolders.length === 0 ? <Empty label="No agent private folders." /> : viewModel.pagedWorkingFolders.map((folder) => <FolderRow key={folder.id} folder={folder} displayRoot={viewModel.commonPath} onOpen={handleOpen} onOpenFile={onOpenFile} onEvent={onEvent} expandable />)}</section>}
    {activePageCount > 1 && <nav className="v2-working-directory-pagination" aria-label="Working folder pagination"><button type="button" aria-label="Previous folders" disabled={activePage === 0} onClick={() => tab === "working" ? setWorkingPage(activePage - 1) : viewModel.setPage(activePage - 1)}>‹</button><span>Page {activePage + 1} of {activePageCount}</span><button type="button" aria-label="Next folders" disabled={activePage >= activePageCount - 1} onClick={() => tab === "working" ? setWorkingPage(activePage + 1) : viewModel.setPage(activePage + 1)}>›</button></nav>}
  </aside>;
});

function folderChildren(folder: WorkingFolder): WorkingTreeNode[] { return folder.children ?? (folder.files ?? []).map((file) => ({ ...file, type: "file" as const })); }

function FolderRow({ folder, displayRoot, visibleChildren, onOpen, onOpenFile, onEvent, expandable = false }: { folder: WorkingFolder; displayRoot?: string; visibleChildren?: WorkingTreeNode[]; onOpen: (folder: WorkingFolder) => void; onOpenFile?: (file: WorkingFile, fullPath: string, folder: WorkingFolder) => void; onEvent?: WorkingDirectoryCardProps["onEvent"]; expandable?: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  const children = visibleChildren ?? folderChildren(folder);
  return <div className="v2-working-folder-group"><div className="v2-working-folder-row-wrap"><button type="button" className="v2-working-folder-row" onClick={() => onOpen(folder)} aria-label={`Open ${folder.name}`}><span className="v2-working-folder-icon">⌁</span><span className="v2-working-folder-content"><strong>{folder.name}</strong><small>{folder.agentName ? `${folder.agentName} · ` : ""}{displayRoot ?? folder.path}</small></span>{typeof folder.itemCount === "number" && <span className="v2-working-folder-count">{folder.itemCount}</span>}</button>{expandable && children.length > 0 && <button type="button" className="v2-working-folder-expand" aria-label={`${expanded ? "Collapse" : "Expand"} files in ${folder.name}`} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "⌃" : "⌄"}</button>}</div>{expanded && <div className="v2-working-file-list">{children.map((node) => <TreeNode node={node} depth={0} parentPath={folder.path} folder={folder} onOpenFile={onOpenFile} onEvent={onEvent} key={node.id} />)}</div>}</div>;
}

function TreeNode({ node, depth, parentPath, folder, onOpenFile, onEvent }: { node: WorkingTreeNode; depth: number; parentPath: string; folder: WorkingFolder; onOpenFile?: (file: WorkingFile, fullPath: string, folder: WorkingFolder) => void; onEvent?: WorkingDirectoryCardProps["onEvent"] }) {
  const [expanded, setExpanded] = React.useState(false);
  if (node.type === "file") { const fullPath = resolvePath(parentPath, node.path ?? node.name); const emitFileOpen = () => { onEvent?.({ kind: "file-open", action: "open", fileName: node.name, path: fullPath, file: node, folder }); onOpenFile?.(node, fullPath, folder); }; return <button type="button" className="v2-working-file-row" style={{ "--tree-depth": depth } as React.CSSProperties} onClick={emitFileOpen}><span>⌑</span><span>{node.name}</span>{node.change && <small className={`v2-working-file-change v2-working-file-change-${node.change}`}>{node.change}</small>}</button>; }
  const nodePath = resolvePath(parentPath, node.path);
  return <div className="v2-working-tree-node" style={{ "--tree-depth": depth } as React.CSSProperties}><button type="button" className="v2-working-tree-row" aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} folder ${node.name}`} onClick={() => setExpanded((value) => !value)}><span className="v2-working-tree-chevron">{expanded ? "⌃" : "⌄"}</span><span className="v2-working-tree-icon">⌁</span><span>{node.name}</span></button>{expanded && (node.children ?? []).map((child) => <TreeNode node={child} depth={depth + 1} parentPath={nodePath} folder={folder} onOpenFile={onOpenFile} onEvent={onEvent} key={child.id} />)}</div>;
}

function resolvePath(parent: string, child: string) { const normalizedChild = child.replaceAll("\\", "/"); if (normalizedChild.startsWith("/") || /^[A-Za-z]:\//.test(normalizedChild)) return normalizedChild; return `${parent.replace(/\/$/, "")}/${normalizedChild.replace(/^\//, "")}`; }

function Empty({ label }: { label: string }) { return <div className="v2-working-directory-empty">{label}</div>; }

async function openFolderInElectron(folder: WorkingFolder) {
  const api = (globalThis as typeof globalThis & { electronAPI?: { openWorkingFolder?: (taskId: string) => Promise<boolean>; openAgentWorkspace?: (taskId: string, agentId: string) => Promise<boolean> } }).electronAPI;
  if (!api || !folder.taskId) return;
  if (folder.kind === "agent-working" && folder.agentId && api.openAgentWorkspace) await api.openAgentWorkspace(folder.taskId, folder.agentId);
  else if (folder.kind === "agent-space" && api.openWorkingFolder) await api.openWorkingFolder(folder.taskId);
}
