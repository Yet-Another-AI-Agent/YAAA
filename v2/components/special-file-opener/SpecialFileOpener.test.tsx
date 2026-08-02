// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileKind } from "./enums/file.enums";
import { SpecialFileOpener } from "./SpecialFileOpener";

afterEach(cleanup);

describe("SpecialFileOpener", () => {
  it("renders file metadata and emits the complete file when opened", () => {
    const file = { name: "deck.pptx", kind: FileKind.Ppt, size: 2048, location: "/tmp/deck.pptx" } as const;
    const onOpen = vi.fn();
    render(<SpecialFileOpener file={file} onOpen={onOpen} />);
    expect(screen.getByText("deck.pptx")).toBeInTheDocument();
    expect(screen.getByText("PowerPoint · 2 KB")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open deck.pptx" }));
    expect(onOpen).toHaveBeenCalledWith(file);
    expect(screen.getByRole("dialog", { name: "deck.pptx viewer" })).toBeInTheDocument();
  });

  it("uses an image thumbnail when one is supplied", () => {
    render(<SpecialFileOpener file={{ name: "photo.png", kind: FileKind.Image, thumbnailUrl: "data:image/png;base64,abc" }} onOpen={vi.fn()} />);
    expect(screen.getByRole("presentation")).toHaveAttribute("src", "data:image/png;base64,abc");
  });

  it("opens and closes its built-in viewer even without an event listener", () => {
    render(<SpecialFileOpener file={{ name: "readme.md", kind: "markdown", content: "# Read me" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open readme.md" }));
    expect(screen.getByRole("dialog", { name: "readme.md viewer" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close viewer" }));
    expect(screen.queryByRole("dialog", { name: "readme.md viewer" })).toBeNull();
  });
});
