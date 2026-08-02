export const MessageType = {
  RequestMessage: "RequestMessage",
  ResponseMessage: "ResponseMessage",
  AgentThought: "AgentThought",
  SpecialAgentMessage: "SpecialAgentMessage",
  SpecialUserMessage: "SpecialUserMessage",
  TaskCreationAgentMessage: "TaskCreationAgentMessage",
  PermissionAgentMessage: "PermissionAgentMessage",
  QuestionAgentMessage: "QuestionAgentMessage",
} as const;
export type MessageType = typeof MessageType[keyof typeof MessageType];

export const InputTickType = {
  Loading: "Loading",
  Single: "Single",
  Double: "Double",
} as const;
export type InputTickType = typeof InputTickType[keyof typeof InputTickType];

export const ViewerKind = {
  Vscode: "vscode",
  Pdf: "pdf",
  Word: "word",
  Ppt: "ppt",
} as const;
export type ViewerKind = typeof ViewerKind[keyof typeof ViewerKind];

export const FormControlKind = {
  Checkbox: "checkbox",
  Radio: "radio",
  Textfield: "textfield",
  Button: "button",
} as const;
export type FormControlKind = typeof FormControlKind[keyof typeof FormControlKind];
