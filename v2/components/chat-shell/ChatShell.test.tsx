// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatShell } from "./ChatShell";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("ChatShell", () => {
  it("keeps the composer visible and appends a request and hardcoded response", () => {
    vi.useFakeTimers();
    render(<ChatShell responseText="Hardcoded response" />);
    expect(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Hello Nova" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByText("Hello Nova")).toBeInTheDocument();
    const tick = screen.getByLabelText("delivery Single");
    expect(tick).toHaveTextContent("✓");
    expect(screen.getByLabelText("typing")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(12));
    expect(screen.getByText("H")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(12 * ("Hardcoded response".length - 1)));
    expect(screen.getByText("Hardcoded response")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
  });

  it("passes composer attachments into the request and renders them with the file opener", () => {
    render(<ChatShell responseText="Done" />);
    const file = new File(["# notes"], "notes.md", { type: "text/markdown" });
    fireEvent.change(screen.getByLabelText("Choose attachments"), { target: { files: [file] } });
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Review this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByText("Review this")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open notes.md" })).toBeInTheDocument();
    expect(screen.getByLabelText("delivery Single")).toBeInTheDocument();
  });

  it("uses a fixed shell layout with a scrollable message region", () => {
    render(<ChatShell />);
    expect(screen.getByRole("main", { name: "Chat" })).toHaveClass("v2-chat-shell");
    expect(screen.getByLabelText("Chat messages")).toHaveClass("chat-v2-message-list");
  });

  it("queues a second response while the first response is typing", () => {
    vi.useFakeTimers();
    render(<ChatShell responseText="Done" />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.change(input, { target: { value: "Second" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getAllByLabelText("typing")).toHaveLength(2);
    act(() => vi.advanceTimersByTime(12 * "Done".length));
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByLabelText("typing")).toBeInTheDocument();
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
  });
});
