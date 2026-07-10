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

  describe("confirmTask()", () => {
    it("asks Electron to start the reviewed mission", async () => {
      const confirmTask = vi.fn().mockResolvedValue({ status: "started" });
      (window as any).electronAPI = { confirmTask };

      await expect(TaskModel.confirmTask("task-123")).resolves.toEqual({ status: "started" });
      expect(confirmTask).toHaveBeenCalledWith("task-123");
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

  describe("listTasks()", () => {
    it("calls electronAPI.listTasks", async () => {
      const listTasksMock = vi.fn().mockResolvedValue([
        { id: "task-1", prompt: "Test", status: "success", created_at: "2026-07-08" }
      ]);
      (window as any).electronAPI = { listTasks: listTasksMock };

      const result = await TaskModel.listTasks();

      expect(listTasksMock).toHaveBeenCalledOnce();
      expect(result).toEqual([
        { id: "task-1", prompt: "Test", status: "success", created_at: "2026-07-08" }
      ]);
    });
  });

  describe("deleteTask()", () => {
    it("calls electronAPI.deleteTask with the task id", async () => {
      const deleteTaskMock = vi.fn().mockResolvedValue({ status: "deleted" });
      (window as any).electronAPI = { deleteTask: deleteTaskMock };

      const result = await TaskModel.deleteTask("task-1");

      expect(deleteTaskMock).toHaveBeenCalledWith("task-1");
      expect(result).toEqual({ status: "deleted" });
    });
  });

  describe("readArtifact()", () => {
    it("calls electronAPI.readArtifact with the task id and artifact path", async () => {
      const readArtifactMock = vi.fn().mockResolvedValue("# Hello");
      (window as any).electronAPI = { readArtifact: readArtifactMock };

      const result = await TaskModel.readArtifact("task-1", "summary.md");

      expect(readArtifactMock).toHaveBeenCalledWith("task-1", "summary.md");
      expect(result).toBe("# Hello");
    });
  });

  describe("readTaskOrchestrator()", () => {
    it("calls electronAPI.readTaskOrchestrator with the taskId", async () => {
      const readTaskOrchestratorMock = vi.fn().mockResolvedValue("# Plan\n");
      (window as any).electronAPI = { readTaskOrchestrator: readTaskOrchestratorMock };

      const result = await TaskModel.readTaskOrchestrator("task-999");

      expect(readTaskOrchestratorMock).toHaveBeenCalledOnce();
      expect(readTaskOrchestratorMock).toHaveBeenCalledWith("task-999");
      expect(result).toBe("# Plan\n");
    });
  });

  describe("getTaskHistory()", () => {
    it("calls electronAPI.getTaskHistory with the taskId", async () => {
      const fakeMessages = [{ id: "m1", kind: "thought", content: "hello" }];
      const getTaskHistoryMock = vi.fn().mockResolvedValue(fakeMessages);
      (window as any).electronAPI = { getTaskHistory: getTaskHistoryMock };

      const result = await TaskModel.getTaskHistory("task-xyz");

      expect(getTaskHistoryMock).toHaveBeenCalledOnce();
      expect(getTaskHistoryMock).toHaveBeenCalledWith("task-xyz");
      expect(result).toEqual(fakeMessages);
    });
  });

  describe("getTaskAgents()", () => {
    it("retrieves durable named-agent lifecycle records", async () => {
      const agents = [{ id: "agent-1", handle: "@sage-1", status: "working" }];
      const getTaskAgents = vi.fn().mockResolvedValue(agents);
      (window as any).electronAPI = { getTaskAgents };

      await expect(TaskModel.getTaskAgents("task-xyz")).resolves.toEqual(agents);
      expect(getTaskAgents).toHaveBeenCalledWith("task-xyz");
    });
  });

  describe("conversation methods", () => {
    it("uses the IPC conversation surface", async () => {
      const createPublicConversation = vi.fn().mockResolvedValue({ id: "public" });
      const getTaskConversations = vi.fn().mockResolvedValue([]);
      const getConversationMessages = vi.fn().mockResolvedValue([]);
      const postConversationMessage = vi.fn().mockResolvedValue({ message: {}, routes: [] });
      (window as any).electronAPI = {
        createPublicConversation,
        getTaskConversations,
        getConversationMessages,
        postConversationMessage,
      };

      await TaskModel.createPublicConversation("task-1", "Mission chat");
      await TaskModel.getTaskConversations("task-1");
      await TaskModel.getConversationMessages("task-1", "public");
      await TaskModel.postConversationMessage({
        taskId: "task-1",
        conversationId: "public",
        authorId: "user",
        authorKind: "user",
        content: "@orchestrator hello",
      });

      expect(createPublicConversation).toHaveBeenCalledWith("task-1", "Mission chat");
      expect(getTaskConversations).toHaveBeenCalledWith("task-1");
      expect(getConversationMessages).toHaveBeenCalledWith("task-1", "public");
      expect(postConversationMessage).toHaveBeenCalledOnce();
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
