// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceShell } from "./WorkspaceShell";

describe("WorkspaceShell", () => {
  afterEach(cleanup);
  it("renders the three-level workspace layout", () => {
    render(<div style={{ height: 700 }}><WorkspaceShell title="Build feature" initialSideTabs={[{ id: "logs", title: "Logs", content: [{ id: "one", content: "Ready" }] }]} /></div>);
    expect(screen.getByRole("navigation", { name: "Chat navigation" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Build feature" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Right pane" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Side panel" })).toBeInTheDocument();
  });
  it("uses header controls to navigate and toggle layout space", () => {
    const onBack = vi.fn();
    render(<div style={{ height: 700 }}><WorkspaceShell onBack={onBack} /></div>);
    fireEvent.click(screen.getByRole("button", { name: "Back to home" }));
    expect(onBack).toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "New chat" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Typing bar" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Right pane" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle left pane" }));
    expect(screen.queryByRole("navigation", { name: "Chat navigation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle side panel" }));
    expect(screen.queryByRole("complementary", { name: "Side panel" })).toBeNull();
  });
  it("triggers the chat screen when the home composer sends", () => {
    render(<div style={{ height: 700 }}><WorkspaceShell title="Build feature" /></div>);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Inspect the project" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("heading", { name: "Build feature" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Right pane" })).toBeInTheDocument();
    expect(screen.getByText("Inspect the project")).toBeInTheDocument();
  });
});
