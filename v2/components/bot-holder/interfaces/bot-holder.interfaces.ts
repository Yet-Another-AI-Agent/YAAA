export const BotStatus = {
  Online: "online",
  Waiting: "waiting",
  Offline: "offline",
} as const;

export type BotStatus = typeof BotStatus[keyof typeof BotStatus];

export interface BotContextWindow {
  used: number;
  limit: number;
  unit?: string;
}

export interface Bot {
  id: string;
  name: string;
  status: BotStatus;
  contextWindow: BotContextWindow;
  avatarUrl?: string;
  role?: string;
  model?: string;
}

export type BotPatch = Partial<Omit<Bot, "id" | "contextWindow">> & {
  contextWindow?: Partial<BotContextWindow>;
};

export interface BotHolderHandle {
  init: (bots: Bot[]) => void;
  addBot: (bot: Bot) => void;
  updateBot: (id: string, patch: BotPatch) => void;
}

export interface BotHolderProps {
  initialBots?: Bot[];
  pageSize?: number;
  className?: string;
  onBotClick?: (bot: Bot) => void;
  onEvent?: (event: BotHolderEvent) => void;
}

export interface BotHolderEvent {
  kind: "bot-open";
  action: "open";
  bot: Bot;
}
