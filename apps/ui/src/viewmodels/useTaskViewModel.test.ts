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
