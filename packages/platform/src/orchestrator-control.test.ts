import { describe, expect, it } from "vitest";
import { orchestratorMailbox } from "./orchestrator-control.js";

describe("orchestrator mailbox", () => {
  it("preserves FIFO order and can requeue early messages", () => {
    const taskId = "mailbox-test";
    orchestratorMailbox.clear(taskId);
    orchestratorMailbox.post({ id: "1", taskId, from: "user", content: "first", createdAt: "now" });
    orchestratorMailbox.post({ id: "2", taskId, from: "orchestrator", content: "second", createdAt: "now" });

    const drained = orchestratorMailbox.drain(taskId);
    orchestratorMailbox.requeue(taskId, drained);
    expect(orchestratorMailbox.drain(taskId).map((message) => message.content)).toEqual(["first", "second"]);
    orchestratorMailbox.clear(taskId);
  });
});
