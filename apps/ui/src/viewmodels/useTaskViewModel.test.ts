import { act, renderHook } from "@testing-library/react";
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskModel } from "../models/TaskModel";
import { useTaskViewModel } from "./useTaskViewModel";

vi.mock("../models/TaskModel", () => ({
  TaskModel: {
    routeUserMessage: vi.fn().mockResolvedValue({ kind: "task" }),
    classifyPlanReviewIntent: vi.fn().mockResolvedValue("approve"),
    startTask: vi.fn().mockResolvedValue("task-123"),
    continueTask: vi.fn().mockResolvedValue({ status: "started" }),
    confirmTask: vi.fn().mockResolvedValue({ status: "started" }),
    rePlanWithFeedback: vi.fn().mockResolvedValue({ status: "started" }),
    recordPlanReview: vi.fn().mockResolvedValue({ status: "saved" }),
    listTasks: vi.fn().mockResolvedValue([]),
    deleteTask: vi.fn().mockResolvedValue({ status: "deleted" }),
    getRecentTaskEvents: vi.fn().mockResolvedValue([]),
    subscribeEvents: vi.fn().mockReturnValue(() => {}),
    resolveApproval: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("useTaskViewModel — unified chat onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a task channel immediately even for small talk/greetings", async () => {
    const { result } = renderHook(() => useTaskViewModel());

    act(() => {
      result.current.setGoal("hi");
    });
    await act(async () => {
      await result.current.startTask();
    });

    expect(TaskModel.startTask).toHaveBeenCalledWith("hi");
    expect(result.current.taskId).toBe("task-123");
    expect(result.current.running).toBe(true);
    expect(result.current.goal).toBe("");
  });

  it("starts a task and clears composer on send", async () => {
    const { result } = renderHook(() => useTaskViewModel());

    act(() => {
      result.current.setGoal("Build a landing page");
    });
    await act(async () => {
      await result.current.startTask();
    });

    expect(TaskModel.startTask).toHaveBeenCalledWith("Build a landing page");
    expect(result.current.taskId).toBe("task-123");
    expect(result.current.goal).toBe("");
    expect(result.current.submittedPrompt).toBe("Build a landing page");
  });
});

describe("useTaskViewModel — mission continuity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("continues an open mission in the same channel instead of starting a new task", async () => {
    let onComplete: ((r: any) => void) | undefined;
    vi.mocked(TaskModel.subscribeEvents).mockImplementation((_e, _a, c) => {
      onComplete = c;
      return () => {};
    });
    const { result } = renderHook(() => useTaskViewModel());

    act(() => result.current.setGoal("Build a thing"));
    await act(async () => {
      await result.current.startTask();
    });
    // Simulate the mission completing so the composer is idle again.
    await act(async () => {
      onComplete?.({ success: true, summary: "done" });
    });
    expect(result.current.running).toBe(false);

    act(() => result.current.setGoal("Add tests"));
    await act(async () => {
      await result.current.continueMission();
    });

    expect(TaskModel.continueTask).toHaveBeenCalledWith("task-123", "Add tests");
    // No SECOND task was created — the follow-up reused the open mission.
    expect(TaskModel.startTask).toHaveBeenCalledTimes(1);
    expect(result.current.goal).toBe("");
    expect(result.current.submittedPrompt).toBe("Add tests");
  });

  it("ignores a follow-up when no mission is open", async () => {
    const { result } = renderHook(() => useTaskViewModel());
    act(() => result.current.setGoal("hello"));
    await act(async () => {
      await result.current.continueMission();
    });
    expect(TaskModel.continueTask).not.toHaveBeenCalled();
  });

  it("reactivates a persisted mission by id after an app restart", async () => {
    const { result } = renderHook(() => useTaskViewModel());

    await act(async () => {
      await result.current.continueMission("what happened next?", "persisted-task");
    });

    expect(TaskModel.continueTask).toHaveBeenCalledWith(
      "persisted-task",
      "what happened next?",
    );
    expect(result.current.taskId).toBe("persisted-task");
    expect(TaskModel.startTask).not.toHaveBeenCalled();
  });

  it("returns the composer to idle for a conversational follow-up", async () => {
    let onComplete: ((r: any) => void) | undefined;
    vi.mocked(TaskModel.subscribeEvents).mockImplementation((_e, _a, c) => {
      onComplete = c;
      return () => {};
    });
    vi.mocked(TaskModel.continueTask).mockResolvedValueOnce({ status: "conversation" });
    const { result } = renderHook(() => useTaskViewModel());

    act(() => result.current.setGoal("Build a thing"));
    await act(async () => { await result.current.startTask(); });
    await act(async () => { onComplete?.({ success: true, summary: "done" }); });

    act(() => result.current.setGoal("thanks!"));
    await act(async () => { await result.current.continueMission(); });

    // A conversational follow-up leaves the composer idle (not running / awaiting).
    expect(result.current.running).toBe(false);
    expect(result.current.awaitingConfirmation).toBe(false);
  });

  it("keeps running for an actionable follow-up until the plan arrives", async () => {
    let onComplete: ((r: any) => void) | undefined;
    vi.mocked(TaskModel.subscribeEvents).mockImplementation((_e, _a, c) => {
      onComplete = c;
      return () => {};
    });
    vi.mocked(TaskModel.continueTask).mockResolvedValueOnce({ status: "task" });
    const { result } = renderHook(() => useTaskViewModel());

    act(() => result.current.setGoal("Build a thing"));
    await act(async () => { await result.current.startTask(); });
    await act(async () => { onComplete?.({ success: true, summary: "done" }); });

    act(() => result.current.setGoal("also add tests"));
    await act(async () => { await result.current.continueMission(); });

    // A task follow-up stays running until a plan_updated event arrives.
    expect(result.current.running).toBe(true);
  });

  it("holds an active follow-up in the queue until the pickup event arrives", async () => {
    let onEvent: ((event: any) => void) | undefined;
    vi.mocked(TaskModel.subscribeEvents).mockImplementation((eventHandler) => {
      onEvent = eventHandler;
      return () => {};
    });
    const { result } = renderHook(() => useTaskViewModel());

    act(() => result.current.setGoal("Build a thing"));
    await act(async () => { await result.current.startTask(); });
    act(() => onEvent?.({
      topic: "task.task-123.agent_status",
      data: {
        id: "ad-agent-1",
        handle: "@ad-1",
        displayName: "Ad Strategist",
        taskId: "task-123",
        subtaskId: "task-1",
        role: "AdStrategistAgent",
        modelRole: "worker",
        status: "working",
      },
    }));
    expect(result.current.agents).toHaveLength(1);
    act(() => result.current.setGoal("whats happening?"));
    await act(async () => { await result.current.continueMission(); });

    expect(result.current.agents).toHaveLength(1);
    expect(result.current.queuedMessages).toEqual([
      expect.objectContaining({ content: "whats happening?" }),
    ]);
    expect(result.current.logs.some((log) => log.content === "whats happening?")).toBe(false);

    act(() => onEvent?.({
      topic: "task.task-123.started",
      data: { note: "📬 Processing queued user message: whats happening?" },
    }));

    expect(result.current.queuedMessages).toEqual([]);
    expect(result.current.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "user", content: "whats happening?" }),
    ]));

    act(() => onEvent?.({
      topic: "task.task-123.started",
      data: {
        note: "✅ I’m here — I received your message and routed it to the active agents. I’ll keep the existing work moving and report back with the next result.",
      },
    }));

    expect(result.current.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "orchestrator",
        content: expect.stringContaining("I’m here"),
      }),
    ]));
  });

  it("routes clarification-form answers immediately instead of queueing them behind workers", async () => {
    const { result } = renderHook(() => useTaskViewModel());

    act(() => result.current.setGoal("Build a thing"));
    await act(async () => { await result.current.startTask(); });

    act(() => result.current.setGoal("Answers to your questions:\n\nQ: What is the goal?\nA: Bookings"));
    await act(async () => { await result.current.continueMission(); });

    expect(result.current.queuedMessages).toEqual([]);
    expect(result.current.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "user",
        content: expect.stringContaining("Answers to your questions:"),
      }),
    ]));
    expect(TaskModel.continueTask).toHaveBeenCalledWith(
      "task-123",
      expect.stringContaining("Answers to your questions:"),
    );
  });

  it("does not queue clarification answers when the submitted text has leading whitespace", async () => {
    const { result } = renderHook(() => useTaskViewModel());

    act(() => result.current.setGoal("Build a thing"));
    await act(async () => { await result.current.startTask(); });

    act(() => result.current.setGoal("\n  Answers to your questions:\n\nQ: Who is it for?\nA: Judges"));
    await act(async () => { await result.current.continueMission(); });

    expect(result.current.queuedMessages).toEqual([]);
  });

  it("keeps streamed agent thoughts visible across orchestrator status updates", async () => {
    let onEvent: ((event: any) => void) | undefined;
    vi.mocked(TaskModel.subscribeEvents).mockImplementation((eventHandler) => {
      onEvent = eventHandler;
      return () => {};
    });
    const { result } = renderHook(() => useTaskViewModel());

    act(() => result.current.setGoal("Build a thing"));
    await act(async () => { await result.current.startTask(); });

    act(() => {
      onEvent?.({
        topic: "task.task-123.agent.files-agent-1.thought",
        data: { content: "Inspecting the existing files." },
      });
      onEvent?.({
        topic: "task.task-123.started",
        data: { note: "Supervisor checked the current todo." },
      });
    });

    expect(result.current.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "agent", kind: "thinking", content: "Inspecting the existing files." }),
        expect.objectContaining({ source: "orchestrator", content: "Supervisor checked the current todo." }),
      ]),
    );
  });

  it("replays a fast plan update that arrived before the renderer subscribed", async () => {
    vi.mocked(TaskModel.getRecentTaskEvents).mockResolvedValueOnce([
      {
        topic: "task.task-123.plan_updated",
        data: {
          goal: "Build a thing",
          subtasks: [
            { id: "task-1", title: "Implement it", state: "pending", artifacts: [] },
          ],
        },
      },
    ]);
    const { result } = renderHook(() => useTaskViewModel());

    act(() => result.current.setGoal("Build a thing"));
    await act(async () => { await result.current.startTask(); });
    await act(async () => {});

    expect(result.current.awaitingConfirmation).toBe(true);
    expect(result.current.running).toBe(false);
    expect(result.current.subtasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Implement it" })]),
    );
    expect(result.current.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "orchestrator",
          kind: "response",
          content: "[plan-proposal] Implementation plan ready for review.",
        }),
      ]),
    );
  });

  it("keeps an awaiting implementation plan visible during an informational follow-up", async () => {
    vi.mocked(TaskModel.classifyPlanReviewIntent).mockResolvedValue("feedback");
    let onEvent: ((event: any) => void) | undefined;
    let onComplete: ((result: any) => void) | undefined;
    vi.mocked(TaskModel.subscribeEvents).mockImplementation((eventHandler, _approval, completeHandler) => {
      onEvent = eventHandler;
      onComplete = completeHandler;
      return () => {};
    });
    const { result } = renderHook(() => useTaskViewModel());

    act(() => result.current.setGoal("Build a thing"));
    await act(async () => { await result.current.startTask(); });
    await act(async () => {});
    act(() => {
      onEvent?.({
        topic: "task.task-123.plan_updated",
        data: {
          goal: "Build a thing",
          subtasks: [
            { id: "task-1", title: "Implement it", state: "pending", artifacts: [] },
          ],
        },
      });
    });
    expect(result.current.awaitingConfirmation).toBe(true);

    act(() => result.current.setGoal("what happened?"));
    await act(async () => { await result.current.continueMission(); });
    await act(async () => {});
    act(() => {
      onComplete?.({ success: true, summary: "" });
    });
    await act(async () => {});

    expect(result.current.awaitingConfirmation).toBe(true);
    expect(result.current.running).toBe(false);
    expect(result.current.subtasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Implement it" })]),
    );
  });

  it("treats continue during plan review as accepting the implementation plan", async () => {
    vi.mocked(TaskModel.classifyPlanReviewIntent).mockResolvedValue("approve");
    let onEvent: ((event: any) => void) | undefined;
    vi.mocked(TaskModel.subscribeEvents).mockImplementation((eventHandler) => {
      onEvent = eventHandler;
      return () => {};
    });
    const { result } = renderHook(() => useTaskViewModel());

    act(() => result.current.setGoal("Build a thing"));
    await act(async () => { await result.current.startTask(); });
    await act(async () => {});
    act(() => {
      onEvent?.({
        topic: "task.task-123.plan_updated",
        data: {
          goal: "Build a thing",
          subtasks: [
            { id: "task-1", title: "Implement it", state: "pending", artifacts: [] },
          ],
        },
      });
    });

    act(() => result.current.setGoal("continue"));
    await act(async () => { await result.current.continueMission(); });

    expect(TaskModel.continueTask).not.toHaveBeenCalledWith("task-123", "continue");
    expect(TaskModel.recordPlanReview).toHaveBeenCalledWith(
      "task-123",
      "Accepted the implementation plan.",
      "user",
    );
    expect(TaskModel.confirmTask).toHaveBeenCalledWith("task-123");
    expect(result.current.awaitingConfirmation).toBe(false);
    expect(result.current.running).toBe(true);
  });

  it("persists plan acceptance comments as a user message for a reopened plan", async () => {
    const { result } = renderHook(() => useTaskViewModel());

    await act(async () => {
      await result.current.confirmPlan("keep the API small", "persisted-task");
    });

    expect(TaskModel.recordPlanReview).toHaveBeenCalledWith(
      "persisted-task",
      "Accepted the implementation plan with comments:\nkeep the API small",
      "user",
    );
    expect(TaskModel.rePlanWithFeedback).toHaveBeenCalledWith("persisted-task", "keep the API small");
    expect(result.current.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "user",
          content: expect.stringContaining("keep the API small"),
        }),
      ]),
    );
  });

  it("persists a rejected plan and YAAA's reply as conversation messages", async () => {
    const { result } = renderHook(() => useTaskViewModel());

    await act(async () => {
      await result.current.rejectPlan("use fewer steps", "persisted-task");
    });

    expect(TaskModel.recordPlanReview).toHaveBeenNthCalledWith(
      1,
      "persisted-task",
      "Rejected the implementation plan:\nuse fewer steps",
      "user",
    );
    expect(TaskModel.recordPlanReview).toHaveBeenNthCalledWith(
      2,
      "persisted-task",
      expect.stringContaining("I won't start this plan"),
      "orchestrator",
    );
  });
});
