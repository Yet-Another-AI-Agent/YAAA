import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "@storybook/test";
import { ModelTier } from "./enums/typing-bar.enums";
import { TypingBar } from "./TypingBar";

const meta = {
  title: "v2/Chat/Typing Bar",
  component: TypingBar,
  parameters: { docs: { description: { component: "Standalone composer surface with attachments, voice recording, model selection, and send payloads." } } },
  args: { onSend: fn() },
} satisfies Meta<typeof TypingBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const WithStateOfArtModel: Story = {
  args: { initialModelTier: ModelTier.StateOfArt, placeholder: "Ask anything..." },
};

export const SendInteraction: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const message = canvas.getByRole("textbox", { name: "Message" });
    await userEvent.type(message, "Hello from Storybook");
    await userEvent.click(canvas.getByRole("button", { name: "Send" }));
    await expect(args.onSend).toHaveBeenCalledWith(expect.objectContaining({ text: "Hello from Storybook", attachments: [] }));
  },
};

export const Dark: Story = {
  parameters: { backgrounds: { default: "dark" } },
};
