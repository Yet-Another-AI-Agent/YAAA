// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { MarkdownCommenter } from "./MarkdownCommenter";

describe("MarkdownCommenter", () => {
  it("opens a per-line composer and emits saved comments", () => {
    const onCommentsChange = vi.fn();
    render(<MarkdownCommenter content={"# Title\n\nReview this paragraph."} onCommentsChange={onCommentsChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Comment on line 3" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment for line 3" }), { target: { value: "Please clarify this." } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    expect(screen.getByText("Comment: Please clarify this.")).toBeInTheDocument();
    expect(onCommentsChange).toHaveBeenCalledWith([{ line: 3, quote: "Review this paragraph.", comment: "Please clarify this." }]);
  });
});
