import { describe, it, expect } from "vitest";
import { EVENTS, matchTopic } from "./events.js";

describe("EVENTS topic generator", () => {
  it("should generate correct string topics", () => {
    expect(EVENTS.taskStarted("123")).toBe("task.123.started");
    expect(EVENTS.taskPlanUpdated("123")).toBe("task.123.plan_updated");
    expect(EVENTS.taskCompleted("123")).toBe("task.123.completed");
    expect(EVENTS.taskFailed("123")).toBe("task.123.failed");
    expect(EVENTS.agentMessage("123")).toBe("task.123.agent_message");
    expect(EVENTS.agentThought("agent-1")).toBe("agent.agent-1.thought");
    expect(EVENTS.toolCallRequested("123", "agent-1")).toBe("task.123.agent.agent-1.tool_requested");
    expect(EVENTS.toolCallExecuted("123", "agent-1")).toBe("task.123.agent.agent-1.tool_executed");
    expect(EVENTS.approvalRequired("123")).toBe("task.123.approval_required");
    expect(EVENTS.approvalResolved("123")).toBe("task.123.approval_resolved");
  });
});

describe("matchTopic wildcard matcher", () => {
  it("should match exact topics", () => {
    expect(matchTopic("task.123.started", "task.123.started")).toBe(true);
    expect(matchTopic("task.123.started", "task.123.completed")).toBe(false);
  });

  it("should match single wildcard *", () => {
    expect(matchTopic("task.*.started", "task.123.started")).toBe(true);
    expect(matchTopic("task.*.started", "task.abc.started")).toBe(true);
    expect(matchTopic("task.*.started", "task.123.456.started")).toBe(false);
  });

  it("should match multi-level wildcard #", () => {
    expect(matchTopic("task.#.started", "task.123.started")).toBe(true);
    expect(matchTopic("task.#.started", "task.123.456.started")).toBe(true);
    expect(matchTopic("task.#.started", "task.started")).toBe(true);
  });
});
