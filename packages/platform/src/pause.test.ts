import { describe, expect, it } from "vitest";
import { PauseController } from "./pause.js";

describe("PauseController", () => {
  it("waitIfPaused resolves immediately for an unpaused agent", async () => {
    const controller = new PauseController();
    await expect(controller.waitIfPaused("agent-1")).resolves.toBeUndefined();
  });

  it("blocks a paused agent until resume, then releases every waiter", async () => {
    const controller = new PauseController();
    controller.pause("agent-1");
    expect(controller.isPaused("agent-1")).toBe(true);
    expect(controller.pausedAgents()).toEqual(["agent-1"]);

    let released = 0;
    const waiters = [
      controller.waitIfPaused("agent-1").then(() => released++),
      controller.waitIfPaused("agent-1").then(() => released++),
    ];
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(released).toBe(0);

    expect(controller.resume("agent-1")).toBe(true);
    await Promise.all(waiters);
    expect(released).toBe(2);
    expect(controller.isPaused("agent-1")).toBe(false);
  });

  it("pause is idempotent and resume reports false for unpaused agents", async () => {
    const controller = new PauseController();
    controller.pause("agent-1");
    const wait = controller.waitIfPaused("agent-1");
    controller.pause("agent-1"); // second pause must not orphan the first waiter
    expect(controller.resume("agent-1")).toBe(true);
    await expect(wait).resolves.toBeUndefined();
    expect(controller.resume("agent-1")).toBe(false);
    expect(controller.resume("never-paused")).toBe(false);
  });

  it("pausing one agent does not affect another", async () => {
    const controller = new PauseController();
    controller.pause("agent-1");
    await expect(controller.waitIfPaused("agent-2")).resolves.toBeUndefined();
    controller.resume("agent-1");
  });
});
