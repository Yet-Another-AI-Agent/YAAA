import { FileKind, type FileKind as FileKindType } from "../enums/file.enums";
import type { SpecialFile } from "../interfaces/file.interfaces";

export function inferFileKind(name: string, mimeType = ""): FileKindType {
  if (mimeType.startsWith("image/")) return FileKind.Image;
  if (mimeType === "application/pdf" || /\.pdf$/i.test(name)) return FileKind.Pdf;
  if (/\.(ppt|pptx)$/i.test(name)) return FileKind.Ppt;
  if (/\.(doc|docx)$/i.test(name)) return FileKind.Word;
  if (/\.(md|markdown)$/i.test(name)) return FileKind.Markdown;
  return FileKind.Code;
}

export function fileKindLabel(kind: FileKindType): string {
  return ({ image: "Image", pdf: "PDF", ppt: "PowerPoint", word: "Word", markdown: "Markdown", code: "Code" } as Record<FileKindType, string>)[kind];
}

export function fileKindIcon(kind: FileKindType): string {
  return ({ image: "▧", pdf: "PDF", ppt: "PPT", word: "W", markdown: "M↓", code: "<>" } as Record<FileKindType, string>)[kind];
}

export function formatFileSize(size?: number): string {
  if (size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function createSpecialFile(name: string, options: Omit<SpecialFile, "name"> = { kind: inferFileKind(name) }): SpecialFile {
  return { name, ...options };
}
