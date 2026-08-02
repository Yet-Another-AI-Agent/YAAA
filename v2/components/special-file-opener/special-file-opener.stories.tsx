import React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "@storybook/test";
import { FileKind } from "./enums/file.enums";
import { SpecialFileOpener } from "./SpecialFileOpener";

const meta = { title: "v2/Files/Special File Opener", component: SpecialFileOpener, args: { onOpen: fn() } } satisfies Meta<typeof SpecialFileOpener>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Image: Story = { args: { file: { name: "screenshot.png", kind: FileKind.Image, size: 24000 } } };
export const Presentation: Story = { args: { file: { name: "plan.pptx", kind: FileKind.Ppt, size: 204800, location: "/workspace/plan.pptx" } } };
export const Pdf: Story = { args: { file: { name: "approval.pdf", kind: FileKind.Pdf, size: 102400 } } };

export const OpensViewer: Story = {
  render: (args) => <SpecialFileOpener {...args} />,
  args: { file: { name: "approval.pdf", kind: FileKind.Pdf, size: 102400 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Open approval.pdf" }));
    await expect(canvas.getByRole("dialog", { name: "approval.pdf viewer" })).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Close viewer" }));
    await expect(canvas.queryByRole("dialog", { name: "approval.pdf viewer" })).toBeNull();
  },
};
