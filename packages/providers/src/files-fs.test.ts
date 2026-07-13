import os from "node:os";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FilesFs } from "./files-fs.js";

describe("FilesFs", () => {
  // Use os.tmpdir() so directory creation and cleanup work on macOS, Linux, and Windows
  const testDir = path.join(os.tmpdir(), `yaaa-test-workspace-${Date.now()}`);
  let filesFs: FilesFs;

  beforeAll(async () => {
    await fs.mkdir(testDir, { recursive: true });
    filesFs = new FilesFs(testDir);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("should create the base directory if it does not exist", () => {
    const nonExistentDir = path.join(os.tmpdir(), `yaaa-brand-new-${Date.now()}`);
    new FilesFs(nonExistentDir);
    expect(fsSync.existsSync(nonExistentDir)).toBe(true);
    // Cleanup
    fsSync.rmSync(nonExistentDir, { recursive: true, force: true });
  });

  it("should write and read files successfully", async () => {
    await filesFs.writeFile("test.txt", "hello world");
    const content = await filesFs.readFile("test.txt");
    expect(content).toBe("hello world");
  });

  it("should create nested subdirectories and write files", async () => {
    await filesFs.writeFile("sub/folder/nested.txt", "nested content");
    const content = await filesFs.readFile("sub/folder/nested.txt");
    expect(content).toBe("nested content");
  });

  it("should list files and folders correctly", async () => {
    const list = await filesFs.listFiles(".");
    expect(list).toContain("test.txt");
    expect(list).toContain("sub" + path.sep);
  });

  it("should search files matching a pattern", async () => {
    const search = await filesFs.searchFiles("nested", ".");
    expect(search).toContain(path.normalize("sub/folder/nested.txt"));
  });

  it("should block directory traversal outside base directory", async () => {
    await expect(filesFs.readFile("../package.json")).rejects.toThrow(
      "Directory traversal violation"
    );
  });

  it("does not confuse a sibling with a shared path prefix for the workspace", async () => {
    await expect(filesFs.readFile(`../${path.basename(testDir)}-evil/file.txt`)).rejects.toThrow("Directory traversal violation");
  });

  it("reads, replaces, and deletes inclusive line ranges", async () => {
    await filesFs.writeFile("lines.txt", "one\ntwo\nthree\nfour");
    expect((await filesFs.readLines("lines.txt", 2, 3)).content).toBe("two\nthree");
    await filesFs.writeLines("lines.txt", 2, 3, "TWO\nTHREE");
    await filesFs.deleteLines("lines.txt", 3, 3);
    expect(await filesFs.readFile("lines.txt")).toBe("one\nTWO\nfour");
  });

  it("supports wildcard search and file metadata", async () => {
    expect(await filesFs.searchFiles("**/*.txt", ".")).toContain("lines.txt");
    expect(await filesFs.stat("lines.txt")).toMatchObject({ isFile: true, isDirectory: false });
  });
});
