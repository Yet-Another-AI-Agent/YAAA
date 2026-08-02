import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { ResponseReview } from "./ResponseReview";

const meta = { title: "v2/Interaction/Response Review", component: ResponseReview, args: { title: "Plan proposal", content: "# Proposed change\n\nReview the plan line by line before approving it.", onSubmit: fn() } } satisfies Meta<typeof ResponseReview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Approval: Story = {};
