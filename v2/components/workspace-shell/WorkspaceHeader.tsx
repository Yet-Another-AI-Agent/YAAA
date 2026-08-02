import React from "react";

export interface WorkspaceHeaderProps {
  title: string;
  leftVisible: boolean;
  sidePanelVisible: boolean;
  onBack: () => void;
  onToggleLeft: () => void;
  onToggleSidePanel: () => void;
}

export function WorkspaceHeader({ title, leftVisible, sidePanelVisible, onBack, onToggleLeft, onToggleSidePanel }: WorkspaceHeaderProps) {
  return <header className="v2-workspace-header"><button type="button" aria-label="Back to home" onClick={onBack}>‹</button><button type="button" aria-label="Toggle left pane" aria-pressed={leftVisible} onClick={onToggleLeft}>☰</button><h1>{title}</h1><button type="button" aria-label="Toggle side panel" aria-pressed={sidePanelVisible} onClick={onToggleSidePanel}>▤</button></header>;
}
