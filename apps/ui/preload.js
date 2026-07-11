const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  routeUserMessage: (message) => ipcRenderer.invoke("route-user-message", message),
  startTask: (goal) => ipcRenderer.invoke("start-task", goal),
  continueTask: (taskId, message) =>
    ipcRenderer.invoke("continue-task", { taskId, message }),
  confirmTask: (taskId) => ipcRenderer.invoke("confirm-task", taskId),
  resolveApproval: (callId, approved) =>
    ipcRenderer.invoke("resolve-approval", { callId, approved }),
  listTasks: () => ipcRenderer.invoke("list-tasks"),
  deleteTask: (taskId) => ipcRenderer.invoke("delete-task", taskId),
  readTaskOrchestrator: (taskId) => ipcRenderer.invoke("read-task-orchestrator", taskId),
  readArtifact: (taskId, artifactPath) =>
    ipcRenderer.invoke("read-artifact", { taskId, artifactPath }),
  readArtifactBinary: (taskId, artifactPath) =>
    ipcRenderer.invoke("read-artifact-binary", { taskId, artifactPath }),
  saveArtifactAnnotations: (taskId, artifactPath, annotations) =>
    ipcRenderer.invoke("save-artifact-annotations", {
      taskId,
      artifactPath,
      annotations,
    }),
  getTaskHistory: (taskId) => ipcRenderer.invoke("get-task-history", taskId),
  getTaskAgents: (taskId) => ipcRenderer.invoke("get-task-agents", taskId),
  createPublicConversation: (taskId, title) =>
    ipcRenderer.invoke("create-public-conversation", { taskId, title }),
  getTaskConversations: (taskId) => ipcRenderer.invoke("get-task-conversations", taskId),
  getConversationMessages: (taskId, conversationId) =>
    ipcRenderer.invoke("get-conversation-messages", { taskId, conversationId }),
  postConversationMessage: (message) => ipcRenderer.invoke("post-conversation-message", message),
  resumeAgent: (agentId) => ipcRenderer.invoke("resume-agent", agentId),
  listMcpIntegrations: (taskId) => ipcRenderer.invoke("list-mcp-integrations", taskId),
  getPausedAgents: () => ipcRenderer.invoke("get-paused-agents"),
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
  getOnboardingProfile: () => ipcRenderer.invoke("get-onboarding-profile"),
  saveOnboardingKeys: (key) => ipcRenderer.invoke("save-onboarding-keys", key),
  saveOnboardingProfile: (profile) =>
    ipcRenderer.invoke("save-onboarding-profile", profile),
  parseResume: (text) => ipcRenderer.invoke("parse-resume", text),
});
