// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VsCodeDiffViewer } from "./VsCodeDiffViewer";

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: (props: { original: string; modified: string; theme?: string; options?: { renderSideBySide?: boolean } }) => <div aria-label="Monaco diff editor" data-original={props.original} data-modified={props.modified} data-theme={props.theme} data-side-by-side={String(props.options?.renderSideBySide)} />,
}));

describe("VsCodeDiffViewer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows a compact preview and opens the complete diff in a popup", () => {
    render(<VsCodeDiffViewer oldCode="const answer = 41;" newCode="const answer = 42;" language="typescript" title="Answer diff" theme="light" />);
    expect(screen.queryByRole("dialog", { name: "Answer diff" })).toBeNull();
    const editor = screen.getByLabelText("Monaco diff editor");
    expect(editor).toHaveAttribute("data-original", "const answer = 41;");
    expect(editor).toHaveAttribute("data-modified", "const answer = 42;");
    expect(editor).toHaveAttribute("data-side-by-side", "false");
    expect(editor).toHaveAttribute("data-theme", "light");
    expect(screen.getByRole("region", { name: "Answer diff" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open full" }));
    expect(screen.getByRole("dialog", { name: "Answer diff" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close code diff" }));
    expect(screen.queryByRole("dialog", { name: "Answer diff" })).toBeNull();
  });
});
