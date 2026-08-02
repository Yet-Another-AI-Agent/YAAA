import { describe, expect, it } from "vitest";
import { BotStatus } from "../interfaces/bot-holder.interfaces";
import { BotHolderLibrary } from "./bot-holder-library";

const bot = (id: string) => ({ id, name: id, status: BotStatus.Offline, contextWindow: { used: 0, limit: 100 } });

describe("BotHolderLibrary", () => {
  it("initializes and adds bots", () => {
    const library = new BotHolderLibrary([bot("one")]);
    library.addBot(bot("two"));
    expect(library.getBots().map((item) => item.id)).toEqual(["one", "two"]);
  });

  it("updates status and nested context window without losing other fields", () => {
    const library = new BotHolderLibrary([{ ...bot("one"), name: "Researcher", role: "Research" }]);
    library.updateBot("one", { status: BotStatus.Online, contextWindow: { used: 42 } });
    expect(library.getBots()[0]).toMatchObject({ name: "Researcher", role: "Research", status: BotStatus.Online, contextWindow: { used: 42, limit: 100 } });
  });

  it("replaces the collection through init", () => {
    const library = new BotHolderLibrary([bot("old")]);
    library.init([bot("new")]);
    expect(library.getBots().map((item) => item.id)).toEqual(["new"]);
  });
});
