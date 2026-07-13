import { describe, it, expect, beforeEach, vi } from "vitest";
import { container } from "@yaaa/platform";
import type { IMeshGateway } from "@yaaa/interfaces";
import { SupervisorAssessor } from "./supervisor-assessor.js";

const ctx = {
  missionGoal: "Build a deck",
  subtaskTitle: "Draft slides",
  successCriteria: "5 slides with notes",
  checkpointSummary: "3 of 5 slides drafted.",
  artifacts: [{ path: "deck.pptx", description: "wip deck" }],
  continuations: 1,
  maxContinuations: 20,
};

describe("SupervisorAssessor", () => {
  let gateway: { chat: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    container.clear();
    gateway = { chat: vi.fn() };
    container.register("IMeshGateway", gateway as unknown as IMeshGateway);
  });

  it("parses a continue decision", async () => {
    gateway.chat.mockResolvedValue({ content: '{"action":"continue","reason":"good progress"}' });
    const decision = await new SupervisorAssessor().assess("t1", ctx);
    expect(decision.action).toBe("continue");
    expect(gateway.chat).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ modelRole: "utility" }));
  });

  it("parses a redirect decision and carries the handsOn", async () => {
    gateway.chat.mockResolvedValue({
      content: '```json\n{"action":"redirect","handsOn":"finish slides 4-5","reason":"off track"}\n```',
    });
    const decision = await new SupervisorAssessor().assess("t1", ctx);
    expect(decision.action).toBe("redirect");
    expect(decision.handsOn).toBe("finish slides 4-5");
  });

  it("downgrades a redirect with no instructions to continue", async () => {
    gateway.chat.mockResolvedValue({ content: '{"action":"redirect","reason":"unclear"}' });
    const decision = await new SupervisorAssessor().assess("t1", ctx);
    expect(decision.action).toBe("continue");
  });

  it("defaults to continue when the model output is unparseable", async () => {
    gateway.chat.mockResolvedValue({ content: "not json at all" });
    const decision = await new SupervisorAssessor().assess("t1", ctx);
    expect(decision.action).toBe("continue");
  });

  it("degrades to continue when no gateway is registered", async () => {
    container.clear();
    const decision = await new SupervisorAssessor().assess("t1", ctx);
    expect(decision.action).toBe("continue");
  });
});
