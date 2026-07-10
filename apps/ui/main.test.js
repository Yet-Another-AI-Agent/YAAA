import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture registered ipc handlers so we can assert the surface and invoke them.
const ipcHandlers = new Map();

vi.mock("electron", () => {
  const mockApp = {
    isPackaged: false,
    whenReady: vi.fn().mockResolvedValue(true),
    on: vi.fn(),
    quit: vi.fn(),
  };
  const mockBrowserWindow = vi.fn().mockImplementation(() => ({
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    on: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(false),
    webContents: { send: vi.fn() },
  }));
  mockBrowserWindow.getAllWindows = vi.fn().mockReturnValue([]);

  return {
    app: mockApp,
    BrowserWindow: mockBrowserWindow,
    ipcMain: {
      handle: vi.fn((channel, handler) => ipcHandlers.set(channel, handler)),
    },
  };
});

// Mock the core so the test never touches better-sqlite3 / real disk.
const workspaceInstance = {
  createTask: vi.fn().mockReturnValue({
    taskId: "task-123",
    taskDir: "/tmp/task-123",
    workingDir: "/tmp/task-123/working",
  }),
  runTask: vi
    .fn()
    .mockResolvedValue({ success: true, summary: "ok", plan: null }),
  prepareTask: vi.fn().mockResolvedValue({ goal: "do a thing", subtasks: [] }),
  confirmTask: vi
    .fn()
    .mockResolvedValue({ success: true, summary: "ok", plan: null }),
  listTasks: vi.fn().mockReturnValue([]),
  deleteTask: vi.fn(),
  getTaskHistory: vi.fn().mockResolvedValue([]),
  createPublicConversation: vi.fn().mockResolvedValue({ id: "conversation-1" }),
  getTaskConversations: vi.fn().mockResolvedValue([]),
  getConversationMessages: vi.fn().mockResolvedValue([]),
  postConversationMessage: vi
    .fn()
    .mockResolvedValue({ message: {}, routes: [] }),
  readOrchestrator: vi.fn().mockReturnValue(null),
  getYaaaDir: vi.fn().mockReturnValue("/home/user/.yaaa"),
  getOnboardingStatus: vi
    .fn()
    .mockReturnValue({ hasKey: false, hasProfile: false, skipped: false }),
  getOnboardingProfile: vi
    .fn()
    .mockReturnValue({ name: "", profession: "", description: "" }),
  saveKey: vi.fn().mockReturnValue({ success: true }),
  saveProfile: vi.fn().mockReturnValue({ success: true }),
  parseResume: vi
    .fn()
    .mockResolvedValue({ name: "N", profession: "P", description: "D" }),
  routeUserMessage: vi
    .fn()
    .mockResolvedValue({ kind: "conversation", reply: "Hello!" }),
  saveArtifactAnnotations: vi
    .fn()
    .mockResolvedValue({ annotationPath: "/tmp/a.json", routes: [] }),
  readArtifactBinary: vi
    .fn()
    .mockReturnValue({ dataUrl: "data:image/png;base64,AQID", mimeType: "image/png" }),
  resumeAgent: vi.fn().mockReturnValue(true),
  getPausedAgents: vi.fn().mockReturnValue([]),
  listMcpIntegrations: vi.fn().mockReturnValue([]),
};

vi.mock("@yaaa/core", () => ({
  Workspace: vi.fn().mockImplementation(() => workspaceInstance),
}));

describe("Electron main (in-process, no CLI subprocess)", () => {
  beforeEach(() => {
    vi.resetModules();
    ipcHandlers.clear();
  });

  it("registers the full IPC surface and creates a window on ready", async () => {
    const { app } = await import("electron");
    await import("./main.js");
    await new Promise((r) => setTimeout(r, 10));

    expect(app.whenReady).toHaveBeenCalled();
    for (const channel of [
      "route-user-message",
      "read-artifact-binary",
      "resume-agent",
      "get-paused-agents",
      "list-mcp-integrations",
      "save-artifact-annotations",
      "start-task",
      "confirm-task",
      "resolve-approval",
      "list-tasks",
      "delete-task",
      "get-task-history",
      "create-public-conversation",
      "get-task-conversations",
      "get-conversation-messages",
      "post-conversation-message",
      "read-task-orchestrator",
      "get-yaaa-dir",
      "get-onboarding-status",
      "get-onboarding-profile",
      "save-onboarding-keys",
      "save-onboarding-profile",
      "parse-resume",
    ]) {
      expect(ipcHandlers.has(channel)).toBe(true);
    }
  });

  it("route-user-message returns the workspace's conversational verdict", async () => {
    await import("./main.js");
    const route = ipcHandlers.get("route-user-message");

    const res = await route({}, "hi");

    expect(res).toEqual({ kind: "conversation", reply: "Hello!" });
    expect(workspaceInstance.routeUserMessage).toHaveBeenCalledWith("hi");
    expect(workspaceInstance.createTask).not.toHaveBeenCalled();
  });

  it("route-user-message falls back to task intent when classification fails", async () => {
    workspaceInstance.routeUserMessage.mockRejectedValueOnce(
      new Error("classifier offline"),
    );
    await import("./main.js");
    const route = ipcHandlers.get("route-user-message");

    await expect(route({}, "build a thing")).resolves.toEqual({ kind: "task" });
  });

  it("save-artifact-annotations delegates the payload to the workspace", async () => {
    await import("./main.js");
    const save = ipcHandlers.get("save-artifact-annotations");
    const annotations = [{ x: 1, y: 2, width: 3, height: 4, comment: "fix" }];

    const res = await save({}, { taskId: "task-123", artifactPath: "a.png", annotations });

    expect(res).toEqual({ annotationPath: "/tmp/a.json", routes: [] });
    expect(workspaceInstance.saveArtifactAnnotations).toHaveBeenCalledWith(
      "task-123",
      "a.png",
      annotations,
    );
  });

  it("start-task scaffolds via the workspace and returns the real task id", async () => {
    await import("./main.js");
    const startTask = ipcHandlers.get("start-task");
    const taskId = await startTask({}, "do a thing");
    expect(taskId).toBe("task-123");
    expect(workspaceInstance.createTask).toHaveBeenCalledWith("do a thing");
  });

  it("resolve-approval reports an error when there is no pending approval", async () => {
    await import("./main.js");
    const resolve = ipcHandlers.get("resolve-approval");
    const res = await resolve({}, { callId: "nope", approved: true });
    expect(res.status).toBe("error");
  });

  it("rejects duplicate confirm-task IPC while execution is in flight", async () => {
    let finish;
    workspaceInstance.confirmTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await import("./main.js");
    const confirmTask = ipcHandlers.get("confirm-task");

    expect(await confirmTask({}, "task-123")).toEqual({ status: "started" });
    expect(await confirmTask({}, "task-123")).toMatchObject({
      status: "error",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish({ success: true, summary: "ok", plan: null });
  });

  it("delete-task purges the workspace and returns deleted", async () => {
    await import("./main.js");
    const startTask = ipcHandlers.get("start-task");
    await startTask({}, "do a thing");

    const deleteTask = ipcHandlers.get("delete-task");
    const res = await deleteTask({}, "task-123");

    expect(res).toEqual({ status: "deleted" });
    expect(workspaceInstance.deleteTask).toHaveBeenCalledWith("task-123");
  });

  it("delete-task auto-rejects any approval the deleted task was waiting on", async () => {
    await import("./main.js");
    const startTask = ipcHandlers.get("start-task");
    await startTask({}, "do a thing");
    // start-task defers the prepareTask() call by one tick so the renderer
    // can attach listeners first; wait for it before reading the mock call.
    await new Promise((r) => setTimeout(r, 10));

    // Simulate the runtime pausing this task's agent on an approval gate.
    // workspaceInstance.prepareTask is a shared mock whose call history isn't
    // reset between tests, so grab the most recent call — index 0 would be a
    // stale closure from an earlier test's main.js module instance.
    const hooks = workspaceInstance.prepareTask.mock.calls.at(-1)[2];
    const approvalPromise = hooks.onApproval("agent-1", {
      id: "call-1",
      capability: "files",
      method: "writeFile",
    });

    const deleteTask = ipcHandlers.get("delete-task");
    await deleteTask({}, "task-123");

    await expect(approvalPromise).resolves.toBe(false);
  });
});
