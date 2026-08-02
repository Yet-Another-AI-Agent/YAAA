// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelTier } from "./enums/typing-bar.enums";
import { TypingBar } from "./TypingBar";

afterEach(cleanup);

describe("TypingBar", () => {
  it("sends text with the selected model and clears the composer", () => {
    const onSend = vi.fn();
    render(<TypingBar onSend={onSend} initialModelTier={ModelTier.Base} />);
    const textarea = screen.getByLabelText("Message");
    fireEvent.change(textarea, { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("radio", { name: "State of art" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith({ text: "Hello", attachments: [], modelTier: ModelTier.StateOfArt });
    expect(textarea).toHaveValue("");
  });

  it("supports attachment selection and removal", () => {
    const onSend = vi.fn();
    render(<TypingBar onSend={onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    fireEvent.click(screen.getByRole("button", { name: /Files/ }));
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Choose attachments"), { target: { files: [file] } });
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(screen.getByText("5 B")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  it("continues a bullet list on Enter and disables send when empty", () => {
    render(<TypingBar onSend={vi.fn()} />);
    const textarea = screen.getByLabelText("Message");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.change(textarea, { target: { value: "- first", selectionStart: 7, selectionEnd: 7 } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    expect(textarea).toHaveValue("- first\n- ");
  });

  it("keeps the textarea scrolled to the newest line for indented and numbered lists", () => {
    render(<TypingBar onSend={vi.fn()} />);
    const textarea = screen.getByLabelText("Message");
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 480 });

    fireEvent.change(textarea, { target: { value: "  - nested", selectionStart: 10, selectionEnd: 10 } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    expect(textarea).toHaveValue("  - nested\n  - ");
    expect(textarea.scrollTop).toBe(480);

    fireEvent.change(textarea, { target: { value: "9. ninth", selectionStart: 8, selectionEnd: 8 } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    expect(textarea).toHaveValue("9. ninth\n10. ");
    expect(textarea.scrollTop).toBe(480);
  });

  it("reports unavailable voice recording without throwing", () => {
    render(<TypingBar onSend={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Record voice" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Voice recording is unavailable");
  });

  it("grows the composer a little while typing and caps the height", () => {
    render(<TypingBar onSend={vi.fn()} />);
    const textarea = screen.getByLabelText("Message");
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 96 });
    fireEvent.change(textarea, { target: { value: "A longer message" } });
    expect(textarea).toHaveStyle({ height: "96px", overflowY: "hidden" });

    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 240 });
    fireEvent.change(textarea, { target: { value: "A much longer message" } });
    expect(textarea).toHaveStyle({ height: "168px", overflowY: "auto" });
  });
});
