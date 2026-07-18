import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  filesystemRoot,
  isWithinAnyRoot,
  isWithinRoot,
  resolveFileAccessMode,
  resolveFileRoots,
} from "./file-roots.js";

describe("resolveFileAccessMode", () => {
  it("defaults to full disk access, so ordinary requests are not permission errors", () => {
    expect(resolveFileAccessMode({})).toBe("full");
  });

  it("honours an explicit mode, case-insensitively", () => {
    expect(resolveFileAccessMode({ YAAA_FILE_ACCESS: "workspace" })).toBe("workspace");
    expect(resolveFileAccessMode({ YAAA_FILE_ACCESS: "HOME" })).toBe("home");
  });

  it("falls back to full access when the mode is unrecognised", () => {
    expect(resolveFileAccessMode({ YAAA_FILE_ACCESS: "banana" })).toBe("full");
  });
});

describe("resolveFileRoots", () => {
  it("grants the whole disk by default", () => {
    expect(resolveFileRoots({})).toEqual([filesystemRoot()]);
  });

  it("grants only the home directory in home mode", () => {
    expect(resolveFileRoots({ YAAA_FILE_ACCESS: "home" })).toEqual([path.resolve(os.homedir())]);
  });

  it("grants nothing beyond the workspace in workspace mode", () => {
    expect(resolveFileRoots({ YAAA_FILE_ACCESS: "workspace" })).toEqual([]);
  });

  it("lets explicit roots override the mode", () => {
    const roots = resolveFileRoots({
      YAAA_FILE_ACCESS: "workspace",
      YAAA_FILE_ROOTS: ["/tmp/one", "/tmp/two"].join(path.delimiter),
    });
    expect(roots).toEqual([path.resolve("/tmp/one"), path.resolve("/tmp/two")]);
  });

  it("ignores relative entries rather than resolving them against an arbitrary cwd", () => {
    expect(resolveFileRoots({ YAAA_FILE_ROOTS: ["relative/dir", "/tmp/ok"].join(path.delimiter) }))
      .toEqual([path.resolve("/tmp/ok")]);
  });

  it("collapses a root already contained by another", () => {
    expect(resolveFileRoots({ YAAA_FILE_ROOTS: ["/tmp/parent", "/tmp/parent/child"].join(path.delimiter) }))
      .toEqual([path.resolve("/tmp/parent")]);
  });
});

describe("isWithinRoot", () => {
  it("accepts the root itself and its descendants", () => {
    expect(isWithinRoot("/tmp/root", "/tmp/root")).toBe(true);
    expect(isWithinRoot("/tmp/root/nested/file.txt", "/tmp/root")).toBe(true);
  });

  it("rejects escapes and sibling directories with a shared prefix", () => {
    expect(isWithinRoot("/tmp/other", "/tmp/root")).toBe(false);
    expect(isWithinRoot("/tmp/rootsibling", "/tmp/root")).toBe(false);
    expect(isWithinRoot("/tmp", "/tmp/root")).toBe(false);
  });

  it("treats the filesystem root as containing everything", () => {
    expect(isWithinAnyRoot("/Users/someone/Documents/report.pdf", [filesystemRoot()])).toBe(true);
  });
});
