import type { SidePanelContent, SidePanelContentPatch, SidePanelTab, SidePanelTabPatch } from "../interfaces/side-panel.interfaces";

export function initSidePanelTabs(tabs: SidePanelTab[] = []) { return tabs.map(cloneTab); }
export function addSidePanelTab(tabs: SidePanelTab[], tab: SidePanelTab) { return [...tabs.filter((item) => item.id !== tab.id), cloneTab(tab)]; }
export function updateSidePanelTab(tabs: SidePanelTab[], id: string, patch: SidePanelTabPatch) { return tabs.map((tab) => tab.id === id ? { ...tab, ...patch } : tab); }
export function deleteSidePanelTab(tabs: SidePanelTab[], id: string) { return tabs.filter((tab) => tab.id !== id); }
export function addSidePanelContent(tabs: SidePanelTab[], tabId: string, content: SidePanelContent) { return tabs.map((tab) => tab.id === tabId ? { ...tab, content: [...(tab.content ?? []).filter((item) => item.id !== content.id), content] } : tab); }
export function updateSidePanelContent(tabs: SidePanelTab[], tabId: string, contentId: string, patch: SidePanelContentPatch) { return tabs.map((tab) => tab.id === tabId ? { ...tab, content: (tab.content ?? []).map((item) => item.id === contentId ? { ...item, ...patch } : item) } : tab); }
export function deleteSidePanelContent(tabs: SidePanelTab[], tabId: string, contentId: string) { return tabs.map((tab) => tab.id === tabId ? { ...tab, content: (tab.content ?? []).filter((item) => item.id !== contentId) } : tab); }
function cloneTab(tab: SidePanelTab): SidePanelTab { return { ...tab, content: tab.content?.map((item) => ({ ...item })) }; }

