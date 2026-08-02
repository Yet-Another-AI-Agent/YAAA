export const ModelTier = {
  Base: "base",
  Mid: "mid",
  StateOfArt: "state-of-art",
} as const;
export type ModelTier = typeof ModelTier[keyof typeof ModelTier];

export const AttachmentKind = {
  File: "file",
  Folder: "folder",
  Image: "image",
  Video: "video",
  Audio: "audio",
} as const;
export type AttachmentKind = typeof AttachmentKind[keyof typeof AttachmentKind];
