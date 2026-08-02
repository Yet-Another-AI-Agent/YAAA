import React, { forwardRef, useImperativeHandle } from "react";
import type { Bot, BotHolderHandle, BotHolderProps } from "./interfaces/bot-holder.interfaces";
import { useBotHolderViewModel } from "./viewmodels/useBotHolderViewModel";
import { Tabs } from "../tabs/Tabs";
import "./bot-holder.css";
import "./bot-holder-interactions.css";

export const BotHolder = forwardRef<BotHolderHandle, BotHolderProps>(function BotHolder({ initialBots = [], pageSize = 5, className = "", onBotClick, onEvent }, ref) {
  const viewModel = useBotHolderViewModel(initialBots, pageSize);
  useImperativeHandle(ref, () => ({ init: viewModel.init, addBot: viewModel.addBot, updateBot: viewModel.updateBot }), [viewModel.addBot, viewModel.init, viewModel.updateBot]);
  const activeCount = viewModel.activeBots.length;
  return <aside className={`v2-bot-holder ${className}`} aria-label="Bot holder">
    <div className="v2-bot-holder-header"><div><strong>Mission team</strong><small>{viewModel.bots.length} bot{viewModel.bots.length === 1 ? "" : "s"}</small></div><span className="v2-bot-holder-live"><i /> Live</span></div>
    <Tabs<"active" | "offline"> value={viewModel.tab} onChange={viewModel.setTab} ariaLabel="Bot status" tabs={[{ id: "active", label: "Online & waiting", count: activeCount }, { id: "offline", label: "Offline", count: viewModel.offlineBots.length }]} />
    <div className="v2-bot-holder-list" role="tabpanel">{viewModel.pagedBots.length === 0 ? <div className="v2-bot-holder-empty">No {viewModel.tab === "active" ? "online or waiting" : "offline"} bots.</div> : viewModel.pagedBots.map((bot) => <BotRow bot={bot} onBotClick={onBotClick} onEvent={onEvent} key={bot.id} />)}</div>
    {viewModel.pageCount > 1 && <nav className="v2-bot-holder-pagination" aria-label="Bot pagination"><button type="button" aria-label="Previous bots" disabled={viewModel.page === 0} onClick={() => viewModel.setPage(viewModel.page - 1)}>‹</button><span>Page {viewModel.page + 1} of {viewModel.pageCount}</span><button type="button" aria-label="Next bots" disabled={viewModel.page >= viewModel.pageCount - 1} onClick={() => viewModel.setPage(viewModel.page + 1)}>›</button></nav>}
  </aside>;
});

function BotRow({ bot, onBotClick, onEvent }: { bot: Bot; onBotClick?: (bot: Bot) => void; onEvent?: BotHolderProps["onEvent"] }) {
  const percent = bot.contextWindow.limit > 0 ? Math.min(100, Math.max(0, (bot.contextWindow.used / bot.contextWindow.limit) * 100)) : 0;
  const unit = bot.contextWindow.unit ?? "tokens";
  const handleClick = () => { onEvent?.({ kind: "bot-open", action: "open", bot }); onBotClick?.(bot); };
  return <button type="button" className="v2-bot-row" aria-label={`Open ${bot.name}`} onClick={handleClick}><span className={`v2-bot-status v2-bot-status-${bot.status}`} aria-label={bot.status} /><div className="v2-bot-avatar">{bot.avatarUrl ? <img src={bot.avatarUrl} alt="" /> : bot.name.slice(0, 1).toUpperCase()}</div><div className="v2-bot-identity"><strong>{bot.name}</strong><span>{bot.role ?? bot.status}</span><div className="v2-bot-context"><div className="v2-bot-context-label"><small>Context window</small><small>{bot.contextWindow.used.toLocaleString()} / {bot.contextWindow.limit.toLocaleString()} {unit}</small></div><div className="v2-bot-progress" role="progressbar" aria-label={`${bot.name} context window`} aria-valuemin={0} aria-valuemax={bot.contextWindow.limit} aria-valuenow={bot.contextWindow.used}><span style={{ width: `${percent}%` }} /></div></div>{bot.model && <small className="v2-bot-model">{bot.model}</small>}</div></button>;
}
