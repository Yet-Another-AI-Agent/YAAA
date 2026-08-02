import { describe, expect, it } from "vitest";
import { InputTickType, MessageType } from "../enums/message.enums";
import { createChatMessage } from "./message.models";

describe("createChatMessage", () => {
  it("normalizes defaults", () => {
    const message = createChatMessage({ type: MessageType.RequestMessage, userName: "User", messageBody: { kind: "text", text: "Hi" } }, "id", 100);
    expect(message).toMatchObject({ uuid: "id", typing: false, inputTickType: InputTickType.Single, createdAt: 100 });
  });

  it("preserves explicit values", () => {
    const message = createChatMessage({ type: MessageType.ResponseMessage, userName: "Agent", typing: true, inputTickType: InputTickType.Double, createdAt: 200, messageBody: { kind: "text", text: "Done" } }, "id", 100);
    expect(message).toMatchObject({ typing: true, inputTickType: InputTickType.Double, createdAt: 200 });
  });
});
