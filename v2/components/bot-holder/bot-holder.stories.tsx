import React, { useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { BotHolder } from "./BotHolder";
import { BotStatus, type BotHolderHandle } from "./interfaces/bot-holder.interfaces";

const bots = Array.from({ length: 9 }, (_, index) => ({ id: `bot-${index}`, name: ["YAAA", "Researcher", "Coder", "Reviewer", "Tester", "Docs", "Planner", "Browser", "Verifier"][index], status: index === 7 || index === 8 ? BotStatus.Offline : index === 5 ? BotStatus.Waiting : BotStatus.Online, role: index === 0 ? "Orchestrator" : "Sub-agent", model: "gpt-5", contextWindow: { used: [620, 280, 740, 150, 480, 320, 880, 0, 0][index], limit: 1000, unit: "tokens" } }));

const meta = { title: "v2/Chat/Bot Holder", component: BotHolder, args: { initialBots: bots } } satisfies Meta<typeof BotHolder>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MissionTeam: Story = {};

export const ImperativeUpdates: Story = {
  render: (args) => {
    const ref = useRef<BotHolderHandle>(null);
    return <div><BotHolder {...args} ref={ref} /><button type="button" style={{ marginTop: 12 }} onClick={() => ref.current?.updateBot("bot-1", { status: BotStatus.Offline, contextWindow: { used: 940 } })}>Mark Researcher offline</button></div>;
  },
};
