export interface UIArtifact {
  path: string;
  mimeType: string;
  description: string;
}

export interface UISubtask {
  id: string;
  title: string;
  capability: string;
  dependsOn: string[];
  riskLevel: string;
  successCriteria: string;
  state: "pending" | "running" | "completed" | "failed";
}

export interface UITask {
  id: string;
  prompt: string;
  status: string;
  created_at: string;
}

export class TaskModel {
  static getElectronAPI() {
    const api = (window as any).electronAPI;
    if (!api) {
      throw new Error("Electron API context bridge not found.");
    }
    return api;
  }

  static async startTask(goal: string): Promise<string> {
    return this.getElectronAPI().startTask(goal);
  }

  static async resolveApproval(callId: string, approved: boolean): Promise<any> {
    return this.getElectronAPI().resolveApproval(callId, approved);
  }

  static async listTasks(): Promise<UITask[]> {
    return this.getElectronAPI().listTasks();
  }

  static async readTaskOrchestrator(taskId: string): Promise<string | null> {
    return this.getElectronAPI().readTaskOrchestrator(taskId);
  }

  static async getTaskHistory(taskId: string): Promise<any[]> {
    return this.getElectronAPI().getTaskHistory(taskId);
  }

  static async getYaaaDir(): Promise<string> {
    return this.getElectronAPI().getYaaaDir();
  }

  static subscribeEvents(
    onEvent: (eventData: { topic: string; data: any }) => void,
    onApproval: (approvalData: { agentId: string; toolCall: any }) => void,
    onComplete: (resultData: { success: boolean; summary: string }) => void
  ): () => void {
    const api = this.getElectronAPI();

    const unsubEvent = api.onTaskEvent(onEvent);
    const unsubApproval = api.onApprovalRequired(onApproval);
    const unsubComplete = api.onComplete(onComplete);

    return () => {
      unsubEvent();
      unsubApproval();
      unsubComplete();
    };
  }
}
