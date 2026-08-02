import React, { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "@storybook/test";
import { SplashScreen } from "./SplashScreen";

const meta = { title: "v2/Loading/Splash Screen", component: SplashScreen, parameters: { layout: "fullscreen" }, decorators: [(Story) => <div style={{ height: "100dvh", minHeight: 0 }}><Story /></div>], args: { onEvent: fn(), onSuccess: fn() } } satisfies Meta<typeof SplashScreen>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Loading: Story = { args: { progress: 42, message: "Loading bot definitions…" }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByText("Loading bot definitions…")).toBeVisible();
  await expect(canvas.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
} };
export const Failed: Story = { args: { progress: 64, status: "failed", errorMessage: "Could not connect to the workspace." }, play: async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByText("Could not connect to the workspace.")).toBeVisible();
  await expect(canvas.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  await expect(args.onEvent).toHaveBeenCalledWith({ kind: "failed", message: "Could not connect to the workspace." });
} };
export const Success: Story = { args: { progress: 100, status: "success", message: "Workspace ready" }, play: async ({ args }) => {
  await expect(args.onEvent).toHaveBeenCalledWith({ kind: "loaded-success" });
  await expect(args.onSuccess).toHaveBeenCalledTimes(1);
} };
export const JerkyInput: Story = { render: (args) => { const [progress, setProgress] = useState(8); return <div style={{ height: "100dvh" }}><SplashScreen {...args} progress={progress} message={`Receiving update at ${progress}%`} /><button type="button" onClick={() => setProgress((value) => value >= 92 ? 8 : value + 37)} style={{ position: "fixed", bottom: 20, left: 20 }}>Send uneven update</button></div>; }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Send uneven update" }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await expect(canvas.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow", "8");
} };
