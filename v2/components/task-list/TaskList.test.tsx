// @vitest-environment jsdom
import React, { createRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskList } from "./TaskList";
import type { TaskListHandle } from "./interfaces/task-list.interfaces";

const subtask = { id: "ST-1", title: "Build the task panel", state: "running" as const, roles: ["Engineer"], capabilities: ["TypeScript"], microTasks: [{ id: "MT-1", title: "Create interfaces", state: "pending" as const }, { id: "MT-2", title: "Add tests", state: "running" as const }] };

describe("TaskList", () => {
  afterEach(cleanup);
  it("renders nested subtasks without user action controls", () => {
    const onEvent = vi.fn();
    const ref = createRef<TaskListHandle>();
    render(<TaskList ref={ref} initialSubtasks={[subtask]} onEvent={onEvent} />);
    expect(screen.queryByRole("button", { name: "Complete Build the task panel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Build the task panel" })).toBeNull();
    expect(screen.getByText("Not started")).toBeInTheDocument();
    expect(screen.getAllByText("In progress").length).toBeGreaterThan(0);
    act(() => ref.current?.completeSubtask("ST-1"));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "subtask-complete", subtaskId: "ST-1" }));
    act(() => ref.current?.completeMicroTask("ST-1", "MT-1"));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "microtask-complete", subtaskId: "ST-1", microTaskId: "MT-1" }));
    act(() => ref.current?.deleteMicroTask("ST-1", "MT-2"));
    expect(onEvent).toHaveBeenCalledWith({ kind: "microtask-delete", subtaskId: "ST-1", microTaskId: "MT-2" });
  });
  it("supports add/update/complete/delete through its handle", () => {
    const ref = createRef<TaskListHandle>();
    const onEvent = vi.fn();
    render(<TaskList ref={ref} onEvent={onEvent} />);
    act(() => ref.current?.addSubtask({ id: "ST-2", title: "Review changes", state: "pending" }));
    act(() => ref.current?.addMicroTask("ST-2", { id: "MT-3", title: "Inspect the diff", state: "pending" }));
    act(() => ref.current?.updateSubtask("ST-2", { title: "Review all changes", state: "running" }));
    act(() => ref.current?.completeSubtask("ST-2"));
    expect(screen.getByText("Review all changes")).toBeInTheDocument();
    expect(screen.getByText("Inspect the diff")).toBeInTheDocument();
    act(() => ref.current?.deleteSubtask("ST-2"));
    expect(screen.queryByText("Review all changes")).toBeNull();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "subtask-add" }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "microtask-add", subtaskId: "ST-2" }));
  });
});
