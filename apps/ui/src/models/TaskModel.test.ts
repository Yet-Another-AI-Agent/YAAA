// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskModel } from "./TaskModel";

describe("TaskModel", () => {
  beforeEach(() => {
    // Reset electronAPI on window before each test
    delete (window as any).electronAPI;
  });

  describe("getElectronAPI()", () => {
    it("throws when electronAPI is not on window", () => {
      expect(() => TaskModel.getElectronAPI()).toThrow(
        "Electron API context bridge not found."
      );
    });

    it("returns the electronAPI object when present", () => {
      const fakeAPI = { startTask: vi.fn() };
      (window as any).electronAPI = fakeAPI;
      expect(TaskModel.getElectronAPI()).toBe(fakeAPI);
    });
  });

  describe("startTask()", () => {
    it("calls electronAPI.startTask with the provided goal", async () => {
      const startTask = vi.fn().mockResolvedValue("task-123");
      (window as any).electronAPI = { startTask };

      const result = await TaskModel.startTask("Write a report");

      expect(startTask).toHaveBeenCalledOnce();
      expect(startTask).toHaveBeenCalledWith("Write a report");
      expect(result).toBe("task-123");
    });
  });

  describe("resolveApproval()", () => {
    it("calls electronAPI.resolveApproval with callId and approved=true", async () => {
      const resolveApproval = vi.fn().mockResolvedValue({ ok: true });
      (window as any).electronAPI = { resolveApproval };

      const result = await TaskModel.resolveApproval("call-abc", true);

      expect(resolveApproval).toHaveBeenCalledOnce();
      expect(resolveApproval).toHaveBeenCalledWith("call-abc", true);
      expect(result).toEqual({ ok: true });
    });

    it("calls electronAPI.resolveApproval with approved=false", async () => {
      const resolveApproval = vi.fn().mockResolvedValue({ ok: false });
      (window as any).electronAPI = { resolveApproval };

      await TaskModel.resolveApproval("call-xyz", false);

      expect(resolveApproval).toHaveBeenCalledWith("call-xyz", false);
    });
  });

  describe("subscribeEvents()", () => {
    it("wires up all three callbacks and returned fn calls all unsubscribers", () => {
      const unsubEvent = vi.fn();
      const unsubApproval = vi.fn();
      const unsubComplete = vi.fn();

      const onTaskEvent = vi.fn().mockReturnValue(unsubEvent);
      const onApprovalRequired = vi.fn().mockReturnValue(unsubApproval);
      const onComplete = vi.fn().mockReturnValue(unsubComplete);

      (window as any).electronAPI = { onTaskEvent, onApprovalRequired, onComplete };

      const onEvent = vi.fn();
      const onApproval = vi.fn();
      const onCompleteCb = vi.fn();

      const unsubscribe = TaskModel.subscribeEvents(onEvent, onApproval, onCompleteCb);

      expect(onTaskEvent).toHaveBeenCalledOnce();
      expect(onTaskEvent).toHaveBeenCalledWith(onEvent);
      expect(onApprovalRequired).toHaveBeenCalledOnce();
      expect(onApprovalRequired).toHaveBeenCalledWith(onApproval);
      expect(onComplete).toHaveBeenCalledOnce();
      expect(onComplete).toHaveBeenCalledWith(onCompleteCb);

      // Call the returned unsubscribe function
      unsubscribe();

      expect(unsubEvent).toHaveBeenCalledOnce();
      expect(unsubApproval).toHaveBeenCalledOnce();
      expect(unsubComplete).toHaveBeenCalledOnce();
    });
  });
});
