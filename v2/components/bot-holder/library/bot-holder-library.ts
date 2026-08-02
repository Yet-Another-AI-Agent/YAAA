import type { Bot, BotPatch } from "../interfaces/bot-holder.interfaces";

export class BotHolderLibrary {
  private bots: Bot[];

  public constructor(initialBots: Bot[] = []) {
    this.bots = initialBots.map((bot) => ({ ...bot, contextWindow: { ...bot.contextWindow } }));
  }

  public init(bots: Bot[]): void {
    this.bots = bots.map((bot) => ({ ...bot, contextWindow: { ...bot.contextWindow } }));
  }

  public addBot(bot: Bot): void {
    const existingIndex = this.bots.findIndex((item) => item.id === bot.id);
    if (existingIndex >= 0) {
      this.bots[existingIndex] = { ...bot, contextWindow: { ...bot.contextWindow } };
      return;
    }
    this.bots = [...this.bots, { ...bot, contextWindow: { ...bot.contextWindow } }];
  }

  public updateBot(id: string, patch: BotPatch): void {
    this.bots = this.bots.map((bot) => bot.id !== id ? bot : {
      ...bot,
      ...patch,
      contextWindow: { ...bot.contextWindow, ...patch.contextWindow },
    });
  }

  public getBots(): Bot[] {
    return this.bots.map((bot) => ({ ...bot, contextWindow: { ...bot.contextWindow } }));
  }
}
