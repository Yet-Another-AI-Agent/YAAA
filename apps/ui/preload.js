const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  startTask: (goal) => ipcRenderer.invoke("start-task", goal),
  resolveApproval: (callId, approved) =>
    ipcRenderer.invoke("resolve-approval", { callId, approved }),
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
});
