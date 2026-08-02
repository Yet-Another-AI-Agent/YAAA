// @vitest-environment jsdom
import React, { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RightPane } from "./RightPane";
import type { RightPaneHandle } from "./interfaces/right-pane.interfaces";

const bot = { id: "bot-1", name: "Researcher", status: "online" as const, contextWindow: { used: 20, limit: 100 } };
const folder = { id: "project", name: "Project folder", path: "/project", kind: "agent-space" as const, children: [{ id: "file", name: "README.md", path: "/project/README.md", type: "file" as const }] };

describe("RightPane", () => {
  afterEach(cleanup);
  it("renders both right-panel components and emits their interactions", () => {
    const onEvent = vi.fn();
    render(<RightPane initialBots={[bot]} initialFolders={[folder]} onEvent={onEvent} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Researcher" }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "bot-open", bot }));
    fireEvent.click(screen.getByRole("button", { name: "Expand files in Project folder" }));
    fireEvent.click(screen.getByRole("button", { name: /README\.md/ }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "file-open", fileName: "README.md", path: "/project/README.md" }));
  });
  it("accepts the same event contract as input through its handle", () => {
    const ref = createRef<RightPaneHandle>();
    render(<RightPane ref={ref} />);
    act(() => ref.current?.emit({ kind: "bot-add", bot }));
    expect(screen.getByText("Researcher")).toBeInTheDocument();
    act(() => ref.current?.emit({ kind: "folder-add", folder }));
    expect(screen.getByText("Project folder")).toBeInTheDocument();
    act(() => ref.current?.emit({ kind: "folder-delete", folderId: "project" }));
    expect(screen.queryByText("Project folder")).toBeNull();
  });
});

