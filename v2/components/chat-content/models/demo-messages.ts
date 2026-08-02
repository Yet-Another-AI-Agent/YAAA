import { FormControlKind, InputTickType, MessageType } from "../enums/message.enums";
import type { MessageDraft } from "../interfaces/message.interfaces";

export function createDemoMessages(): MessageDraft[] {
  return [
    { type: MessageType.RequestMessage, userName: "User", typing: false, inputTickType: InputTickType.Single, messageBody: { kind: "text", text: "Please help me create the next version of my workspace." } },
    { type: MessageType.ResponseMessage, userName: "YAAA", typing: false, showInputTick: false, inputTickType: InputTickType.Double, messageBody: { kind: "text", text: "I’m ready to help you shape the next version of your workspace." } },
    { type: MessageType.AgentThought, userName: "YAAA", typing: true, inputTickType: InputTickType.Loading, messageBody: { kind: "text", text: "Thinking through the cleanest component boundary..." } },
    { type: MessageType.TaskCreationAgentMessage, userName: "YAAA", typing: false, inputTickType: InputTickType.Single, messageBody: { kind: "form", title: "Implementation plan ready", collapsible: true, controls: [{ id: "accept-plan", kind: FormControlKind.Button, label: "Accept plan" }, { id: "reject-plan", kind: FormControlKind.Button, label: "Reject plan" }], submitLabel: "Submit plan" } },
    { type: MessageType.PermissionAgentMessage, userName: "YAAA", typing: false, inputTickType: InputTickType.Single, messageBody: { kind: "form", title: "Allow workspace access?", collapsible: true, controls: [{ id: "scope", kind: FormControlKind.Radio, label: "This workspace", value: true }, { id: "remember", kind: FormControlKind.Checkbox, label: "Remember this choice", defaultValue: false }], submitLabel: "Allow access" } },
    { type: MessageType.SpecialAgentMessage, userName: "YAAA", typing: false, inputTickType: InputTickType.Single, messageBody: { kind: "file", file: { name: "implementation-plan.md", kind: "markdown", size: 18432, location: "/workspace/implementation-plan.md" } } },
    { type: MessageType.ResponseMessage, userName: "YAAA", typing: false, showInputTick: false, inputTickType: InputTickType.Single, messageBody: { kind: "response-review", title: "Review the response", content: "# Proposed response\n\nPlease review this answer line by line before approving it." } },
  ];
}
