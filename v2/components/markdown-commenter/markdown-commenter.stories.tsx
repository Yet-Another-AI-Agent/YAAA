import type { Meta, StoryObj } from "@storybook/react";
import { MarkdownCommenter } from "./MarkdownCommenter";

const meta = { title: "v2/Content/Markdown Commenter", component: MarkdownCommenter, args: { title: "implementation-plan.md", content: "# Plan\n\nReview the proposed architecture.\n\n## Verification\n\nAdd unit and screenshot tests." } } satisfies Meta<typeof MarkdownCommenter>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Review: Story = {};
