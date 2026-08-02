// @vitest-environment jsdom
import React, { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotHolder } from "./BotHolder";
import { BotStatus, type Bot, type BotHolderHandle } from "./interfaces/bot-holder.interfaces";

const bots: Bot[] = Array.from({ length: 7 }, (_, index) => ({ id: `bot-${index}`, name: `Bot ${index}`, status: index === 6 ? BotStatus.Offline : index === 5 ? BotStatus.Waiting : BotStatus.Online, role: "Worker", model: "model-v2", contextWindow: { used: index * 100, limit: 1000 } }));

describe("BotHolder", () => {
  afterEach(cleanup);

  it("groups active bots, shows context progress, and paginates after five", () => {
    render(<BotHolder initialBots={bots} />);
    expect(screen.getByRole("tab", { name: /Online & waiting 6/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Bot 0")).toBeInTheDocument();
    expect(screen.getByText("Bot 4")).toBeInTheDocument();
    expect(screen.queryByText("Bot 5")).toBeNull();
    expect(screen.getByRole("progressbar", { name: "Bot 4 context window" })).toHaveAttribute("aria-valuenow", "400");
    fireEvent.click(screen.getByRole("button", { name: "Next bots" }));
    expect(screen.getByText("Bot 5")).toBeInTheDocument();
  });

  it("moves a bot between tabs when its status changes", () => {
    const ref = createRef<BotHolderHandle>();
    render(<BotHolder ref={ref} initialBots={bots} />);
    act(() => ref.current?.updateBot("bot-0", { status: BotStatus.Offline, contextWindow: { used: 800 } }));
    fireEvent.click(screen.getByRole("tab", { name: /Offline 2/ }));
    expect(screen.getByText("Bot 0")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Bot 0 context window" })).toHaveAttribute("aria-valuenow", "800");
  });

  it("supports init and add through its imperative handle", () => {
    const ref = createRef<BotHolderHandle>();
    render(<BotHolder ref={ref} />);
    act(() => ref.current?.init([bots[0]]));
    expect(screen.getByText("Bot 0")).toBeInTheDocument();
    act(() => ref.current?.addBot(bots[1]));
    expect(screen.getByText("Bot 1")).toBeInTheDocument();
  });

  it("emits when a mission team bot is clicked", () => {
    const onBotClick = vi.fn();
    const onEvent = vi.fn();
    render(<BotHolder initialBots={bots} onBotClick={onBotClick} onEvent={onEvent} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Bot 0" }));
    expect(onBotClick).toHaveBeenCalledWith(bots[0]);
    expect(onEvent).toHaveBeenCalledWith({ kind: "bot-open", action: "open", bot: bots[0] });
  });
});
