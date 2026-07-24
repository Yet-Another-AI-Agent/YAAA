import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import fg from "fast-glob";
import type { DownloadFileOptions, DownloadFileResult, IFiles } from "@yaaa/interfaces";
import { isWithinAnyRoot, isWithinRoot, resolveFileRoots } from "@yaaa/shared";
import { renderTextScreenshot } from "./screenshot.js";

export interface FilesFsOptions {
  /**
   * Absolute roots reachable outside `baseDir`. Defaults to the configured
   * access mode (full disk unless `YAAA_FILE_ACCESS`/`YAAA_FILE_ROOTS` narrow
   * it). Pass `[]` to confine the provider to `baseDir` alone.
   */
  allowedRoots?: string[];
}

export class FilesFs implements IFiles {
  private baseDir: string;
  private allowedRoots: string[];

  constructor(baseDir: string, options: FilesFsOptions = {}) {
    this.baseDir = path.resolve(baseDir);
    this.allowedRoots = (options.allowedRoots ?? resolveFileRoots()).map((root) => path.resolve(root));
    // Ensure base directory exists
    if (!fsSync.existsSync(this.baseDir)) {
      fsSync.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Resolve a tool-supplied path to a real one.
   *
   * A relative path is always anchored to the task workspace, so an agent's
   * ordinary deliverables keep landing there. A path that escapes the workspace
   * (absolute, or via `..`) is allowed only when it falls inside a configured
   * root — which by default is the whole disk, because YAAA drives the user's
   * own machine and refusing to read their files reads as a permission bug.
   */
  private resolvePath(targetPath: string): string {
    const resolved = path.resolve(this.baseDir, targetPath);
    if (isWithinRoot(resolved, this.baseDir)) return resolved;
    if (isWithinAnyRoot(resolved, this.allowedRoots)) return resolved;
    throw new Error(
      `Path ${targetPath} resolved to ${resolved}, which is outside the task workspace ${this.baseDir} and every allowed root (${this.allowedRoots.join(", ") || "none"}). Set YAAA_FILE_ACCESS=full or list roots in YAAA_FILE_ROOTS to widen access.`,
    );
  }

  /**
   * Turn an OS-level permission failure into something the user can act on.
   *
   * On macOS the OS itself gates ~/Desktop, ~/Documents, ~/Downloads and
   * iCloud Drive behind TCC, so a perfectly valid path still fails with EPERM
   * until the user grants access — and a bare "EPERM: operation not permitted"
   * gives them no idea that a checkbox in System Settings is the fix. EACCES,
   * by contrast, is usually ownership: a task folder created by a `sudo` run
   * stays root-owned and blocks every later write.
   */
  private explainFsError(error: unknown, fullPath: string): unknown {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "EPERM" && code !== "EACCES") return error;
    const hint =
      code === "EPERM" && process.platform === "darwin"
        ? `macOS is blocking access to ${fullPath}. Grant Full Disk Access to the app running YAAA (System Settings → Privacy & Security → Full Disk Access), then restart it.`
        : `No permission to access ${fullPath}. Check the file's owner — anything created by a "sudo" run stays root-owned and blocks later writes (chown it back to your user).`;
    const explained = new Error(`${hint} (original error: ${(error as Error)?.message ?? String(error)})`) as Error & {
      code?: string;
      cause?: unknown;
    };
    explained.code = code;
    explained.cause = error;
    return explained;
  }

  /** Run a filesystem call, re-describing permission failures usefully. */
  private async guard<T>(fullPath: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.explainFsError(error, fullPath);
    }
  }

  async readFile(targetPath: string): Promise<string> {
    const fullPath = this.resolvePath(targetPath);
    return this.guard(fullPath, () => fs.readFile(fullPath, "utf-8"));
  }

  async readLines(targetPath: string, startLine = 1, endLine?: number): Promise<{ content: string; startLine: number; endLine: number; totalLines: number }> {
    const lines = (await this.readFile(targetPath)).split(/\r?\n/);
    const start = Math.max(1, startLine);
    const end = Math.min(lines.length, endLine ?? lines.length);
    return { content: lines.slice(start - 1, end).join("\n"), startLine: start, endLine: end, totalLines: lines.length };
  }

  async writeFile(targetPath: string, content: string | Buffer): Promise<void> {
    const fullPath = this.resolvePath(targetPath);
    await this.guard(fullPath, async () => {
      // Ensure directory exists
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      if (typeof content === "string") {
        await fs.writeFile(fullPath, content, "utf-8");
      } else {
        await fs.writeFile(fullPath, content);
      }
    });
  }

  /** Download a bounded binary asset into the task workspace. */
  async downloadFile(url: string, targetPath: string, options: DownloadFileOptions = {}): Promise<DownloadFileResult> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid download URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Only http(s) download URLs are allowed: ${url}`);
    }
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 60_000, 1_000), 120_000);
    const maxBytes = Math.min(Math.max(options.maxBytes ?? 25 * 1024 * 1024, 1), 100 * 1024 * 1024);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(parsed, { signal: controller.signal, redirect: "follow" });
      if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error(`Download exceeds the ${maxBytes}-byte limit: ${url}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxBytes) throw new Error(`Download exceeds the ${maxBytes}-byte limit: ${url}`);
      await this.writeFile(targetPath, bytes);
      return {
        path: targetPath,
        contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream",
        bytes: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error(`Download timed out after ${timeoutMs}ms: ${url}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async writeLines(targetPath: string, startLine: number, endLine: number, content: string): Promise<void> {
    const existing = fsSync.existsSync(this.resolvePath(targetPath)) ? (await this.readFile(targetPath)).split(/\r?\n/) : [];
    existing.splice(Math.max(0, startLine - 1), Math.max(0, endLine - startLine + 1), ...content.split(/\r?\n/));
    await this.writeFile(targetPath, existing.join("\n"));
  }

  async deleteLines(targetPath: string, startLine: number, endLine: number): Promise<void> { const lines = (await this.readFile(targetPath)).split(/\r?\n/); lines.splice(Math.max(0, startLine - 1), Math.max(0, endLine - startLine + 1)); await this.writeFile(targetPath, lines.join("\n")); }
  async delete(targetPath: string, recursive = false): Promise<void> { const full = this.resolvePath(targetPath); await this.guard(full, () => fs.rm(full, { recursive, force: false })); }
  async createDirectory(targetPath: string): Promise<void> { const full = this.resolvePath(targetPath); await this.guard(full, () => fs.mkdir(full, { recursive: true }).then(() => undefined)); }
  async move(source: string, destination: string): Promise<void> { const dest = this.resolvePath(destination); await this.guard(dest, async () => { await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.rename(this.resolvePath(source), dest); }); }
  async copy(source: string, destination: string): Promise<void> { const dest = this.resolvePath(destination); await this.guard(dest, () => fs.cp(this.resolvePath(source), dest, { recursive: true })); }
  async stat(targetPath: string) { const full = this.resolvePath(targetPath); const value = await this.guard(full, () => fs.stat(full)); return { size: value.size, isFile: value.isFile(), isDirectory: value.isDirectory(), createdAt: value.birthtime.toISOString(), modifiedAt: value.mtime.toISOString() }; }
  async screenshot(targetPath: string, outputPath: string, startLine = 1, endLine?: number) { const result = await this.readLines(targetPath, startLine, endLine); return renderTextScreenshot(result.content, this.resolvePath(outputPath), targetPath); }

  async listFiles(dirPath: string): Promise<string[]> {
    const fullPath = this.resolvePath(dirPath);
    const entries = await this.guard(fullPath, () => fs.readdir(fullPath, { withFileTypes: true }));
    return entries.map((entry) => {
      const rel = path.relative(this.baseDir, path.join(fullPath, entry.name));
      return entry.isDirectory() ? `${rel}/` : rel;
    });
  }

  async searchFiles(pattern: string, dirPath: string): Promise<string[]> {
    const cwd = this.resolvePath(dirPath);
    const glob = /[*?{}[\]]/.test(pattern) ? pattern : `**/*${pattern}*`;
    return (await fg(glob, { cwd, onlyFiles: true, dot: true })).map((entry) => path.relative(this.baseDir, path.join(cwd, entry)));
  }
}
