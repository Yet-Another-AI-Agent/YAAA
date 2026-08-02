import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BotHolderLibrary } from "../library/bot-holder-library";
import type { Bot, BotPatch } from "../interfaces/bot-holder.interfaces";

export function useBotHolderViewModel(initialBots: Bot[] = [], pageSize = 5) {
  const library = useMemo(() => new BotHolderLibrary(initialBots), []);
  const [bots, setBots] = useState(() => library.getBots());
  const [page, setPage] = useState(0);
  const refresh = useCallback(() => setBots(library.getBots()), [library]);
  const init = useCallback((nextBots: Bot[]) => { library.init(nextBots); setPage(0); refresh(); }, [library, refresh]);
  const addBot = useCallback((bot: Bot) => { library.addBot(bot); refresh(); }, [library, refresh]);
  const updateBot = useCallback((id: string, patch: BotPatch) => { library.updateBot(id, patch); refresh(); }, [library, refresh]);
  const activeBots = bots.filter((bot) => bot.status === "online" || bot.status === "waiting");
  const offlineBots = bots.filter((bot) => bot.status === "offline");
  const [tab, setTab] = useState<"active" | "offline">("active");
  const visibleBots = tab === "active" ? activeBots : offlineBots;
  const pageCount = Math.max(1, Math.ceil(visibleBots.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  useEffect(() => { if (page !== safePage) setPage(safePage); }, [page, safePage]);
  const pagedBots = visibleBots.slice(safePage * pageSize, (safePage + 1) * pageSize);
  return { bots, activeBots, offlineBots, tab, setTab, page: safePage, pageCount, pagedBots, setPage, init, addBot, updateBot };
}
