import React, { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { VsCodeDiffViewerProps } from "./interfaces/code-viewer.interfaces";

/**
 * VS Code-style inline diff. Monaco keeps unchanged context between changed
 * regions and renders removed/added lines in red/green in one scroll surface.
 */
export function VsCodeDiffViewer({ oldCode, newCode, language = "plaintext", title = "Code diff", theme = "auto", previewHeight = "260px", expandedHeight = "78vh", className = "" }: VsCodeDiffViewerProps) {
  const [expanded, setExpanded] = useState(false);
  const [globalTheme, setGlobalTheme] = useState(() => readGlobalTheme());
  useEffect(() => {
    if (theme !== "auto" || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => setGlobalTheme(readGlobalTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [theme]);
  const resolvedTheme = theme === "auto" ? globalTheme : theme;
  const editor = (height: string | number) => <DiffEditor
    height={height}
    language={language}
    original={oldCode}
    modified={newCode}
    theme={resolvedTheme}
    options={{
      automaticLayout: true,
      diffAlgorithm: "advanced",
      hideUnchangedRegions: { enabled: false },
      minimap: { enabled: false },
      originalEditable: false,
      readOnly: true,
      renderOverviewRuler: false,
      renderSideBySide: false,
      scrollBeyondLastLine: false,
      wordWrap: "on",
    }}
  />;
  return <section className={`v2-vscode-diff ${className}`} aria-label={title}>
    <div className="v2-vscode-diff-heading"><strong>{title}</strong><span>{language}</span></div>
    <div className="v2-vscode-diff-preview">{editor(previewHeight)}<button type="button" className="v2-vscode-diff-open" onClick={() => setExpanded(true)}>Open full</button></div>
    {expanded && <div className="v2-vscode-diff-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setExpanded(false); }}><section className="v2-vscode-diff-panel" role="dialog" aria-label={title}><header><strong>{title}</strong><button type="button" aria-label="Close code diff" onClick={() => setExpanded(false)}>×</button></header><div className="v2-vscode-diff-scroll">{editor(expandedHeight)}</div></section></div>}
  </section>;
}

function readGlobalTheme(): "vs-dark" | "light" {
  return typeof document !== "undefined" && document.documentElement.classList.contains("chat-v2-dark") ? "vs-dark" : "light";
}
