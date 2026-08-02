// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownViewer } from "./MarkdownViewer";

afterEach(cleanup);

describe("MarkdownViewer", () => {
  it("renders short Markdown directly", () => {
    render(<MarkdownViewer content={"# Hello\n\nA paragraph."} />);
    expect(screen.getByRole("heading", { name: "Hello" })).toBeInTheDocument();
    expect(screen.getByText("A paragraph.")).toBeInTheDocument();
  });

  it("opens the complete long document in a fixed scrollable popup", () => {
    const content = `# Full plan\n\n${"Details and implementation notes. ".repeat(30)}`;
    render(<MarkdownViewer content={content} title="Plan.md" previewLength={20} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Plan.md" }));
    expect(screen.getByRole("dialog", { name: "Plan.md" })).toBeInTheDocument();
    expect(within(screen.getByRole("dialog", { name: "Plan.md" })).getByRole("heading", { name: "Full plan" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close markdown viewer" }));
    expect(screen.queryByRole("dialog", { name: "Plan.md" })).toBeNull();
  });
});
