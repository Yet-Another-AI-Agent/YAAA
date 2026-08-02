export interface CodeViewerProps {
  content: string;
  language?: string;
  title?: string;
  previewLines?: number;
  className?: string;
}

export interface CodeDiffViewerProps {
  before: string;
  after: string;
  language?: string;
  title?: string;
}

export interface VsCodeDiffViewerProps {
  oldCode: string;
  newCode: string;
  language?: string;
  title?: string;
  theme?: "auto" | "vs-dark" | "light";
  previewHeight?: string | number;
  expandedHeight?: string | number;
  className?: string;
}
