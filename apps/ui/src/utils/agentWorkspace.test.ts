// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { UIAgent } from "../models/TaskModel";
import type { UILog } from "../viewmodels/useLogState";
import {
  formatAgentLifecycleNotice,
  getAgentActivity,
  getAgentMessageOrderIndex,
  isActiveAgent,
} from "./agentWorkspace";

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

  it("orders working agents by their lifecycle message position", () => {
    const agents = [
      { id: "agent-c", handle: "@third-3", displayName: "Third", status: "working", role: "FilesAgent" },
      { id: "agent-a", handle: "@first-1", displayName: "First", status: "working", role: "FilesAgent" },
      { id: "agent-b", handle: "@second-2", displayName: "Second", status: "working", role: "FilesAgent" },
    ] as UIAgent[];
    const logs = [
      { id: "1", time: "10:00", source: "system", kind: "system", content: "[agent-lifecycle] @first-1 joined", createdAt: 1 },
      { id: "2", time: "10:01", source: "orchestrator", kind: "system", content: "Starting work", createdAt: 2 },
      { id: "3", time: "10:02", source: "system", kind: "system", content: "[agent-lifecycle] agent-b joined", createdAt: 3 },
      { id: "4", time: "10:03", source: "system", kind: "system", content: "[agent-lifecycle] Third joined", createdAt: 4 },
    ] as UILog[];

    const ordered = [...agents].sort(
      (a, b) => getAgentMessageOrderIndex(a, logs) - getAgentMessageOrderIndex(b, logs),
    );

    expect(ordered.map((agent) => agent.id)).toEqual(["agent-a", "agent-b", "agent-c"]);
  });
});
