import { act, renderHook } from "@testing-library/react";
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskModel } from "../models/TaskModel";
import { useTaskViewModel } from "./useTaskViewModel";

vi.mock("../models/TaskModel", () => ({
  TaskModel: {
    routeUserMessage: vi.fn().mockResolvedValue({ kind: "task" }),
    startTask: vi.fn().mockResolvedValue("task-123"),
    continueTask: vi.fn().mockResolvedValue({ status: "started" }),
    confirmTask: vi.fn().mockResolvedValue({ status: "started" }),
    listTasks: vi.fn().mockResolvedValue([]),
    deleteTask: vi.fn().mockResolvedValue({ status: "deleted" }),
    subscribeEvents: vi.fn().mockReturnValue(() => {}),
    resolveApproval: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("useTaskViewModel — conversational NLP gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers small talk in #general without starting a task", async () => {
    vi.mocked(TaskModel.routeUserMessage).mockResolvedValueOnce({
      kind: "conversation",
      reply: "Hello! What are we building or working on today?",
    });
    const { result } = renderHook(() => useTaskViewModel());

    act(() => {
      result.current.setGoal("hi");
    });
    await act(async () => {
      await result.current.startTask();
    });

    expect(TaskModel.routeUserMessage).toHaveBeenCalledWith("hi");
    expect(TaskModel.startTask).not.toHaveBeenCalled();
    expect(result.current.taskId).toBeNull();
    expect(result.current.running).toBe(false);
    expect(result.current.chatMessages).toEqual([
      expect.objectContaining({ sender: "User", content: "hi" }),
      expect.objectContaining({
        sender: "YAAA",
        content: "Hello! What are we building or working on today?",
      }),
    ]);
    // Input clears so the user can keep chatting.
    expect(result.current.goal).toBe("");
  });

  it("starts a task when the router classifies the message as work", async () => {
    const { result } = renderHook(() => useTaskViewModel());

    act(() => {
      result.current.setGoal("Build a landing page");
    });
    await act(async () => {
      await result.current.startTask();
    });

    expect(TaskModel.startTask).toHaveBeenCalledWith("Build a landing page");
    expect(result.current.taskId).toBe("task-123");
    expect(result.current.chatMessages).toEqual([]);
    // The composer clears on send (the message must not stay in the box), and
    // the submitted prompt is retained for the task view.
    expect(result.current.goal).toBe("");
    expect(result.current.submittedPrompt).toBe("Build a landing page");
  });

  it("still starts the task when the intent router itself fails", async () => {
    vi.mocked(TaskModel.routeUserMessage).mockRejectedValueOnce(
      new Error("router down"),
    );
    const { result } = renderHook(() => useTaskViewModel());

    act(() => {
      result.current.setGoal("Fix the login bug");
    });
    await act(async () => {
      await result.current.startTask();
    });

    expect(TaskModel.startTask).toHaveBeenCalledWith("Fix the login bug");
    expect(result.current.taskId).toBe("task-123");
  });

  it("keeps prior conversation turns when the user keeps chatting", async () => {
    vi.mocked(TaskModel.routeUserMessage)
      .mockResolvedValueOnce({ kind: "conversation", reply: "Hello!" })
      .mockResolvedValueOnce({
        kind: "conversation",
        reply: "I'm great — you?",
      });
    const { result } = renderHook(() => useTaskViewModel());

    act(() => result.current.setGoal("hi"));
    await act(async () => {
      await result.current.startTask();
    });
    act(() => result.current.setGoal("how are you"));
    await act(async () => {
      await result.current.startTask();
    });

    expect(result.current.chatMessages).toHaveLength(4);
    expect(TaskModel.startTask).not.toHaveBeenCalled();
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
});
