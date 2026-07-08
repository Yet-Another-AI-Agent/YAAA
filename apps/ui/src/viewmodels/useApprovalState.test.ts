// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useApprovalState } from "./useApprovalState";
import { TaskModel } from "../models/TaskModel";

vi.mock("../models/TaskModel", () => ({
  TaskModel: {
    resolveApproval: vi.fn().mockResolvedValue(undefined),
  },
}));

const makeToolCall = (id = "call-1") => ({
  id,
  capability: "files",
  method: "writeFile",
  args: { path: "out.txt", content: "hello" },
});

describe("useApprovalState", () => {
  const addLog = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initial pendingApproval is null", () => {
    const { result } = renderHook(() => useApprovalState("task-1", addLog));
    expect(result.current.pendingApproval).toBeNull();
  });

  it("setPendingApproval sets the pending approval state", () => {
    const { result } = renderHook(() => useApprovalState("task-1", addLog));
    const approval = { agentId: "agent-1", toolCall: makeToolCall() };

    act(() => {
      result.current.setPendingApproval(approval);
    });

    expect(result.current.pendingApproval).toEqual(approval);
  });

  it("resolveApproval(true) calls TaskModel.resolveApproval and clears pendingApproval", async () => {
    const { result } = renderHook(() => useApprovalState("task-1", addLog));
    const toolCall = makeToolCall("call-42");

    act(() => {
      result.current.setPendingApproval({ agentId: "agent-x", toolCall });
    });

    await act(async () => {
      await result.current.resolveApproval(true);
    });

    expect(TaskModel.resolveApproval).toHaveBeenCalledOnce();
    expect(TaskModel.resolveApproval).toHaveBeenCalledWith("call-42", true);
    expect(result.current.pendingApproval).toBeNull();
  });

  it("resolveApproval(false) calls TaskModel.resolveApproval with approved=false", async () => {
    const { result } = renderHook(() => useApprovalState("task-1", addLog));
    const toolCall = makeToolCall("call-99");

    act(() => {
      result.current.setPendingApproval({ agentId: "agent-y", toolCall });
    });

    await act(async () => {
      await result.current.resolveApproval(false);
    });

    expect(TaskModel.resolveApproval).toHaveBeenCalledWith("call-99", false);
    expect(result.current.pendingApproval).toBeNull();
  });

  it("resolveApproval does nothing when taskId is null", async () => {
    const { result } = renderHook(() => useApprovalState(null, addLog));
    const toolCall = makeToolCall();

    act(() => {
      result.current.setPendingApproval({ agentId: "agent-z", toolCall });
    });

    await act(async () => {
      await result.current.resolveApproval(true);
    });

    // TaskModel should NOT be called and state should remain
    expect(TaskModel.resolveApproval).not.toHaveBeenCalled();
    expect(result.current.pendingApproval).not.toBeNull();
  });
});
