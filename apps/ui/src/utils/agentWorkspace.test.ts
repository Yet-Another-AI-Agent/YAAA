// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { UIAgent } from "../models/TaskModel";
import { formatAgentLifecycleNotice, getAgentActivity, isActiveAgent } from "./agentWorkspace";

const agent: UIAgent = {
  id: "agent-research",
  handle: "@sage-1",
  displayName: "Sage",
  taskId: "task-1",
  subtaskId: "research",
  role: "Researcher",
  modelRole: "fast",
  status: "planned",
};

describe("agentWorkspace", () => {
  it("identifies agents that are still active", () => {
    expect(isActiveAgent(agent)).toBe(true);
    expect(isActiveAgent({ ...agent, status: "exited" })).toBe(false);
  });

  it("creates a join notice for a newly observed agent", () => {
    expect(formatAgentLifecycleNotice(undefined, agent)).toBe("🟢 @sage-1 joined the mission as Researcher.");
  });

  it("creates an exit notice when an agent leaves", () => {
    expect(formatAgentLifecycleNotice(agent, { ...agent, status: "exited" })).toBe(
      "👋 @sage-1 is done and exited the mission.",
    );
  });

  it("does not create duplicate notices for an unchanged status", () => {
    expect(formatAgentLifecycleNotice(agent, agent)).toBeNull();
  });

  it("groups only matching agent activity", () => {
    const activity = getAgentActivity(agent, [
      { id: "1", time: "10:00", source: "agent", content: "[@sage-1] searched the repository", kind: "activity" },
      { id: "2", time: "10:01", source: "agent", content: "[agent-builder] wrote a test", kind: "activity" },
      { id: "3", time: "10:02", source: "system", content: "mission started", kind: "system" },
    ]);

    expect(activity.map((log) => log.id)).toEqual(["1"]);
  });
});
