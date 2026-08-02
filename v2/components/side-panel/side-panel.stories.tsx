import type { Meta, StoryObj } from "@storybook/react";
import { SidePanel } from "./SidePanel";

const meta = { title: "v2/Right panel/Side Panel", component: SidePanel, args: { initialTabs: [{ id: "logs", title: "Researcher logs", content: [{ id: "one", title: "Latest event", content: "Scanning project files…" }] }, { id: "files", title: "Affected files", content: [{ id: "two", content: "src/runtime.ts" }] }] } } satisfies Meta<typeof SidePanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const BotDetails: Story = {};
