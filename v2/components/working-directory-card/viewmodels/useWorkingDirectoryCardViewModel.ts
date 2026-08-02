import { useCallback, useMemo, useState } from "react";
import { addWorkingFolder, deleteWorkingFolder, getCommonWorkingPath, initWorkingFolders, updateWorkingFolder } from "../library/working-directory-card-library";
import type { WorkingFolder, WorkingFolderPatch } from "../interfaces/working-directory-card.interfaces";

export function useWorkingDirectoryCardViewModel(initialFolders: WorkingFolder[], pageSize: number) {
  const [folders, setFolders] = useState(() => initWorkingFolders(initialFolders));
  const [page, setPage] = useState(0);
  const agentSpaceFolders = useMemo(() => folders.filter((folder) => folder.kind === "agent-space"), [folders]);
  const agentWorkingFolders = useMemo(() => folders.filter((folder) => folder.kind === "agent-working"), [folders]);
  const pageCount = Math.max(1, Math.ceil(agentWorkingFolders.length / pageSize));
  const commonPath = useMemo(() => getCommonWorkingPath(folders), [folders]);
  const currentPage = Math.min(page, pageCount - 1);
  const pagedWorkingFolders = agentWorkingFolders.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  const init = useCallback((next: WorkingFolder[]) => { setFolders(initWorkingFolders(next)); setPage(0); }, []);
  const addFolder = useCallback((folder: WorkingFolder, parentId?: string) => setFolders((current) => addWorkingFolder(current, folder, parentId)), []);
  const updateFolder = useCallback((id: string, patch: WorkingFolderPatch) => setFolders((current) => updateWorkingFolder(current, id, patch)), []);
  const deleteFolder = useCallback((id: string) => setFolders((current) => deleteWorkingFolder(current, id)), []);

  return { folders, agentSpaceFolders, agentWorkingFolders, pagedWorkingFolders, commonPath, page: currentPage, pageCount, setPage, init, addFolder, updateFolder, deleteFolder };
}
