// @vitest-environment jsdom
import React, { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeftBar } from "./LeftBar";
import type { LeftBarHandle } from "./interfaces/left-bar.interfaces";

const projects = [{ id: "p1", name: "Workspace" }];
const chats = [{ id: "c1", title: "Build feature", projectId: "p1" }, { id: "c2", title: "Temporary chat", projectId: "temp" }, { id: "c3", title: "Unassigned" }];

describe("LeftBar", () => {
  afterEach(cleanup);
  it("groups project chats and places unassigned chats in Other", () => {
    const onChatClick = vi.fn();
    const onEvent = vi.fn();
    render(<LeftBar initialProjects={projects} initialChats={chats} onChatClick={onChatClick} onEvent={onEvent} />);
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Build feature")).toBeInTheDocument();
    expect(screen.getByText("Temporary chat")).toBeInTheDocument();
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Build feature" }));
    expect(onChatClick).toHaveBeenCalledWith(chats[0]);
    expect(onEvent).toHaveBeenCalledWith({ kind: "chat-open", chat: chats[0] });
    fireEvent.change(screen.getByRole("textbox", { name: "Search chats and projects" }), { target: { value: "temporary" } });
    expect(screen.getByText("Temporary chat")).toBeInTheDocument();
    expect(screen.queryByText("Build feature")).toBeNull();
  });
  it("supports new chat, collapse, and lifecycle methods", () => {
    const onNewChat = vi.fn();
    const ref = createRef<LeftBarHandle>();
    const onEvent = vi.fn();
    render(<LeftBar ref={ref} onNewChat={onNewChat} onEvent={onEvent} />);
    fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
    expect(onNewChat).toHaveBeenCalled();
    act(() => ref.current?.addAll(projects, [chats[0]]));
    expect(screen.getByText("Build feature")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Workspace" }));
    expect(screen.queryByText("Build feature")).toBeNull();
    act(() => ref.current?.deleteChat("c1"));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "chat-delete", chatId: "c1" }));
    act(() => ref.current?.deleteProject("p1"));
    expect(onEvent).toHaveBeenCalledWith({ kind: "project-delete", projectId: "p1" });
    expect(screen.queryByText("Workspace")).toBeNull();
  });
});
