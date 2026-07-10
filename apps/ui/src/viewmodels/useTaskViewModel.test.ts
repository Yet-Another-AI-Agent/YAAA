import { act, renderHook } from "@testing-library/react";
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskModel } from "../models/TaskModel";
import { useTaskViewModel } from "./useTaskViewModel";

vi.mock("../models/TaskModel", () => ({
  TaskModel: {
    routeUserMessage: vi.fn().mockResolvedValue({ kind: "task" }),
    startTask: vi.fn().mockResolvedValue("task-123"),
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
        sender: "@orchestrator",
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
