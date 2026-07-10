// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskModel } from "../models/TaskModel";
import { AnnotationOverlay } from "./AnnotationOverlay";

vi.mock("../models/TaskModel", () => ({
  TaskModel: {
    saveArtifactAnnotations: vi
      .fn()
      .mockResolvedValue({ annotationPath: "/tmp/a.json", routes: [] }),
  },
}));

function drawBox(surface: HTMLElement, from: [number, number], to: [number, number]) {
  fireEvent.mouseDown(surface, { clientX: from[0], clientY: from[1] });
  fireEvent.mouseMove(surface, { clientX: to[0], clientY: to[1] });
  fireEvent.mouseUp(surface);
}

describe("AnnotationOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures a dragged bounding box, a comment, and sends the payload to the orchestrator", async () => {
    render(
      <AnnotationOverlay taskId="task-1" artifactPath="pamphlet.md" onClose={vi.fn()} />,
    );

    const surface = screen.getByTestId("annotation-surface");
    drawBox(surface, [10, 20], [110, 80]);

    fireEvent.change(screen.getByLabelText("Annotation comment"), {
      target: { value: "Logo is misaligned" },
    });
    fireEvent.click(screen.getByText("Add comment"));
    expect(screen.getByText("1 annotation ready.")).toBeTruthy();

    fireEvent.click(screen.getByText("Send to @orchestrator"));
    expect(TaskModel.saveArtifactAnnotations).toHaveBeenCalledWith(
      "task-1",
      "pamphlet.md",
      [{ x: 10, y: 20, width: 100, height: 60, comment: "Logo is misaligned" }],
    );
    expect(await screen.findByText("Sent to @orchestrator ✓")).toBeTruthy();
  });

  it("discards accidental clicks that have no drawn area", () => {
    render(
      <AnnotationOverlay taskId="task-1" artifactPath="pamphlet.md" onClose={vi.fn()} />,
    );

    const surface = screen.getByTestId("annotation-surface");
    drawBox(surface, [10, 10], [11, 11]);

    expect(screen.queryByLabelText("Annotation comment")).toBeNull();
    expect(screen.getByText(/Drag a box over the preview/)).toBeTruthy();
  });

  it("cannot send with zero annotations and closes via Done", () => {
    const onClose = vi.fn();
    render(
      <AnnotationOverlay taskId="task-1" artifactPath="pamphlet.md" onClose={onClose} />,
    );

    const send = screen.getByText("Send to @orchestrator") as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.click(screen.getByText("Done"));
    expect(onClose).toHaveBeenCalled();
    expect(TaskModel.saveArtifactAnnotations).not.toHaveBeenCalled();
  });

  it("surfaces a send failure without losing the annotations", async () => {
    vi.mocked(TaskModel.saveArtifactAnnotations).mockRejectedValueOnce(
      new Error("offline"),
    );
    render(
      <AnnotationOverlay taskId="task-1" artifactPath="pamphlet.md" onClose={vi.fn()} />,
    );

    drawBox(screen.getByTestId("annotation-surface"), [0, 0], [50, 50]);
    fireEvent.change(screen.getByLabelText("Annotation comment"), {
      target: { value: "Fix spacing" },
    });
    fireEvent.click(screen.getByText("Add comment"));
    fireEvent.click(screen.getByText("Send to @orchestrator"));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("1 annotation ready.")).toBeTruthy();
  });
});
