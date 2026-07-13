import { app, BrowserWindow, ipcMain, nativeImage, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "@yaaa/core";
import { isInsufficientFundsError } from "@yaaa/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The product name shown in the window title, macOS menu bar, and about panel.
const APP_NAME = "YAAA";
app.setName(APP_NAME);

// The YAAA brand mark, used for the window and (on macOS) the dock icon.
const appIcon = nativeImage.createFromPath(path.join(__dirname, "build/icon.png"));

let mainWindow = null;

// Single shared workspace: owns config.json + main.db + per-task folders.
const workspace = new Workspace();

// Pending human-in-the-loop approvals, keyed by a per-call approval id.
// The core runtime's `onApproval` hook parks a promise here; the renderer
// resolves it via the "resolve-approval" IPC channel.
const pendingApprovals = new Map();

// Task ids the user deleted while their run was still in flight. There is no
// abort primitive threaded through the agent loop yet, so a delete cannot
// stop in-flight model calls — it only detaches the UI: further events for
// the task are dropped and any approval it's waiting on is auto-rejected so
// the backend doesn't block forever on a renderer that gave up on it.
const killedTasks = new Set();
const confirmingTasks = new Set();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 850,
    title: APP_NAME,
    icon: appIcon,
    backgroundColor: "#0b0e14",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Keep the window titled "YAAA" instead of adopting the loaded page's
  // <title>, which the renderer would otherwise push into the title bar.
  mainWindow.on("page-title-updated", (event) => event.preventDefault());

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

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/**
 * Translate a typed RuntimeEvent from the core into the topic/data shape the
 * renderer already consumes (previously produced by parsing CLI stdout).
 */
function forwardRuntimeEvent(taskId, event) {
  if (killedTasks.has(taskId)) return;
  switch (event.type) {
    case "task-started":
      sendToRenderer("task-event", {
        topic: `task.${taskId}.task-started`,
        data: { taskId: event.taskId },
      });
      break;
    case "plan-updated":
      sendToRenderer("task-event", {
        topic: `task.${taskId}.plan_updated`,
        data: event.plan,
      });
      break;
    case "thought":
      sendToRenderer("task-event", {
        topic: `task.${taskId}.agent.${event.from}.thought`,
        data: { content: event.content },
      });
      break;
    case "tool-requested":
      sendToRenderer("task-event", {
        topic: `task.${taskId}.agent.${event.from}.tool_requested`,
        data: { content: event.content, metadata: event.metadata },
      });
      break;
    case "agent-status":
      sendToRenderer("task-event", {
        topic: `task.${taskId}.agent_status`,
        data: event.agent,
      });
      break;
    case "status":
      sendToRenderer("task-event", {
        topic: `task.${taskId}.started`,
        data: { note: event.note },
      });
      break;
    case "topic-updated":
      sendToRenderer("task-event", {
        topic: `task.${taskId}.topic_updated`,
        data: { topic: event.topic },
      });
      break;
    case "result":
      sendToRenderer("task-event", {
        topic: `task.${taskId}.agent.${event.from}.result`,
        data: { artifacts: event.artifacts, summary: event.summary },
      });
      break;
    // "complete" is handled by the run() caller below.
    default:
      break;
  }
}

function makeApprovalHandler(taskId) {
  return (agentId, call) =>
    new Promise((resolve) => {
      if (killedTasks.has(taskId)) {
        resolve(false);
        return;
      }
      const approvalId = `${taskId}:${call.id ?? "call"}:${Date.now()}`;
      pendingApprovals.set(approvalId, resolve);
      sendToRenderer("approval-required", {
        agentId,
        toolCall: { ...call, id: approvalId },
      });
    });
}

// ------------------------------------------------------------------ IPC: tasks

// Conversational NLP gate: the renderer routes every message through this
// before start-task. "hi" gets a chat reply and never creates a task.
ipcMain.handle("route-user-message", async (_event, message) => {
  try {
    return await workspace.routeUserMessage(String(message ?? ""));
  } catch {
    // Never block a real request on classifier failure — treat it as work.
    return { kind: "task" };
  }
});

ipcMain.handle("start-task", async (_event, goal) => {
  const task = workspace.createTask(goal);

  setTimeout(async () => {
    try {
      const result = await workspace.startConversationalOnboarding(task.taskId, goal, {
        onEvent: (event) => forwardRuntimeEvent(task.taskId, event),
      });
      if (result && result.kind === "direct_execute") {
        sendToRenderer("task-complete", {
          success: true,
          summary: result.reply,
        });
      }
    } catch (err) {
      if (killedTasks.has(task.taskId)) return;
      sendToRenderer("task-complete", {
        success: false,
        summary: err?.message ?? String(err),
      });
    }
  }, 0);

  return task.taskId;
});


ipcMain.handle("confirm-task", async (_event, taskId) => {
  if (killedTasks.has(taskId) || confirmingTasks.has(taskId)) {
    return { status: "error", error: "Task is already running or was deleted" };
  }
  confirmingTasks.add(taskId);
  // The immediate acknowledgement lets the renderer transition to running
  // while the full result continues over the existing event channels.
  setTimeout(() => {
    workspace
      .confirmTask(taskId, {
        onEvent: (event) => forwardRuntimeEvent(taskId, event),
        onApproval: makeApprovalHandler(taskId),
      })
      .then((result) => {
        if (killedTasks.has(taskId)) return;
        const reason =
          !result.success && isInsufficientFundsError(result.summary)
            ? "insufficient_funds"
            : undefined;
        sendToRenderer("task-complete", { ...result, reason });
      })
      .catch((err) => {
        if (killedTasks.has(taskId)) return;
        sendToRenderer("task-complete", {
          success: false,
          summary: err?.message ?? String(err),
          reason: isInsufficientFundsError(err)
            ? "insufficient_funds"
            : undefined,
        });
      })
      .finally(() => confirmingTasks.delete(taskId));
  }, 0);

  return { status: "started" };
});

ipcMain.handle("replan-with-feedback", async (_event, { taskId, feedback }) => {
  if (killedTasks.has(taskId) || confirmingTasks.has(taskId)) {
    return { status: "error", error: "Task is already running or was deleted" };
  }
  confirmingTasks.add(taskId);
  setTimeout(() => {
    workspace
      .rePlanWithFeedback(taskId, feedback, {
        onEvent: (event) => forwardRuntimeEvent(taskId, event),
        onApproval: makeApprovalHandler(taskId),
      })
      .then((result) => {
        if (killedTasks.has(taskId)) return;
        const reason =
          !result.success && isInsufficientFundsError(result.summary)
            ? "insufficient_funds"
            : undefined;
        sendToRenderer("task-complete", { ...result, reason });
      })
      .catch((err) => {
        if (killedTasks.has(taskId)) return;
        sendToRenderer("task-complete", {
          success: false,
          summary: err?.message ?? String(err),
          reason: isInsufficientFundsError(err) ? "insufficient_funds" : undefined,
        });
      })
      .finally(() => confirmingTasks.delete(taskId));
  }, 0);
  return { status: "started" };
});

ipcMain.handle("record-plan-review", async (_event, { taskId, content, authorKind }) => {
  await workspace.recordPlanReviewMessage(taskId, content, authorKind);
  return { status: "saved" };
});

ipcMain.handle("continue-task", async (_event, { taskId, message }) => {
  if (killedTasks.has(taskId)) {
    return { status: "error", error: "Mission was deleted" };
  }
  try {
    const result = await workspace.continueMission(taskId, message, {
      onEvent: (event) => forwardRuntimeEvent(taskId, event),
      onApproval: makeApprovalHandler(taskId),
    });
    if (result.kind === "direct_execute") {
      sendToRenderer("task-complete", {
        success: true,
        summary: result.reply,
      });
      return { status: "conversation" };
    }
    return { status: result.kind };
  } catch (err) {
    if (killedTasks.has(taskId)) return { status: "cancelled" };
    sendToRenderer("task-complete", {
      success: false,
      summary: err?.message ?? String(err),
      reason: isInsufficientFundsError(err) ? "insufficient_funds" : undefined,
    });
    return { status: "error", error: err?.message ?? String(err) };
  }
});

ipcMain.handle("resolve-approval", async (_event, { callId, approved }) => {
  const resolve = pendingApprovals.get(callId);
  if (!resolve) {
    return { status: "error", error: "No pending approval for that id" };
  }
  pendingApprovals.delete(callId);
  resolve(!!approved);
  return { status: "success" };
});

ipcMain.handle("delete-task", async (_event, taskId) => {
  // Mark killed first so any in-flight run's late events/approvals no-op.
  killedTasks.add(taskId);
  for (const [approvalId, resolve] of pendingApprovals) {
    if (approvalId.startsWith(`${taskId}:`)) {
      resolve(false);
      pendingApprovals.delete(approvalId);
    }
  }
  workspace.deleteTask(taskId);
  return { status: "deleted" };
});

ipcMain.handle("list-tasks", async () => workspace.listTasks());

ipcMain.handle("get-task-history", async (_event, taskId) =>
  workspace.getTaskHistory(taskId),
);

ipcMain.handle("get-task-agents", async (_event, taskId) =>
  workspace.getTaskAgents(taskId),
);

ipcMain.handle(
  "create-public-conversation",
  async (_event, { taskId, title }) =>
    workspace.createPublicConversation(taskId, title),
);

ipcMain.handle("get-task-conversations", async (_event, taskId) =>
  workspace.getTaskConversations(taskId),
);

ipcMain.handle(
  "get-conversation-messages",
  async (_event, { taskId, conversationId }) =>
    workspace.getConversationMessages(taskId, conversationId),
);

ipcMain.handle("post-conversation-message", async (_event, message) =>
  workspace.postConversationMessage(message),
);

ipcMain.handle("resume-agent", async (_event, agentId) =>
  ({ resumed: workspace.resumeAgent(agentId) }),
);

ipcMain.handle("get-paused-agents", async () => workspace.getPausedAgents());

ipcMain.handle("list-mcp-integrations", async (_event, taskId) => [
  ...workspace.listMcpIntegrations({ kind: "global" }),
  ...(taskId
    ? workspace.listMcpIntegrations({ kind: "task", taskId })
    : []),
]);

ipcMain.handle("read-task-orchestrator", async (_event, taskId) =>
  workspace.readOrchestrator(taskId),
);

ipcMain.handle("read-artifact", async (_event, { taskId, artifactPath }) =>
  workspace.readArtifact(taskId, artifactPath),
);

ipcMain.handle("read-artifact-binary", async (_event, { taskId, artifactPath }) =>
  workspace.readArtifactBinary(taskId, artifactPath),
);

ipcMain.handle(
  "save-artifact-annotations",
  async (_event, { taskId, artifactPath, annotations }) =>
    workspace.saveArtifactAnnotations(taskId, artifactPath, annotations ?? []),
);

ipcMain.handle("save-line-comments", async (_event, { taskId, artifactPath, comments }) =>
  workspace.saveLineComments(taskId, artifactPath, comments ?? []),
);

ipcMain.handle("get-yaaa-dir", async () => workspace.getYaaaDir());

// ------------------------------------------------------------ IPC: onboarding

ipcMain.handle("get-onboarding-status", async () =>
  workspace.getOnboardingStatus(),
);

ipcMain.handle("get-onboarding-profile", async () =>
  workspace.getOnboardingProfile(),
);

ipcMain.handle("save-onboarding-keys", async (_event, key) =>
  workspace.saveKey(key),
);

ipcMain.handle("save-onboarding-profile", async (_event, profile = {}) =>
  workspace.saveProfile(profile),
);

ipcMain.handle("parse-resume", async (_event, text) => {
  try {
    return await workspace.parseResume(text ?? "");
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
});

ipcMain.handle("open-working-folder", async (_event, taskId) => {
  if (!taskId) return false;
  const folderPath = path.join(workspace.getYaaaDir(), "tasks", taskId, "working");
  await shell.openPath(folderPath);
  return true;
});

// ------------------------------------------------------------------- lifecycle

app.whenReady().then(() => {
  // On macOS the dock icon is set at runtime rather than via BrowserWindow.icon.
  if (process.platform === "darwin" && app.dock && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon);
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
