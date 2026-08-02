import React from "react";
import type { CodeDiffViewerProps } from "./interfaces/code-viewer.interfaces";
import "./code-viewer.css";

export function CodeDiffViewer({ before, after, language = "text", title = "Code diff" }: CodeDiffViewerProps) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const renderLines = (lines: string[], prefix: "−" | "+", className: "v2-code-removed" | "v2-code-added") => <pre><code>{lines.map((line, index) => <span className="v2-code-diff-row" key={`${index}-${line}`}><span className="v2-code-line-number">{index + 1}</span><span className={className}>{`${prefix} ${line || " "}`}</span></span>)}</code></pre>;
  return <section className="v2-code-diff" aria-label={title}><header><strong>{title}</strong><span>{language}</span></header><div className="v2-code-diff-sections"><section className="v2-code-diff-section v2-code-diff-before" aria-label="Removed code"><h3>Before</h3>{renderLines(beforeLines, "−", "v2-code-removed")}</section><section className="v2-code-diff-section v2-code-diff-after" aria-label="Added code"><h3>After</h3>{renderLines(afterLines, "+", "v2-code-added")}</section></div></section>;
}
