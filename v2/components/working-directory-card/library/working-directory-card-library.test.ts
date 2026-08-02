import { describe, expect, it } from "vitest";
import { addWorkingFolder, deleteWorkingFolder, getCommonWorkingPath, initWorkingFolders, updateWorkingFolder } from "./working-directory-card-library";
import type { WorkingFolder } from "../interfaces/working-directory-card.interfaces";

const folder: WorkingFolder = { id: "one", name: "One", path: "one", kind: "agent-working" };

describe("working-directory-card-library", () => {
  it("initializes without sharing folder objects", () => {
    const result = initWorkingFolders([folder]);
    expect(result).toEqual([folder]);
    expect(result[0]).not.toBe(folder);
  });
  it("adds folders and replaces duplicate ids", () => {
    expect(addWorkingFolder([], folder)).toEqual([folder]);
    expect(addWorkingFolder([folder], { ...folder, name: "Updated" })).toEqual([{ ...folder, name: "Updated" }]);
  });
  it("patches only the matching folder", () => {
    expect(updateWorkingFolder([folder], "one", { itemCount: 4 })[0]).toEqual({ ...folder, itemCount: 4 });
    expect(updateWorkingFolder([folder], "missing", { itemCount: 4 })).toEqual([folder]);
  });
  it("adds, updates, and deletes nested folders recursively", () => {
    const root: WorkingFolder = { id: "root", name: "Root", path: "root", kind: "agent-space" };
    const child: WorkingFolder = { id: "child", name: "Child", path: "root/child", kind: "agent-working" };
    const nested = addWorkingFolder([root], child, "root");
    expect(nested[0].children?.[0]).toMatchObject({ id: "child", name: "Child", type: "folder" });
    const renamed = updateWorkingFolder(nested, "child", { name: "Renamed" });
    expect(renamed[0].children?.[0]).toMatchObject({ name: "Renamed" });
    expect(deleteWorkingFolder(renamed, "child")[0].children).toEqual([]);
  });
  it("finds the shared project folder from affected file paths", () => {
    expect(getCommonWorkingPath([{ ...folder, children: [{ id: "a", name: "a.ts", path: "/project/src/a.ts", type: "file" }, { id: "b", name: "b.ts", path: "/project/b.ts", type: "file" }] }])).toBe("/project");
  });
});
