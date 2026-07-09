import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let cliProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 850,
    backgroundColor: "#0b0e14",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "dist/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// IPC Handlers called by Renderer Process
ipcMain.handle("start-task", async (event, goal) => {
  if (cliProcess) {
    try {
      cliProcess.kill();
    } catch (e) {}
    cliProcess = null;
  }

  const taskId = `task-${Math.random().toString(36).substr(2, 6)}`;

  // Resolve path to CLI compiled index.js
  const cliPath = path.resolve(__dirname, "../cli/dist/index.js");

  console.log(`[Spawn CLI] Path: ${cliPath}, Goal: "${goal}"`);

  // Spawn CLI tool as a subprocess in GUI mode
  cliProcess = spawn("node", [cliPath, "task", "-n", goal, "--gui"], {
    cwd: path.resolve(__dirname, "../cli"), // Run from CLI package context
  });

  let buffer = "";

  cliProcess.stdout.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const payload = JSON.parse(trimmed);

        if (!mainWindow || mainWindow.isDestroyed()) continue;

        if (payload.event === "plan-updated") {
          mainWindow.webContents.send("task-event", {
            topic: `task.${taskId}.plan_updated`,
            data: payload.plan,
          });
        } else if (payload.event === "task-started") {
          mainWindow.webContents.send("task-event", {
            topic: `task.${taskId}.task-started`,
            data: { taskId: payload.taskId },
          });
        } else if (payload.event === "thought") {
          mainWindow.webContents.send("task-event", {
            topic: `task.${taskId}.agent.${payload.from}.thought`,
            data: { content: payload.content },
          });
        } else if (payload.event === "tool-requested") {
          mainWindow.webContents.send("task-event", {
            topic: `task.${taskId}.agent.${payload.from}.tool_requested`,
            data: { content: payload.content },
          });
        } else if (payload.event === "started") {
          mainWindow.webContents.send("task-event", {
            topic: `task.${taskId}.started`,
            data: { note: payload.note },
          });
        } else if (payload.event === "approval-required") {
          // Adjust call ID so UI matches it
          payload.toolCall.id = `${taskId}-${payload.toolCall.id}`;
          mainWindow.webContents.send("approval-required", {
            agentId: payload.agentId,
            toolCall: payload.toolCall,
          });
        } else if (payload.event === "complete") {
          mainWindow.webContents.send("task-complete", payload.result);
        }
      } catch (err) {
        // Log non-JSON lines as system updates
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("task-event", {
            topic: `task.${taskId}.started`,
            data: { note: trimmed },
          });
        }
      }
    }
  });

  cliProcess.stderr.on("data", (data) => {
    const errorText = data.toString().trim();
    if (errorText && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("task-event", {
        topic: `task.${taskId}.started`,
        data: { note: `[CLI Error] ${errorText}` },
      });
    }
  });

  cliProcess.on("close", (code) => {
    console.log(`[CLI Terminated] Exit code: ${code}`);
    cliProcess = null;
  });

  return taskId;
});

ipcMain.handle("resolve-approval", async (event, { callId, approved }) => {
  if (cliProcess) {
    console.log(
      `[IPC Resolve Approval] Writing to CLI stdin: ${approved ? "y" : "n"}`,
    );
    cliProcess.stdin.write(approved ? "y\n" : "n\n");
    return { status: "success" };
  }
  return { status: "error", error: "No active CLI process found" };
});

ipcMain.handle("list-tasks", async (event) => {
  return new Promise((resolve) => {
    const cliPath = path.resolve(__dirname, "../cli/dist/index.js");
    const child = spawn("node", [cliPath, "task", "-ls", "--gui"], {
      cwd: path.resolve(__dirname, "../cli"),
    });

    let output = "";
    child.stdout.on("data", (data) => {
      output += data.toString();
    });

    child.on("error", (err) => {
      console.error("Failed to spawn CLI process:", err);
      resolve([]);
    });

    child.on("close", () => {
      try {
        const lines = output.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("{")) {
            const parsed = JSON.parse(trimmed);
            if (parsed.event === "task-list") {
              resolve(parsed.tasks);
              return;
            }
          }
        }
      } catch (err) {
        console.error("Failed to parse task-list JSON output:", err);
      }
      resolve([]);
    });
  });
});

ipcMain.handle("read-task-orchestrator", async (event, taskId) => {
  if (typeof taskId !== "string" || !/^[a-zA-Z0-9-]+$/.test(taskId)) {
    console.error(`Invalid taskId: ${taskId}`);
    return null;
  }
  const yaaaDir = process.env.YAAA_DATA_DIR || path.join(os.homedir(), ".yaaa");
  const tasksDir = path.join(yaaaDir, "tasks");
  const mdPath = path.join(tasksDir, taskId, "orchestrator.md");

  // check that the resolved mdPath starts with the expected tasks folder
  const resolvedMdPath = path.resolve(mdPath);
  const resolvedTasksDir = path.resolve(tasksDir);
  if (!resolvedMdPath.startsWith(resolvedTasksDir)) {
    console.error(`Path traversal detected: ${mdPath}`);
    return null;
  }

  try {
    if (fs.existsSync(resolvedMdPath)) {
      return fs.readFileSync(resolvedMdPath, "utf-8");
    }
  } catch (err) {
    console.error(`Failed to read orchestrator for task ${taskId}:`, err);
  }
  return null;
});

ipcMain.handle("get-yaaa-dir", async (event) => {
  return process.env.YAAA_DATA_DIR || path.join(os.homedir(), ".yaaa");
});

// Config helpers
function loadConfig() {
  const yaaaDir = process.env.YAAA_DATA_DIR || path.join(os.homedir(), ".yaaa");
  const configPath = path.join(yaaaDir, "config.json");
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function saveConfig(config) {
  const yaaaDir = process.env.YAAA_DATA_DIR || path.join(os.homedir(), ".yaaa");
  if (!fs.existsSync(yaaaDir)) {
    fs.mkdirSync(yaaaDir, { recursive: true });
  }
  const configPath = path.join(yaaaDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

ipcMain.handle("get-onboarding-status", async () => {
  const config = loadConfig();
  return {
    hasKey: !!config.accessToken,
    hasProfile: !!config.userName,
    skipped: !!config.skipOnboarding,
  };
});

ipcMain.handle("save-onboarding-keys", async (event, key) => {
  const config = loadConfig();
  config.accessToken = key;
  saveConfig(config);
  return { success: true };
});

ipcMain.handle(
  "save-onboarding-profile",
  async (event, { name, profession, description, skip }) => {
    const config = loadConfig();
    if (name !== undefined) config.userName = name;
    if (profession !== undefined) config.userProfession = profession;
    if (description !== undefined) config.userDescription = description;
    if (skip) {
      config.skipOnboarding = true;
    }
    saveConfig(config);
    return { success: true };
  },
);

ipcMain.handle("parse-resume", async (event, text) => {
  return new Promise((resolve) => {
    const cliPath = path.resolve(__dirname, "../cli/dist/index.js");
    const child = spawn("node", [cliPath, "config", "--parse-resume", text], {
      cwd: path.resolve(__dirname, "../cli"),
    });

    let output = "";
    let errorOutput = "";

    child.stdout.on("data", (data) => {
      output += data.toString();
    });

    child.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    child.on("close", (code) => {
      try {
        const startIndex = output.indexOf("{");
        if (startIndex !== -1) {
          const jsonString = output.substring(
            startIndex,
            output.lastIndexOf("}") + 1,
          );
          const parsed = JSON.parse(jsonString);
          resolve(parsed);
        } else {
          resolve({ error: "No JSON found in CLI output", raw: output });
        }
      } catch (err) {
        resolve({ error: "Failed to parse CLI output", raw: output });
      }
    });

    child.on("error", (err) => {
      resolve({ error: err.message });
    });
  });
});

app.whenReady().then(() => {
  const isDev = !app.isPackaged;
  if (isDev) {
    const cliPath = path.resolve(__dirname, "../cli/dist/index.js");
    if (!fs.existsSync(cliPath)) {
      console.log("[Electron] CLI build not found. Compiling monorepo...");
      try {
        execSync("npm run build", { cwd: path.resolve(__dirname, "../..") });
        console.log("[Electron] CLI compiled successfully.");
      } catch (err) {
        console.error("[Electron] Failed to compile CLI on startup:", err);
      }
    }
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (cliProcess) {
    try {
      cliProcess.kill();
    } catch (e) {}
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});
