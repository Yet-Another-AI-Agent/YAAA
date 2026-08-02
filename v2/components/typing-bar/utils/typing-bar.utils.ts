import type { AttachmentKind } from "../enums/typing-bar.enums";
import type { TypingAttachment } from "../interfaces/typing-bar.interfaces";
import { createTypingBarId } from "./ids";

export function attachmentKindForMime(mimeType: string, selectedKind: AttachmentKind): AttachmentKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return selectedKind;
}

export function createTypingAttachment(file: File | Blob, selectedKind: AttachmentKind, name = "attachment"): TypingAttachment {
  const mimeType = file.type || "application/octet-stream";
  return { id: createTypingBarId(), name, kind: attachmentKindForMime(mimeType, selectedKind), mimeType, size: file.size, file };
}

export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function nextListPrefix(line: string): string | undefined {
  const match = line.match(/^(\s*)([-*]|\d+[.)])\s+/);
  if (!match) return undefined;
  const indent = match[1];
  const marker = match[2];
  if (/^\d/.test(marker)) return `${indent}${Number.parseInt(marker, 10) + 1}. `;
  return `${indent}${marker} `;
}
