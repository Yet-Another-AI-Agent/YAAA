import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "@storybook/test";
import { CreateChat } from "./CreateChat";
import { FormControlKind, MessageType } from "./enums/message.enums";
import type { MessageDraft } from "./interfaces/message.interfaces";
import { createDemoMessages } from "./models/demo-messages";

const interactiveForm: MessageDraft = {
  type: MessageType.PermissionAgentMessage,
  userName: "YAAA",
  messageBody: {
    kind: "form",
    title: "Allow workspace access?",
    controls: [
      { id: "scope", kind: FormControlKind.Radio, label: "This workspace", value: true },
      { id: "remember", kind: FormControlKind.Checkbox, label: "Remember this choice", defaultValue: false },
    ],
    submitLabel: "Allow access",
  },
};

const meta = {
  title: "v2/Chat/Content",
  component: CreateChat,
  parameters: { docs: { description: { component: "Standalone chat message content. Headers, footers, and the composer are intentionally separate components." } } },
  args: { onEvent: fn() },
} satisfies Meta<typeof CreateChat>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Conversation: Story = {
  args: { initialMessages: createDemoMessages() },
};

export const Empty: Story = {
  args: { initialMessages: [] },
};

export const SpecialForm: Story = {
  args: { initialMessages: [interactiveForm] },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("checkbox", { name: "Remember this choice" }));
    await userEvent.click(canvas.getByRole("button", { name: "Allow access" }));
    await expect(args.onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "control-change", controlId: "remember", value: true }));
    await expect(args.onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "form-action", action: "submit", messageData: expect.objectContaining({ messageBody: expect.objectContaining({ submitted: true }) }) }));
  },
};

export const DarkConversation: Story = {
  args: { initialMessages: createDemoMessages() },
  parameters: { backgrounds: { default: "dark" } },
};
