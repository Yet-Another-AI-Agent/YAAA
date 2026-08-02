import { useMemo, useState } from "react";

export function useMarkdownViewerViewModel(content: string, previewLength = 420) {
  const [expanded, setExpanded] = useState(false);
  const isPartial = useMemo(() => content.length > previewLength || content.split("\n").length > 12, [content, previewLength]);
  const preview = isPartial ? `${content.slice(0, previewLength).trimEnd()}…` : content;
  return { expanded, isPartial, preview, open: () => setExpanded(true), close: () => setExpanded(false) };
}
