import React from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { MarkdownViewerProps } from "./interfaces/markdown-viewer.interfaces";
import { useMarkdownViewerViewModel } from "./viewmodels/useMarkdownViewerViewModel";
import "./markdown-viewer.css";

function MarkdownContent({ content }: { content: string }) {
  return <div className="v2-markdown-rendered"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{content}</ReactMarkdown></div>;
}

export function MarkdownViewer({ content, title = "Markdown document", previewLength, className = "" }: MarkdownViewerProps) {
  const viewModel = useMarkdownViewerViewModel(content, previewLength);
  return <div className={`v2-markdown-viewer ${className}`}>
    {viewModel.isPartial ? <button type="button" className="v2-markdown-preview" onClick={viewModel.open} aria-label={`Open ${title}`}><MarkdownContent content={viewModel.preview} /><span className="v2-markdown-preview-hint">Click to open complete document</span></button> : <MarkdownContent content={content} />}
    {viewModel.expanded && <div className="v2-markdown-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) viewModel.close(); }}><section className="v2-markdown-panel" role="dialog" aria-label={title}><header><strong>{title}</strong><button type="button" aria-label="Close markdown viewer" onClick={viewModel.close}>×</button></header><div className="v2-markdown-scroll"><MarkdownContent content={content} /></div></section></div>}
  </div>;
}
