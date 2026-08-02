import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "./Button";

const meta = { title: "v2/Foundations/Buttons", component: Button, args: { children: "Continue" } } satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Primary: Story = { args: { variant: "primary" } };
export const Secondary: Story = { args: { variant: "secondary" } };
