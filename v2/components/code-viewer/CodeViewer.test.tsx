// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { CodeDiffViewer } from "./CodeDiffViewer";
import { CodeViewer } from "./CodeViewer";

describe("Code viewers", () => {
  it("opens a long code sample with tooling controls", () => {
    const content = Array.from({ length: 20 }, (_, index) => `const value${index} = ${index};`).join("\n");
    render(<CodeViewer content={content} language="typescript" title="example.ts" previewLines={3} />);
    fireEvent.click(screen.getByRole("button", { name: "Open full" }));
    expect(screen.getByRole("dialog", { name: "example.ts" })).toBeInTheDocument();
    const dialog = screen.getByRole("dialog", { name: "example.ts" });
    fireEvent.click(within(dialog).getByRole("button", { name: "No wrap" }));
    expect(within(dialog).getByRole("button", { name: "Wrap" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close code viewer" }));
    expect(screen.queryByRole("dialog", { name: "example.ts" })).toBeNull();
  });

  it("marks changed code in red and green", () => {
    render(<CodeDiffViewer before={"const answer = 41;\nreturn answer;"} after={"const answer = 42;\nreturn answer;"} language="typescript" />);
    expect(screen.getByText("− const answer = 41;")).toHaveClass("v2-code-removed");
    expect(screen.getByText("+ const answer = 42;")).toHaveClass("v2-code-added");
    expect(screen.getByRole("region", { name: "Removed code" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Added code" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Removed code" }).compareDocumentPosition(screen.getByRole("region", { name: "Added code" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
