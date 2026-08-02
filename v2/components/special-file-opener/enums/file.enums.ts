export const FileKind = {
  Image: "image",
  Pdf: "pdf",
  Ppt: "ppt",
  Word: "word",
  Markdown: "markdown",
  Code: "code",
} as const;

export type FileKind = typeof FileKind[keyof typeof FileKind];
