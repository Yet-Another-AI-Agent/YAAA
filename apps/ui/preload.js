const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  startTask: (goal) => ipcRenderer.invoke("start-task", goal),
  resolveApproval: (callId, approved) =>
    ipcRenderer.invoke("resolve-approval", { callId, approved }),
  listTasks: () => ipcRenderer.invoke("list-tasks"),
  readTaskOrchestrator: (taskId) => ipcRenderer.invoke("read-task-orchestrator", taskId),
  getTaskHistory: (taskId) => ipcRenderer.invoke("get-task-history", taskId),
  getYaaaDir: () => ipcRenderer.invoke("get-yaaa-dir"),
  onTaskEvent: (callback) => {
    const subscription = (event, value) => callback(value);
    ipcRenderer.on("task-event", subscription);
    return () => ipcRenderer.removeListener("task-event", subscription);
  },
  onApprovalRequired: (callback) => {
    const subscription = (event, value) => callback(value);
    ipcRenderer.on("approval-required", subscription);
    return () => ipcRenderer.removeListener("approval-required", subscription);
  },
  onComplete: (callback) => {
    const subscription = (event, value) => callback(value);
    ipcRenderer.on("task-complete", subscription);
    return () => ipcRenderer.removeListener("task-complete", subscription);
  },
  getOnboardingStatus: () => ipcRenderer.invoke("get-onboarding-status"),
  saveOnboardingKeys: (key) => ipcRenderer.invoke("save-onboarding-keys", key),
  saveOnboardingProfile: (profile) =>
    ipcRenderer.invoke("save-onboarding-profile", profile),
  parseResume: (text) => ipcRenderer.invoke("parse-resume", text),
});
