import { useRef, useState } from "react";
import { TaskModel } from "../models/TaskModel";

export interface AnnotationBox {
  x: number;
  y: number;
  width: number;
  height: number;
  comment: string;
}

interface AnnotationOverlayProps {
  taskId: string;
  artifactPath: string;
  onClose: () => void;
}

/**
 * Canvas-commenter: a drag layer over the artifact preview. Users draw
 * bounding boxes, attach comments, and send the JSON payload to
 * @orchestrator, which forwards the visual fix to the owning agent.
 */
export function AnnotationOverlay({ taskId, artifactPath, onClose }: AnnotationOverlayProps) {
  const [boxes, setBoxes] = useState<AnnotationBox[]>([]);
  const [draft, setDraft] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  const pointFromEvent = (e: React.MouseEvent) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return {
      x: Math.max(0, e.clientX - (rect?.left ?? 0)),
      y: Math.max(0, e.clientY - (rect?.top ?? 0)),
    };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (draft) return; // finish the pending comment first
    dragStartRef.current = pointFromEvent(e);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const start = dragStartRef.current;
    if (!start) return;
    const point = pointFromEvent(e);
    setDraft({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    });
  };

  const handleMouseUp = () => {
    dragStartRef.current = null;
    // Discard accidental clicks with no real area.
    setDraft((current) =>
      current && current.width >= 4 && current.height >= 4 ? current : null,
    );
  };

  const addAnnotation = () => {
    if (!draft || !comment.trim()) return;
    setBoxes((prev) => [...prev, { ...draft, comment: comment.trim() }]);
    setDraft(null);
    setComment("");
  };

  const sendFeedback = async () => {
    if (boxes.length === 0 || status === "sending") return;
    setStatus("sending");
    try {
      await TaskModel.saveArtifactAnnotations(taskId, artifactPath, boxes);
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="annotation-overlay" data-testid="annotation-overlay">
      <div
        ref={surfaceRef}
        className="annotation-surface"
        data-testid="annotation-surface"
        role="application"
        aria-label="Draw a box over the area you want to comment on"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        {boxes.map((box, index) => (
          <div
            key={`${box.x}-${box.y}-${index}`}
            className="annotation-box"
            style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
            title={box.comment}
          >
            <span className="annotation-box-index">{index + 1}</span>
          </div>
        ))}
        {draft && (
          <div
            className="annotation-box draft"
            style={{ left: draft.x, top: draft.y, width: draft.width, height: draft.height }}
          />
        )}
      </div>

      <div className="annotation-toolbar">
        {draft ? (
          <>
            <input
              className="annotation-comment-input"
              placeholder="Describe the visual fix…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              aria-label="Annotation comment"
            />
            <button type="button" className="btn-approve" onClick={addAnnotation} disabled={!comment.trim()}>
              Add comment
            </button>
            <button type="button" className="btn-reject" onClick={() => setDraft(null)}>
              Discard
            </button>
          </>
        ) : (
          <>
            <span className="annotation-hint">
              {boxes.length === 0
                ? "Drag a box over the preview to comment on it."
                : `${boxes.length} annotation${boxes.length === 1 ? "" : "s"} ready.`}
            </span>
            <button
              type="button"
              className="btn-approve"
              onClick={sendFeedback}
              disabled={boxes.length === 0 || status === "sending" || status === "sent"}
            >
              {status === "sent" ? "Sent to @orchestrator ✓" : status === "sending" ? "Sending…" : "Send to @orchestrator"}
            </button>
            <button type="button" className="btn-reject" onClick={onClose}>
              Done
            </button>
          </>
        )}
        {status === "error" && (
          <span className="annotation-error" role="alert">Could not send feedback — try again.</span>
        )}
      </div>
    </div>
  );
}
