import { describe, it, expect } from "vitest";
import { AgentControlMailbox } from "./agent-control.js";

describe("AgentControlMailbox", () => {
  it("queues and drains directives in FIFO order per agent", () => {
    const mailbox = new AgentControlMailbox();
    mailbox.post("a1", { type: "extend", additionalMs: 1000 });
    mailbox.post("a1", { type: "redirect", handsOn: "do X" });
    mailbox.post("a2", { type: "stop", reason: "done" });

    expect(mailbox.hasPending("a1")).toBe(true);
    const drained = mailbox.drain("a1");
    expect(drained).toEqual([
      { type: "extend", additionalMs: 1000 },
      { type: "redirect", handsOn: "do X" },
    ]);
    // a2 is isolated from a1's drain.
    expect(mailbox.drain("a2")).toEqual([{ type: "stop", reason: "done" }]);
  });

  it("empties the mailbox after draining", () => {
    const mailbox = new AgentControlMailbox();
    mailbox.post("a1", { type: "extend", additionalMs: 500 });
    expect(mailbox.drain("a1")).toHaveLength(1);
    expect(mailbox.hasPending("a1")).toBe(false);
    expect(mailbox.drain("a1")).toEqual([]);
  });

  it("returns an empty array for an unknown agent and clears on demand", () => {
    const mailbox = new AgentControlMailbox();
    expect(mailbox.drain("nobody")).toEqual([]);
    mailbox.post("a1", { type: "stop" });
    mailbox.clear("a1");
    expect(mailbox.hasPending("a1")).toBe(false);
  });
});
