import { useState } from "react";
import type { MarkdownLineComment } from "../interfaces/markdown-commenter.interfaces";

export function useMarkdownCommenterViewModel(initialComments: MarkdownLineComment[] = [], onCommentsChange?: (comments: MarkdownLineComment[]) => void) {
  const [comments, setComments] = useState(initialComments);
  const [activeLine, setActiveLine] = useState<number>();
  const [draft, setDraft] = useState("");
  const addComment = (line: number, quote: string) => {
    if (!draft.trim()) return;
    const next = [...comments.filter((comment) => comment.line !== line), { line, quote, comment: draft.trim() }].sort((a, b) => a.line - b.line);
    setComments(next); onCommentsChange?.(next); setDraft(""); setActiveLine(undefined);
  };
  return { comments, activeLine, draft, setActiveLine, setDraft, addComment, commentForLine: (line: number) => comments.find((comment) => comment.line === line) };
}
