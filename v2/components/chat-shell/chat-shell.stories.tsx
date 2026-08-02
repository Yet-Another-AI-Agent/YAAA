import React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "@storybook/test";
import { ChatShell } from "./ChatShell";

const meta = { title: "v2/Chat/Shell", component: ChatShell, parameters: { layout: "fullscreen" }, args: { responseText: "This is a hardcoded YAAA response for the shell demo." } } satisfies Meta<typeof ChatShell>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Conversation: Story = {
  render: (args) => <div style={{ height: "100dvh", minHeight: 0 }}><ChatShell {...args} /></div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole("textbox", { name: "Message" }), "Test the fixed chat shell");
    await userEvent.click(canvas.getByRole("button", { name: "Send" }));
    await expect(canvas.getByLabelText("typing")).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 2200));
    await expect(canvas.getByText("This is a hardcoded YAAA response for the shell demo.")).toBeVisible();
    await expect(canvas.getByText("Test the fixed chat shell")).toBeVisible();
  },
};
