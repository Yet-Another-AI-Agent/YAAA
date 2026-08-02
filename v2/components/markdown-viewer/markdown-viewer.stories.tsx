import type { Meta, StoryObj } from "@storybook/react";
import { MarkdownViewer } from "./MarkdownViewer";

const longMarkdown = "# Implementation plan\n\n" + "This section explains the proposed implementation and verification details.\n\n".repeat(12);
const meta = { title: "v2/Content/Markdown Viewer", component: MarkdownViewer, args: { title: "implementation-plan.md" } } satisfies Meta<typeof MarkdownViewer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PartialDocument: Story = { args: { content: longMarkdown } };
export const ShortDocument: Story = { args: { content: "# Ready\n\nThis Markdown stays inline." } };
