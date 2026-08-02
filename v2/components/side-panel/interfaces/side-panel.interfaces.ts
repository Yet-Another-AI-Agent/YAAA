import type { ReactNode } from "react";

export interface SidePanelContent {
  id: string;
  title?: string;
  content: ReactNode;
}

export interface SidePanelTab {
  id: string;
  title: string;
  closable?: boolean;
  content?: SidePanelContent[];
}

export type SidePanelTabPatch = Partial<Omit<SidePanelTab, "id">>;
export type SidePanelContentPatch = Partial<Omit<SidePanelContent, "id">>;

export interface SidePanelHandle {
  initTabs: (tabs: SidePanelTab[]) => void;
  addTab: (tab: SidePanelTab, activate?: boolean) => void;
  updateTab: (id: string, patch: SidePanelTabPatch) => void;
  deleteTab: (id: string) => void;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  addContent: (tabId: string, content: SidePanelContent) => void;
  updateContent: (tabId: string, contentId: string, patch: SidePanelContentPatch) => void;
  editContent: (tabId: string, contentId: string, patch: SidePanelContentPatch) => void;
  deleteContent: (tabId: string, contentId: string) => void;
}

export interface SidePanelProps {
  initialTabs?: SidePanelTab[];
  initialActiveTabId?: string;
  className?: string;
  onEvent?: (event: SidePanelEvent) => void;
}

export type SidePanelEvent =
  | { kind: "tab-add" | "tab-update" | "tab-delete" | "tab-close" | "tab-change"; tabId: string; tab?: SidePanelTab }
  | { kind: "content-add" | "content-update" | "content-delete"; tabId: string; contentId: string; content?: SidePanelContent };

