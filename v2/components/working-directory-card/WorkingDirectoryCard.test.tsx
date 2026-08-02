// @vitest-environment jsdom
import React, { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkingDirectoryCard } from "./WorkingDirectoryCard";
import type { WorkingDirectoryCardHandle, WorkingFolder } from "./interfaces/working-directory-card.interfaces";

const folders: WorkingFolder[] = [
  { id: "space", name: "Project folder", path: "tasks/task-1/working", kind: "agent-space", taskId: "task-1", itemCount: 12, children: [{ id: "src", name: "src", path: "/project/src", type: "folder", children: [{ id: "runtime", name: "runtime.ts", path: "/project/src/runtime.ts", type: "file", change: "modified" }] }, { id: "a", name: "package.json", path: "/project/package.json", type: "file", change: "modified" }] },
  ...Array.from({ length: 6 }, (_, index) => ({ id: `agent-${index}`, name: `Agent ${index}`, path: `agent-workspaces/agent-${index}`, kind: "agent-working" as const, taskId: "task-1", agentId: `agent-${index}`, agentName: `Agent ${index}`, files: [{ id: `file-${index}`, name: `notes-${index}.md`, change: "created" as const }] })),
];

describe("WorkingDirectoryCard", () => {
  afterEach(cleanup);

  it("separates Agent Space and agent folders and paginates after five", () => {
    render(<WorkingDirectoryCard initialFolders={folders} />);
    expect(screen.getByText("Mission files and folders")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Agent Space 6/ }));
    expect(screen.getByText("Agent 0")).toBeInTheDocument();
    expect(screen.getByText("Agent 4")).toBeInTheDocument();
    expect(screen.queryByText("Agent 5")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand files in Agent 0" }));
    expect(screen.getByText("notes-0.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next folders" }));
    expect(screen.getByText("Agent 5")).toBeInTheDocument();
  });

  it("paginates the shared working folder by its root entries", () => {
    const root = { ...folders[0], children: Array.from({ length: 6 }, (_, index) => ({ id: `root-${index}`, name: `root-${index}.ts`, path: `/project/root-${index}.ts`, type: "file" as const })) };
    render(<WorkingDirectoryCard initialFolders={[root]} />);
    expect(screen.queryByText("root-5.ts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand files in Project folder" }));
    expect(screen.getByText("root-0.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next folders" }));
    expect(screen.getByText("root-5.ts")).toBeInTheDocument();
  });

  it("opens a folder through the callback", () => {
    const onOpenFolder = vi.fn();
    render(<WorkingDirectoryCard initialFolders={folders} onOpenFolder={onOpenFolder} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Project folder" }));
    expect(onOpenFolder).toHaveBeenCalledWith(folders[0]);
  });

  it("renders affected folders and files recursively and returns full file paths", () => {
    const onOpenFile = vi.fn();
    const onEvent = vi.fn();
    render(<WorkingDirectoryCard initialFolders={folders} onOpenFile={onOpenFile} onEvent={onEvent} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand files in Project folder" }));
    expect(screen.getByRole("button", { name: "Expand folder src" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand folder src" }));
    expect(screen.getByText("runtime.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /runtime\.ts/ }));
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ name: "runtime.ts" }), "/project/src/runtime.ts", folders[0]);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "file-open", action: "open", fileName: "runtime.ts", path: "/project/src/runtime.ts" }));
  });

  it("supports init, add, and update through its handle", () => {
    const ref = createRef<WorkingDirectoryCardHandle>();
    render(<WorkingDirectoryCard ref={ref} />);
    act(() => ref.current?.init([folders[0]]));
    expect(screen.getByText("Mission files and folders")).toBeInTheDocument();
    act(() => ref.current?.addFolder(folders[1]));
    fireEvent.click(screen.getByRole("tab", { name: /Agent Space 1/ }));
    expect(screen.getByText("Agent 0")).toBeInTheDocument();
    act(() => ref.current?.updateFolder("agent-0", { name: "Updated agent" }));
    expect(screen.getByText("Updated agent")).toBeInTheDocument();
    act(() => ref.current?.deleteFolder("agent-0"));
    expect(screen.queryByText("Updated agent")).toBeNull();
  });

  it("adds and removes a nested folder through its handle", () => {
    const ref = createRef<WorkingDirectoryCardHandle>();
    render(<WorkingDirectoryCard ref={ref} initialFolders={[folders[0]]} />);
    act(() => ref.current?.addFolder({ id: "nested", name: "generated", path: "generated", kind: "agent-working" }, "space"));
    act(() => ref.current?.updateFolder("nested", { name: "generated-files" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand files in Project folder" }));
    expect(screen.getByRole("button", { name: "Expand folder generated-files" })).toBeInTheDocument();
    act(() => ref.current?.deleteFolder("nested"));
    expect(screen.queryByRole("button", { name: "Expand folder generated-files" })).toBeNull();
  });
});
