// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArchitectureViewer, getMediaKind } from "./ArchitectureViewer";

const renderMock = vi.fn();
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: (...args: unknown[]) => renderMock(...args),
  },
}));

describe("getMediaKind", () => {
  it.each([
    ["diagram.mmd", "diagram"],
    ["arch.mermaid", "diagram"],
    ["logo.png", "image"],
    ["photo.JPG", "image"],
    ["notes.md", "text"],
    ["report.txt", "text"],
  ])("classifies %s as %s", (file, kind) => {
    expect(getMediaKind(file)).toBe(kind);
  });
});

describe("ArchitectureViewer", () => {
  beforeEach(() => {
    renderMock.mockReset();
  });

  it("renders the mermaid SVG output for graphTD source", async () => {
    renderMock.mockResolvedValue({ svg: "<svg data-diagram='ok'></svg>" });

    render(<ArchitectureViewer source={"graph TD\nA-->B"} />);
    expect(screen.getByTestId("diagram-loading")).toBeTruthy();

    const viewer = await screen.findByTestId("architecture-viewer");
    expect(viewer.innerHTML).toContain('data-diagram="ok"');
    expect(renderMock).toHaveBeenCalledWith(
      expect.stringContaining("graphtd-"),
      "graph TD\nA-->B",
    );
  });

  it("falls back to the raw source when rendering fails", async () => {
    renderMock.mockRejectedValue(new Error("bad syntax"));

    render(<ArchitectureViewer source={"graph TD\nbroken"} />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/bad syntax/)).toBeTruthy();
    expect(screen.getByText(/graph TD/)).toBeTruthy();
  });
});
