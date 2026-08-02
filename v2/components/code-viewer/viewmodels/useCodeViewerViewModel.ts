import { useMemo, useState } from "react";

export function useCodeViewerViewModel(content: string, previewLines = 12) {
  const [expanded, setExpanded] = useState(false);
  const [wrapped, setWrapped] = useState(true);
  const isPartial = content.split("\n").length > previewLines;
  const preview = useMemo(() => isPartial ? `${content.split("\n").slice(0, previewLines).join("\n")}\n…` : content, [content, isPartial, previewLines]);
  return { expanded, wrapped, isPartial, preview, open: () => setExpanded(true), close: () => setExpanded(false), toggleWrap: () => setWrapped((value) => !value) };
}
