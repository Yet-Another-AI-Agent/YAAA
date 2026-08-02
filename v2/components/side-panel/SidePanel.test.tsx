// @vitest-environment jsdom
import React, { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidePanel } from "./SidePanel";
import type { SidePanelHandle } from "./interfaces/side-panel.interfaces";

describe("SidePanel", () => {
  afterEach(cleanup);
  it("renders tabs, switches content, and closes a tab", () => {
    const onEvent = vi.fn();
    render(<SidePanel onEvent={onEvent} initialTabs={[{ id: "logs", title: "Logs", content: [{ id: "entry", title: "Latest", content: "Connected" }] }, { id: "files", title: "Files", content: [{ id: "file", content: "README.md" }] }]} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.getByText("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close Files" }));
    expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "tab-close", tabId: "files" }));
  });
  it("supports tab and content lifecycle methods", () => {
    const ref = createRef<SidePanelHandle>();
    render(<SidePanel ref={ref} />);
    act(() => ref.current?.addTab({ id: "logs", title: "Logs", content: [] }));
    act(() => ref.current?.addContent("logs", { id: "entry", content: "First" }));
    expect(screen.getByText("First")).toBeInTheDocument();
    act(() => ref.current?.editContent("logs", "entry", { content: "Updated" }));
    expect(screen.getByText("Updated")).toBeInTheDocument();
    act(() => ref.current?.deleteContent("logs", "entry"));
    expect(screen.queryByText("Updated")).toBeNull();
    act(() => ref.current?.deleteTab("logs"));
    expect(screen.queryByRole("button", { name: "Logs" })).toBeNull();
  });
});

