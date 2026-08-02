import type { Meta, StoryObj } from "@storybook/react";
import { LeftBar } from "./LeftBar";

const meta = { title: "v2/Navigation/Left Bar", component: LeftBar, args: { initialProjects: [{ id: "workspace", name: "Workspace" }, { id: "docs", name: "Documentation" }], initialChats: [{ id: "one", title: "Implement right pane", projectId: "workspace" }, { id: "two", title: "Review tests", projectId: "workspace" }, { id: "three", title: "Temporary research", projectId: "temporary" }, { id: "four", title: "Unassigned chat" }] } } satisfies Meta<typeof LeftBar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ChatNavigation: Story = {};

