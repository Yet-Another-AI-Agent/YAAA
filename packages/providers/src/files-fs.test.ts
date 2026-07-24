import os from "node:os";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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

  it("downloads a bounded binary asset into the workspace and returns provenance", async () => {
    const payload = Buffer.from([0, 1, 2, 3, 255]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(payload, {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(payload.length) },
    })));
    const result = await filesFs.downloadFile("https://example.com/logo.png", "branding/logo.png");
    expect(result).toMatchObject({ path: "branding/logo.png", contentType: "image/png", bytes: payload.length });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await fs.readFile(path.join(testDir, "branding/logo.png"))).toEqual(payload);
    vi.unstubAllGlobals();
  });

  it("rejects non-http URLs and oversized assets", async () => {
    await expect(filesFs.downloadFile("file:///tmp/secret", "secret.bin")).rejects.toThrow(/Only http\(s\)/);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(Buffer.alloc(8), {
      status: 200,
      headers: { "content-length": "8" },
    })));
    await expect(filesFs.downloadFile("https://example.com/large.bin", "large.bin", { maxBytes: 4 })).rejects.toThrow(/exceeds/);
    vi.unstubAllGlobals();
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

  // YAAA drives the user's own machine, so by default an agent can reach files
  // outside its task workspace. `allowedRoots: []` restores the strict,
  // workspace-only confinement for deployments that want it.
  describe("workspace-only mode (allowedRoots: [])", () => {
    let confined: FilesFs;

    beforeAll(() => {
      confined = new FilesFs(testDir, { allowedRoots: [] });
    });

    it("blocks traversal outside the base directory", async () => {
      await expect(confined.readFile("../package.json")).rejects.toThrow(/outside the task workspace/);
    });

    it("does not confuse a sibling with a shared path prefix for the workspace", async () => {
      await expect(confined.readFile(`../${path.basename(testDir)}-evil/file.txt`)).rejects.toThrow(
        /outside the task workspace/,
      );
    });

    it("blocks an absolute path outside the workspace", async () => {
      await expect(confined.readFile(path.join(os.tmpdir(), "somewhere-else.txt"))).rejects.toThrow(
        /outside the task workspace/,
      );
    });
  });

  describe("full access mode (the default)", () => {
    const outsideDir = path.join(os.tmpdir(), `yaaa-test-outside-${Date.now()}`);
    const outsideFile = path.join(outsideDir, "user-file.txt");

    beforeAll(async () => {
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(outsideFile, "the user's own file", "utf-8");
    });

    afterAll(async () => {
      await fs.rm(outsideDir, { recursive: true, force: true });
    });

    it("reads a file outside the workspace by absolute path", async () => {
      expect(await filesFs.readFile(outsideFile)).toBe("the user's own file");
    });

    it("writes a file outside the workspace by absolute path", async () => {
      const target = path.join(outsideDir, "written-by-agent.txt");
      await filesFs.writeFile(target, "agent output");
      expect(await fs.readFile(target, "utf-8")).toBe("agent output");
    });

    it("still anchors a relative path to the task workspace", async () => {
      await filesFs.writeFile("relative-stays-home.txt", "in workspace");
      expect(fsSync.existsSync(path.join(testDir, "relative-stays-home.txt"))).toBe(true);
    });

    // A raw "EACCES: permission denied" tells the user nothing they can act on.
    it("explains an OS permission failure instead of surfacing a bare errno", async () => {
      const unreadable = path.join(outsideDir, "unreadable.txt");
      await fs.writeFile(unreadable, "secret", "utf-8");
      await fs.chmod(unreadable, 0o000);
      try {
        // Root ignores file modes, so this check is meaningless when run as root.
        if (typeof process.getuid === "function" && process.getuid() === 0) return;
        await expect(filesFs.readFile(unreadable)).rejects.toThrow(/root-owned|Full Disk Access/);
        await expect(filesFs.readFile(unreadable)).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        await fs.chmod(unreadable, 0o600);
      }
    });

    it("honours explicit roots, rejecting anything outside them", async () => {
      const scoped = new FilesFs(testDir, { allowedRoots: [outsideDir] });
      expect(await scoped.readFile(outsideFile)).toBe("the user's own file");
      await expect(scoped.readFile("/etc/hosts")).rejects.toThrow(/every allowed root/);
    });
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
