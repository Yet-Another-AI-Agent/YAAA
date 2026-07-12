import type { UIArtifact } from "../models/TaskModel";

export type ArtifactGroupId = "plans" | "handoffs" | "media" | "files";
export type ArtifactMediaKind = "image" | "video" | "audio";
export type ArtifactHandoffKind = "hands-on" | "hands-off";

export interface ArtifactExplorerEntry extends UIArtifact {
  normalizedPath: string;
  name: string;
  directorySegments: string[];
  depth: number;
  groupId: ArtifactGroupId;
  mediaKind?: ArtifactMediaKind;
  handoffKind?: ArtifactHandoffKind;
  typeLabel: string;
}

export interface ArtifactExplorerGroup {
  id: ArtifactGroupId;
  label: string;
  entries: ArtifactExplorerEntry[];
}

const GROUP_LABELS: Record<ArtifactGroupId, string> = {
  plans: "Plans",
  handoffs: "Agent handoffs",
  media: "Generated media",
  files: "Documents & files",
};

const MEDIA_EXTENSIONS: Record<ArtifactMediaKind, Set<string>> = {
  image: new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]),
  video: new Set(["mp4", "webm", "mov", "m4v", "avi"]),
  audio: new Set(["mp3", "wav", "m4a", "ogg", "flac", "aac"]),
};

function normalizePath(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\\+/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== ".")
    .join("/");
}

function getExtension(name: string): string {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

function getMediaKind(mimeType: string, extension: string): ArtifactMediaKind | undefined {
  const mimeFamily = mimeType.toLowerCase().split("/")[0];
  if (mimeFamily === "image" || mimeFamily === "video" || mimeFamily === "audio") {
    return mimeFamily;
  }
  return (Object.keys(MEDIA_EXTENSIONS) as ArtifactMediaKind[]).find((kind) =>
    MEDIA_EXTENSIONS[kind].has(extension),
  );
}

function getHandoffKind(name: string): ArtifactHandoffKind | undefined {
  const stem = name
    .replace(/\.[^.]+$/, "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s_-]+/g, "_")
    .toUpperCase();
  if (stem === "HANDS_ON") return "hands-on";
  if (stem === "HANDS_OFF") return "hands-off";
  if (stem === "HAND_OFF") return "hands-off";
  return undefined;
}

function isPlanArtifact(name: string, description: string): boolean {
  const searchable = `${name.replace(/\.[^.]+$/, "")} ${description}`;
  return /(?:^|[\s_-])(?:(?:implementation|execution|master|task)[\s_-]*)?(?:plan|blueprint)(?=$|[\s_.-])/i.test(
    searchable,
  );
}

function getTypeLabel(
  extension: string,
  groupId: ArtifactGroupId,
  mediaKind?: ArtifactMediaKind,
  handoffKind?: ArtifactHandoffKind,
): string {
  if (handoffKind === "hands-on") return "HANDS ON";
  if (handoffKind === "hands-off") return "HANDS OFF";
  if (groupId === "plans") return "Plan";
  if (mediaKind) return mediaKind[0].toUpperCase() + mediaKind.slice(1);
  return extension ? extension.toUpperCase() : "File";
}

export function buildArtifactExplorer(artifacts: UIArtifact[]): ArtifactExplorerGroup[] {
  const entriesByPath = new Map<string, ArtifactExplorerEntry>();

  artifacts.forEach((artifact, index) => {
    const normalizedPath = normalizePath(artifact.path) || `untitled-artifact-${index + 1}`;
    const segments = normalizedPath.split("/");
    const name = segments.at(-1) || normalizedPath;
    const directorySegments = segments.slice(0, -1);
    const extension = getExtension(name);
    const mimeType = String(artifact.mimeType || "application/octet-stream");
    const description = String(artifact.description || "");
    const handoffKind = getHandoffKind(name);
    const mediaKind = getMediaKind(mimeType, extension);
    const groupId: ArtifactGroupId = handoffKind
      ? "handoffs"
      : isPlanArtifact(name, description)
        ? "plans"
        : mediaKind
          ? "media"
          : "files";

    // Result messages can repeat the same artifact. Keep one tree node and use
    // the latest non-empty metadata while retaining the original usable path.
    const previous = entriesByPath.get(normalizedPath);
    entriesByPath.set(normalizedPath, {
      path: artifact.path || previous?.path || normalizedPath,
      mimeType: artifact.mimeType || previous?.mimeType || mimeType,
      description: artifact.description || previous?.description || "Generated artifact",
      normalizedPath,
      name,
      directorySegments,
      depth: directorySegments.length,
      groupId,
      mediaKind,
      handoffKind,
      typeLabel: getTypeLabel(extension, groupId, mediaKind, handoffKind),
    });
  });

  const entries = [...entriesByPath.values()].sort((left, right) =>
    left.normalizedPath.localeCompare(right.normalizedPath),
  );
  return (Object.keys(GROUP_LABELS) as ArtifactGroupId[])
    .map((id) => ({
      id,
      label: GROUP_LABELS[id],
      entries: entries.filter((entry) => entry.groupId === id),
    }))
    .filter((group) => group.entries.length > 0);
}
