// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { FileKind } from "../special-file-opener/enums/file.enums";
import { Viewer } from "./Viewer";

describe("Viewer", () => {
  it("zooms an image and emits close and file-location actions", () => {
    const onClose = vi.fn();
    const onOpenLocation = vi.fn();
    render(<Viewer document={{ name: "photo.png", kind: FileKind.Image, sourceUrl: "data:image/png;base64,abc", location: "/tmp/photo.png" }} onClose={onClose} onOpenLocation={onOpenLocation} />);
    expect(screen.getByRole("dialog", { name: "photo.png viewer" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("125%");
    fireEvent.click(screen.getByRole("button", { name: "Go to file" }));
    expect(onOpenLocation).toHaveBeenCalledWith("/tmp/photo.png");
    fireEvent.click(screen.getByRole("button", { name: "Close viewer" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("navigates PDF pages and presentation slides", () => {
    const { rerender } = render(<Viewer document={{ name: "plan.pdf", kind: FileKind.Pdf, pages: [{ content: "Page one" }, { content: "Page two" }] }} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "PDF page" }), { target: { value: "1" } });
    expect(screen.getByText("Page two")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "PDF page" }), { target: { value: "0" } });
    expect(screen.getByText("Page one")).toBeInTheDocument();
    rerender(<Viewer document={{ name: "plan.pptx", kind: FileKind.Ppt, slides: [{ content: "Slide one" }, { content: "Slide two" }] }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(screen.getByText("Slide two")).toBeInTheDocument();
  });

  it("supports Word section selection and opening in the installed app", () => {
    const onOpenInApp = vi.fn();
    render(<Viewer document={{ name: "plan.docx", kind: FileKind.Word, content: "Plan body", selection: ["Summary", "Details"] }} onClose={vi.fn()} onOpenInApp={onOpenInApp} />);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("Selected section: Details")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open in app" }));
    expect(onOpenInApp).toHaveBeenCalled();
  });
});
