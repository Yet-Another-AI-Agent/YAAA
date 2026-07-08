import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { IFiles } from "@yaaa/interfaces";

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
    if (!resolved.startsWith(this.baseDir)) {
      throw new Error(`Directory traversal violation: Path ${targetPath} resolved to ${resolved} which is outside the base directory ${this.baseDir}`);
    }
    return resolved;
  }

  async readFile(targetPath: string): Promise<string> {
    const fullPath = this.resolvePath(targetPath);
    return fs.readFile(fullPath, "utf-8");
  }

  async writeFile(targetPath: string, content: string): Promise<void> {
    const fullPath = this.resolvePath(targetPath);
    // Ensure directory exists
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
  }

  async listFiles(dirPath: string): Promise<string[]> {
    const fullPath = this.resolvePath(dirPath);
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    return entries.map((entry) => {
      const rel = path.relative(this.baseDir, path.join(fullPath, entry.name));
      return entry.isDirectory() ? `${rel}/` : rel;
    });
  }

  async searchFiles(pattern: string, dirPath: string): Promise<string[]> {
    const fullPath = this.resolvePath(dirPath);
    const results: string[] = [];

    const walk = async (currentPath: string) => {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullEntryPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          await walk(fullEntryPath);
        } else {
          if (entry.name.includes(pattern)) {
            results.push(path.relative(this.baseDir, fullEntryPath));
          }
        }
      }
    };

    await walk(fullPath);
    return results;
  }
}
