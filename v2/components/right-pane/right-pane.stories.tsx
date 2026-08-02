import React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { RightPane } from "./RightPane";

const meta = { title: "v2/Right panel/Right Pane", component: RightPane, args: { initialSubtasks: [{ id: "ST-1", title: "Build the task panel", state: "running" as const, roles: ["Engineer"], capabilities: ["TypeScript"], microTasks: [{ id: "MT-1", title: "Create interfaces", state: "completed" as const }, { id: "MT-2", title: "Add tests", state: "running" as const }] }], initialBots: [{ id: "researcher", name: "Researcher", status: "online" as const, contextWindow: { used: 420, limit: 1000 }, role: "Worker", model: "gpt-5" }], initialFolders: [{ id: "project", name: "Project folder", path: "/project", kind: "agent-space" as const, children: [{ id: "src", name: "src", path: "/project/src", type: "folder" as const, children: [{ id: "file", name: "runtime.ts", path: "/project/src/runtime.ts", type: "file" as const, change: "modified" as const }] }] }] } } satisfies Meta<typeof RightPane>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Workspace: Story = {};
