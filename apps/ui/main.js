import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import { CliAuth } from "../cli/dist/auth.js";

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
    console.log(`[IPC Resolve Approval] Writing to CLI stdin: ${approved ? "y" : "n"}`);
    cliProcess.stdin.write(approved ? "y\n" : "n\n");
    return { status: "success" };
  }
  return { status: "error", error: "No active CLI process found" };
});

ipcMain.handle("list-tasks", async (event) => {
  const auth = new CliAuth();
  const db = auth.getMainDbConnection();
  try {
    const rows = db.prepare("SELECT id, prompt, status, created_at FROM tasks ORDER BY created_at DESC").all();
    return rows;
  } catch (err) {
    console.error("Failed to query task list:", err);
    return [];
  } finally {
    db.close();
  }
});

ipcMain.handle("read-task-orchestrator", async (event, taskId) => {
  const auth = new CliAuth();
  const yaaaDir = auth.getYaaaDir();
  const mdPath = path.join(yaaaDir, "tasks", taskId, "orchestrator.md");
  try {
    if (fs.existsSync(mdPath)) {
      return fs.readFileSync(mdPath, "utf-8");
    }
  } catch (err) {
    console.error(`Failed to read orchestrator for task ${taskId}:`, err);
  }
  return null;
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
