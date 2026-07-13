import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { IFiles } from "@yaaa/interfaces";
import { renderTextScreenshot } from "./screenshot.js";

export class FilesFs implements IFiles {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    // Ensure base directory exists
    if (!fsSync.existsSync(this.baseDir)) {
      fsSync.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private resolvePath(targetPath: string): string {
    const resolved = path.resolve(this.baseDir, targetPath);
    const relative = path.relative(this.baseDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Directory traversal violation: Path ${targetPath} resolved to ${resolved} which is outside the base directory ${this.baseDir}`);
    }
    return resolved;
  }

  async readFile(targetPath: string): Promise<string> {
    const fullPath = this.resolvePath(targetPath);
    return fs.readFile(fullPath, "utf-8");
  }

  async readLines(targetPath: string, startLine = 1, endLine?: number): Promise<{ content: string; startLine: number; endLine: number; totalLines: number }> {
    const lines = (await this.readFile(targetPath)).split(/\r?\n/);
    const start = Math.max(1, startLine);
    const end = Math.min(lines.length, endLine ?? lines.length);
    return { content: lines.slice(start - 1, end).join("\n"), startLine: start, endLine: end, totalLines: lines.length };
  }

  async writeFile(targetPath: string, content: string | Buffer): Promise<void> {
    const fullPath = this.resolvePath(targetPath);
    // Ensure directory exists
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    if (typeof content === "string") {
      await fs.writeFile(fullPath, content, "utf-8");
    } else {
      await fs.writeFile(fullPath, content);
    }
  }

  async writeLines(targetPath: string, startLine: number, endLine: number, content: string): Promise<void> {
    const existing = fsSync.existsSync(this.resolvePath(targetPath)) ? (await this.readFile(targetPath)).split(/\r?\n/) : [];
    existing.splice(Math.max(0, startLine - 1), Math.max(0, endLine - startLine + 1), ...content.split(/\r?\n/));
    await this.writeFile(targetPath, existing.join("\n"));
  }

  async deleteLines(targetPath: string, startLine: number, endLine: number): Promise<void> { const lines = (await this.readFile(targetPath)).split(/\r?\n/); lines.splice(Math.max(0, startLine - 1), Math.max(0, endLine - startLine + 1)); await this.writeFile(targetPath, lines.join("\n")); }
  async delete(targetPath: string, recursive = false): Promise<void> { await fs.rm(this.resolvePath(targetPath), { recursive, force: false }); }
  async createDirectory(targetPath: string): Promise<void> { await fs.mkdir(this.resolvePath(targetPath), { recursive: true }); }
  async move(source: string, destination: string): Promise<void> { const dest = this.resolvePath(destination); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.rename(this.resolvePath(source), dest); }
  async copy(source: string, destination: string): Promise<void> { await fs.cp(this.resolvePath(source), this.resolvePath(destination), { recursive: true }); }
  async stat(targetPath: string) { const value = await fs.stat(this.resolvePath(targetPath)); return { size: value.size, isFile: value.isFile(), isDirectory: value.isDirectory(), createdAt: value.birthtime.toISOString(), modifiedAt: value.mtime.toISOString() }; }
  async screenshot(targetPath: string, outputPath: string, startLine = 1, endLine?: number) { const result = await this.readLines(targetPath, startLine, endLine); return renderTextScreenshot(result.content, this.resolvePath(outputPath), targetPath); }

  async listFiles(dirPath: string): Promise<string[]> {
    const fullPath = this.resolvePath(dirPath);
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
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
