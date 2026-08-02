import { describe, expect, it } from "vitest";
import { AttachmentKind } from "../enums/typing-bar.enums";
import { attachmentKindForMime, createTypingAttachment, formatAttachmentSize, nextListPrefix } from "./typing-bar.utils";

describe("typing bar utilities", () => {
  it("classifies media and preserves selected kinds for other files", () => {
    expect(attachmentKindForMime("image/png", AttachmentKind.File)).toBe(AttachmentKind.Image);
    expect(attachmentKindForMime("video/mp4", AttachmentKind.File)).toBe(AttachmentKind.Video);
    expect(attachmentKindForMime("audio/webm", AttachmentKind.File)).toBe(AttachmentKind.Audio);
    expect(attachmentKindForMime("text/plain", AttachmentKind.Folder)).toBe(AttachmentKind.Folder);
  });

  it("creates attachments and formats sizes", () => {
    const file = new Blob(["hello"], { type: "text/plain" });
    expect(createTypingAttachment(file, AttachmentKind.File, "hello.txt")).toMatchObject({ name: "hello.txt", kind: AttachmentKind.File, mimeType: "text/plain", size: 5 });
    expect(createTypingAttachment(new Blob(["raw"]), AttachmentKind.File).mimeType).toBe("application/octet-stream");
    expect(formatAttachmentSize(5)).toBe("5 B");
    expect(formatAttachmentSize(2048)).toBe("2 KB");
    expect(formatAttachmentSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("continues bullets, numbered lists, and indentation", () => {
    expect(nextListPrefix("- first")).toBe("- ");
    expect(nextListPrefix("  * nested")).toBe("  * ");
    expect(nextListPrefix("  9) ninth")).toBe("  10. ");
    expect(nextListPrefix("plain text")).toBeUndefined();
  });
});
