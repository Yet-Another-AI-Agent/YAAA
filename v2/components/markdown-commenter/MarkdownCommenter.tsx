import React from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { MarkdownCommenterProps } from "./interfaces/markdown-commenter.interfaces";
import { useMarkdownCommenterViewModel } from "./viewmodels/useMarkdownCommenterViewModel";
import "./markdown-commenter.css";

export function MarkdownCommenter({ content, title = "Review document", initialComments, onCommentsChange }: MarkdownCommenterProps) {
  const viewModel = useMarkdownCommenterViewModel(initialComments, onCommentsChange);
  const lines = content.split("\n");
  return <section className="v2-markdown-commenter" aria-label={title}><header><strong>{title}</strong><small>{viewModel.comments.length} comment{viewModel.comments.length === 1 ? "" : "s"}</small></header><div className="v2-markdown-commenter-scroll">{lines.map((line, index) => { const lineNumber = index + 1; const comment = viewModel.commentForLine(lineNumber); return <div className={`v2-markdown-comment-line ${comment ? "has-comment" : ""}`} key={lineNumber}><button type="button" className="v2-markdown-comment-line-body" onClick={() => viewModel.setActiveLine(lineNumber)} aria-label={`Comment on line ${lineNumber}`}><span className="v2-markdown-comment-line-number">{lineNumber}</span><span className="v2-markdown-comment-line-content"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{line || " "}</ReactMarkdown></span></button>{comment && <div className="v2-markdown-comment-marker">Comment: {comment.comment}</div>}{viewModel.activeLine === lineNumber && <div className="v2-markdown-comment-composer"><textarea aria-label={`Comment for line ${lineNumber}`} value={viewModel.draft} onChange={(event) => viewModel.setDraft(event.target.value)} placeholder="Add a comment..." /><button type="button" onClick={() => viewModel.addComment(lineNumber, line)}>Save comment</button><button type="button" onClick={() => viewModel.setActiveLine(undefined)}>Cancel</button></div>}</div>; })}</div></section>;
}
