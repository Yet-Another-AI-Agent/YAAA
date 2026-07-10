import { describe, it, expect } from "vitest";
import { mapBusEvent } from "./events.js";

const TASK = "task-abc";

describe("mapBusEvent", () => {
  it("maps plan_updated to a plan-updated event", () => {
    const plan = { goal: "g", subtasks: [] };
    expect(mapBusEvent(TASK, `task.${TASK}.plan_updated`, plan)).toEqual({
      type: "plan-updated",
      plan,
    });
  });

  it("maps a result agent_message to a result event", () => {
    const msg = {
      kind: "result",
      from: "agent-1",
      taskId: TASK,
      summary: "done",
      artifacts: [{ path: "a.txt", mimeType: "text/plain", description: "x" }],
    };
    expect(mapBusEvent(TASK, `task.${TASK}.agent_message`, msg)).toEqual({
      type: "result",
      from: "agent-1",
      summary: "done",
      artifacts: msg.artifacts,
    });
  });

  it("ignores non-result agent_message payloads", () => {
    const msg = { kind: "status", from: "agent-1", taskId: TASK, state: "working" };
    expect(mapBusEvent(TASK, `task.${TASK}.agent_message`, msg)).toBeNull();
  });

  it("extracts the agent id from a thought topic", () => {
    const event = mapBusEvent(TASK, `task.${TASK}.agent.agent-42.thought`, {
      kind: "thought",
      from: "agent-42",
      content: "thinking",
    });
    expect(event).toEqual({ type: "thought", from: "agent-42", content: "thinking" });
  });

  it("maps tool_requested topics", () => {
    const event = mapBusEvent(TASK, `task.${TASK}.agent.agent-7.tool_requested`, {
      content: "files.writeFile",
    });
    expect(event).toEqual({
      type: "tool-requested",
      from: "agent-7",
      content: "files.writeFile",
    });
  });

  it("maps durable agent lifecycle records", () => {
    const agent = {
      id: "files-agent-1",
      handle: "@sage-1",
      displayName: "Sage",
      taskId: TASK,
      subtaskId: "write",
      role: "FilesAgent",
      modelRole: "worker",
      status: "working" as const,
    };
    expect(mapBusEvent(TASK, `task.${TASK}.agent.files-agent-1.lifecycle`, agent)).toEqual({
      type: "agent-status",
      agent,
    });
  });

  it("maps started/completed to status events", () => {
    expect(mapBusEvent(TASK, `task.${TASK}.started`, { from: "sys", note: "go" })).toEqual({
      type: "status",
      from: "sys",
      note: "go",
    });
    expect(
      mapBusEvent(TASK, `task.${TASK}.completed`, { note: "Goal achieved" }),
    ).toEqual({ type: "status", from: "orchestrator", note: "Goal achieved" });
  });

  it("returns null for unrelated topics", () => {
    expect(mapBusEvent(TASK, `task.${TASK}.unknown`, {})).toBeNull();
    expect(mapBusEvent(TASK, `task.other.plan_updated`, {})).toBeNull();
  });

  it("uses safe defaults for sparse frontend-facing payloads", () => {
    expect(
      mapBusEvent(TASK, `task.${TASK}.agent_message`, {
        kind: "result",
        from: "agent-1",
        summary: "done",
      }),
    ).toEqual({ type: "result", from: "agent-1", summary: "done", artifacts: [] });

    expect(mapBusEvent(TASK, `task.${TASK}.started`, null)).toEqual({
      type: "status",
      from: "system",
      note: "",
    });
    expect(mapBusEvent(TASK, `task.${TASK}.completed`, null)).toEqual({
      type: "status",
      from: "orchestrator",
      note: "",
    });

    expect(mapBusEvent(TASK, `task.${TASK}.agent.worker.thought`, { from: "fallback" })).toEqual({
      type: "thought",
      from: "fallback",
      content: "",
    });
    expect(mapBusEvent(TASK, `task.${TASK}.agent.worker.thought`, {})).toEqual({
      type: "thought",
      from: "agent",
      content: "",
    });
    expect(
      mapBusEvent(TASK, `task.${TASK}.agent.worker.tool_requested`, { from: "fallback" }),
    ).toEqual({ type: "tool-requested", from: "fallback", content: "" });
    expect(mapBusEvent(TASK, `task.${TASK}.agent.worker.tool_requested`, {})).toEqual({
      type: "tool-requested",
      from: "agent",
      content: "",
    });
  });
});
