import { useCallback, useState } from "react";
import { addSidePanelContent, addSidePanelTab, deleteSidePanelContent, deleteSidePanelTab, initSidePanelTabs, updateSidePanelContent, updateSidePanelTab } from "../library/side-panel-library";
import type { SidePanelContent, SidePanelContentPatch, SidePanelTab, SidePanelTabPatch } from "../interfaces/side-panel.interfaces";

export function useSidePanelViewModel(initialTabs: SidePanelTab[], initialActiveTabId?: string) {
  const [tabs, setTabs] = useState(() => initSidePanelTabs(initialTabs));
  const [activeTabId, setActiveTabId] = useState(initialActiveTabId ?? initialTabs[0]?.id ?? "");
  const initTabs = useCallback((next: SidePanelTab[]) => { setTabs(initSidePanelTabs(next)); setActiveTabId(next[0]?.id ?? ""); }, []);
  const addTab = useCallback((tab: SidePanelTab, activate = true) => { setTabs((current) => addSidePanelTab(current, tab)); if (activate) setActiveTabId(tab.id); }, []);
  const updateTab = useCallback((id: string, patch: SidePanelTabPatch) => setTabs((current) => updateSidePanelTab(current, id, patch)), []);
  const deleteTab = useCallback((id: string) => { setTabs((current) => deleteSidePanelTab(current, id)); setActiveTabId((current) => current === id ? "" : current); }, []);
  const activateTab = useCallback((id: string) => setActiveTabId(id), []);
  const addContent = useCallback((tabId: string, content: SidePanelContent) => setTabs((current) => addSidePanelContent(current, tabId, content)), []);
  const updateContent = useCallback((tabId: string, contentId: string, patch: SidePanelContentPatch) => setTabs((current) => updateSidePanelContent(current, tabId, contentId, patch)), []);
  const deleteContent = useCallback((tabId: string, contentId: string) => setTabs((current) => deleteSidePanelContent(current, tabId, contentId)), []);
  return { tabs, activeTabId, setActiveTabId, initTabs, addTab, updateTab, deleteTab, activateTab, addContent, updateContent, deleteContent };
}

