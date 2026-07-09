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
  runTask: vi.fn().mockResolvedValue({ success: true, summary: "ok", plan: null }),
  listTasks: vi.fn().mockReturnValue([]),
  getTaskHistory: vi.fn().mockResolvedValue([]),
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
      "start-task",
      "resolve-approval",
      "list-tasks",
      "get-task-history",
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
});
