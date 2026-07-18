import os from "node:os";
import path from "node:path";

/**
 * How much of the filesystem agents may reach.
 *
 * - `full`    — the whole disk. The default: YAAA is a local tool driving the
 *               user's own machine, and confining agents to the task workspace
 *               made ordinary requests ("summarise ~/Documents/report.pdf")
 *               fail as permission errors.
 * - `home`    — the user's home directory only.
 * - `workspace` — the task workspace only (the original, strictest behaviour).
 */
export type FileAccessMode = "full" | "home" | "workspace";

const MODES: FileAccessMode[] = ["full", "home", "workspace"];

/** The filesystem root, which is `/` on posix and the drive root on Windows. */
export function filesystemRoot(): string {
  return path.parse(os.homedir()).root;
}

/** Read the configured access mode, defaulting to full disk access. */
export function resolveFileAccessMode(env: NodeJS.ProcessEnv = process.env): FileAccessMode {
  const raw = (env.YAAA_FILE_ACCESS || "").trim().toLowerCase();
  return (MODES as string[]).includes(raw) ? (raw as FileAccessMode) : "full";
}

/**
 * The absolute roots an agent may read and write, outside its task workspace.
 *
 * `YAAA_FILE_ROOTS` (path-separator delimited) overrides the mode entirely, so a
 * deployment can pin access to specific directories. Relative entries are
 * ignored rather than silently resolved against an arbitrary cwd.
 */
export function resolveFileRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = (env.YAAA_FILE_ROOTS || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => path.isAbsolute(entry))
    .map((entry) => path.resolve(entry));
  if (configured.length > 0) return dedupeRoots(configured);

  switch (resolveFileAccessMode(env)) {
    case "workspace":
      return [];
    case "home":
      return [path.resolve(os.homedir())];
    default:
      return [filesystemRoot()];
  }
}

/** Drop roots already contained by another root, so checks stay cheap. */
function dedupeRoots(roots: string[]): string[] {
  return roots.filter(
    (root, index) =>
      !roots.some((other, otherIndex) => otherIndex !== index && other !== root && isWithinRoot(root, other)),
  );
}

/**
 * True when `targetPath` is inside `root` (or is the root itself). Both are
 * expected to be absolute and already resolved.
 */
export function isWithinRoot(targetPath: string, root: string): boolean {
  const relative = path.relative(root, targetPath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** True when `targetPath` falls inside any of `roots`. */
export function isWithinAnyRoot(targetPath: string, roots: string[]): boolean {
  return roots.some((root) => isWithinRoot(targetPath, root));
}
