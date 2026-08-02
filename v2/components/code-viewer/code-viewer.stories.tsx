import React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { CodeDiffViewer } from "./CodeDiffViewer";
import { CodeViewer } from "./CodeViewer";
import { VsCodeDiffViewer } from "./VsCodeDiffViewer";

const code = `export function createMessage(input: MessageDraft) {\n  return { ...input, createdAt: Date.now() };\n}\n\nexport function renderMessage(message: ChatMessage) {\n  return message.messageBody;\n}`;
const meta = { title: "v2/Code/Viewer", component: CodeViewer, args: { content: code, language: "typescript", title: "message.models.ts" } } satisfies Meta<typeof CodeViewer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PartialCode: Story = { args: { previewLines: 3 } };
export const FullCode: Story = { args: { previewLines: 99 } };
export const Diff: Story = { render: () => <CodeDiffViewer title="message.models.ts" language="typescript" before={"return { ...input };"} after={"return { ...input, createdAt: Date.now() };"} /> };
export const VsCodeInlineDiff: Story = { render: () => <VsCodeDiffViewer title="message.models.ts" language="typescript" oldCode={`export function createMessage(input: MessageDraft) {
  return { ...input };
}

export function renderMessage(message: ChatMessage) {
  return message.messageBody;
}`} newCode={`export function createMessage(input: MessageDraft) {
  return { ...input, createdAt: Date.now() };
}

export function renderMessage(message: ChatMessage) {
  console.info("rendering", message.uuid);
  return message.messageBody;
}`} expandedHeight="78vh" /> };
