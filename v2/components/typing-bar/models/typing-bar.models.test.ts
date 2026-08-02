import { describe, expect, it } from "vitest";
import { ModelTier } from "../enums/typing-bar.enums";
import { createTypingBarState } from "./typing-bar.models";

describe("createTypingBarState", () => {
  it("creates an empty state for the selected model", () => {
    expect(createTypingBarState(ModelTier.StateOfArt)).toEqual({ text: "", attachments: [], modelTier: ModelTier.StateOfArt });
  });
});
