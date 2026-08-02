import React, { useState } from "react";
import { Button, SecondaryButton } from "../buttons/Button";
import type { CodeViewerProps } from "./interfaces/code-viewer.interfaces";
import { useCodeViewerViewModel } from "./viewmodels/useCodeViewerViewModel";
import "./code-viewer.css";

function CodeBlock({ content, wrapped, diffClass = "" }: { content: string; wrapped: boolean; diffClass?: string }) {
  return <pre className={`v2-code-block ${wrapped ? "is-wrapped" : ""} ${diffClass}`}><code>{content.split("\n").map((line, index) => <span className="v2-code-line" key={`${index}-${line}`}><span className="v2-code-line-number">{index + 1}</span><span>{line || " "}</span></span>)}</code></pre>;
}

export function CodeViewer({ content, language = "text", title = "Code", previewLines, className = "" }: CodeViewerProps) {
  const viewModel = useCodeViewerViewModel(content, previewLines);
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard?.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 1000); } catch { setCopied(false); } };
  const body = (expanded: boolean) => <><div className="v2-code-toolbar"><span>{language}</span><span className="v2-code-toolbar-spacer" /><SecondaryButton onClick={viewModel.toggleWrap}>{viewModel.wrapped ? "No wrap" : "Wrap"}</SecondaryButton><SecondaryButton onClick={copy}>{copied ? "Copied" : "Copy"}</SecondaryButton></div><CodeBlock content={expanded ? content : viewModel.preview} wrapped={viewModel.wrapped} /></>;
  return <div className={`v2-code-viewer ${className}`}><div className="v2-code-heading"><strong>{title}</strong>{viewModel.isPartial && <Button variant="primary" onClick={viewModel.open}>Open full</Button>}</div>{body(false)}{viewModel.expanded && <div className="v2-code-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) viewModel.close(); }}><section className="v2-code-panel" role="dialog" aria-label={title}><header><strong>{title}</strong><button type="button" aria-label="Close code viewer" onClick={viewModel.close}>×</button></header><div className="v2-code-scroll">{body(true)}</div></section></div>}</div>;
}
