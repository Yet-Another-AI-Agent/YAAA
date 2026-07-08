import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock electron
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
  }));
  mockBrowserWindow.getAllWindows = vi.fn().mockReturnValue([]);

  return {
    app: mockApp,
    BrowserWindow: mockBrowserWindow,
    ipcMain: {
      handle: vi.fn(),
    },
  };
});

// Mock node:fs
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
  },
}));

// Mock node:child_process
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

describe("Electron main.js initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("should compile the monorepo when in dev mode and CLI build is missing", async () => {
    const { app } = await import("electron");
    app.isPackaged = false;

    const fs = await import("node:fs");
    fs.default.existsSync.mockReturnValue(false);

    const { execSync } = await import("node:child_process");

    // Dynamically import main.js so it runs during the test
    await import("./main.js");

    // Wait for the microtask queue to process app.whenReady().then(...)
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fs.default.existsSync).toHaveBeenCalled();
    expect(execSync).toHaveBeenCalledWith("npm run build", expect.any(Object));
  });

  it("should NOT compile when in dev mode and CLI build already exists", async () => {
    const { app } = await import("electron");
    app.isPackaged = false;

    const fs = await import("node:fs");
    fs.default.existsSync.mockReturnValue(true);

    const { execSync } = await import("node:child_process");

    await import("./main.js");

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fs.default.existsSync).toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
  });

  it("should NOT compile when the app is packaged (production mode)", async () => {
    const { app } = await import("electron");
    app.isPackaged = true;

    const fs = await import("node:fs");
    const { execSync } = await import("node:child_process");

    await import("./main.js");

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fs.default.existsSync).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
  });
});
