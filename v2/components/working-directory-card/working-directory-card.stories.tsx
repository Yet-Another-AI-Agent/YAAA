import React, { useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { WorkingDirectoryCard } from "./WorkingDirectoryCard";
import type { WorkingDirectoryCardHandle, WorkingFolder } from "./interfaces/working-directory-card.interfaces";

const folders: WorkingFolder[] = [
  { id: "space", name: "Project folder", path: "tasks/demo/working", kind: "agent-space", taskId: "demo", itemCount: 24, children: [{ id: "src", name: "src", path: "src", type: "folder", children: [{ id: "runtime", name: "runtime.ts", path: "src/runtime.ts", type: "file", change: "modified" }] }, { id: "root-1", name: "package.json", type: "file", change: "modified" }] },
  ...["Researcher", "Coder", "Reviewer", "Tester", "Docs", "Browser"].map((name, index) => ({ id: `agent-${index}`, name, path: `agent-workspaces/${name.toLowerCase()}`, kind: "agent-working" as const, taskId: "demo", agentId: name.toLowerCase(), agentName: name, itemCount: index + 2, children: [{ id: `${name}-folder`, name: "research", path: "research", type: "folder" as const, children: [{ id: `${name}-1`, name: "notes.md", change: "created" as const, type: "file" as const }] }] })),
];

const meta = { title: "v2/Right panel/Working Directory Card", component: WorkingDirectoryCard, args: { initialFolders: folders } } satisfies Meta<typeof WorkingDirectoryCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AgentFolders: Story = {};
export const ImperativeUpdates: Story = { render: (args) => { const ref = useRef<WorkingDirectoryCardHandle>(null); return <div><WorkingDirectoryCard {...args} ref={ref} onOpenFolder={(folder) => console.log("open folder", folder)} /><button type="button" style={{ marginTop: 12 }} onClick={() => ref.current?.updateFolder("agent-0", { name: "Research queue" })}>Rename Researcher</button></div>; } };
