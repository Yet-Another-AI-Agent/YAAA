import React, { createRef } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "@storybook/test";
import { TaskList } from "./TaskList";
import type { TaskListHandle } from "./interfaces/task-list.interfaces";

const meta = { title: "v2/Right panel/Task List", component: TaskList, args: { onEvent: fn(), initialSubtasks: [{ id: "ST-1", title: "Build the task panel", state: "running" as const, roles: ["Engineer"], capabilities: ["TypeScript"], microTasks: [{ id: "MT-1", title: "Create interfaces", state: "completed" as const }, { id: "MT-2", title: "Add tests", state: "running" as const }, { id: "MT-3", title: "Wire the right pane", state: "pending" as const }] }, { id: "ST-2", title: "Polish light and dark themes", state: "pending" as const, capabilities: ["CSS"] }] } } satisfies Meta<typeof TaskList>;
export default meta;
type Story = StoryObj<typeof meta>;
export const NestedTasks: Story = { render: (args) => <div style={{ width: 340, maxHeight: "100dvh" }}><TaskList {...args} /></div>, play: async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByText("Build the task panel")).toBeVisible();
  await expect(canvas.getAllByText("In progress")).not.toHaveLength(0);
  await expect(canvas.queryByRole("button", { name: "Complete Add tests" })).toBeNull();
} };
export const ImperativeUpdates: Story = { render: (args) => { const ref = createRef<TaskListHandle>(); return <div style={{ width: 340, maxHeight: "100dvh" }}><TaskList {...args} ref={ref} /><button type="button" onClick={() => ref.current?.addSubtask({ id: "ST-3", title: "New dynamically added subtask", state: "running", microTasks: [] })}>Add subtask</button></div>; }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Add subtask" }));
  await expect(canvas.getByText("New dynamically added subtask")).toBeVisible();
} };
