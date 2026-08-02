import { describe, expect, it } from "vitest";
import { MessageType } from "../enums/message.enums";
import { createDemoMessages } from "./demo-messages";

describe("createDemoMessages", () => {
  it("provides representative chat content for the standalone demo", () => {
    const messages = createDemoMessages();
    expect(messages).toHaveLength(7);
    expect(messages.map((message) => message.type)).toEqual([MessageType.RequestMessage, MessageType.ResponseMessage, MessageType.AgentThought, MessageType.TaskCreationAgentMessage, MessageType.PermissionAgentMessage, MessageType.SpecialAgentMessage, MessageType.ResponseMessage]);
    expect(messages[0]).toMatchObject({ userName: "User", messageBody: { kind: "text", text: "Please help me create the next version of my workspace." } });
    expect(messages.some((message) => message.messageBody.kind === "file")).toBe(true);
    expect(messages.find((message) => message.type === MessageType.TaskCreationAgentMessage)?.messageBody).toMatchObject({ kind: "form", title: "Implementation plan ready" });
    expect(messages.find((message) => message.type === MessageType.PermissionAgentMessage)?.messageBody).toMatchObject({ kind: "form", title: "Allow workspace access?" });
  });
});
