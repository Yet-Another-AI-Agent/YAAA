import { describe, expect, it } from "vitest";
import { ModelTier } from "../enums/typing-bar.enums";
import type { TypingAttachment } from "../interfaces/typing-bar.interfaces";
import { TypingBarLibrary } from "./typing-bar-library";

const attachment: TypingAttachment = { id: "a", name: "brief.md", kind: "file", mimeType: "text/markdown", size: 10 };

describe("TypingBarLibrary", () => {
  it("stores text, model, and attachments in the send payload", () => {
    const library = new TypingBarLibrary();
    library.setText("  hello  ");
    library.setModelTier(ModelTier.StateOfArt);
    library.addAttachments([attachment]);
    expect(library.getAttachments()).toEqual([attachment]);
    expect(library.createSendPayload()).toEqual({ text: "hello", attachments: [attachment], modelTier: ModelTier.StateOfArt });
  });

  it("removes attachments and clears the composer state", () => {
    const library = new TypingBarLibrary(ModelTier.Base);
    library.addAttachments([attachment]);
    library.removeAttachment("a");
    expect(library.getAttachments()).toEqual([]);
    library.setText("message");
    library.clear();
    expect(library.createSendPayload()).toEqual({ text: "", attachments: [], modelTier: ModelTier.Base });
  });
});
