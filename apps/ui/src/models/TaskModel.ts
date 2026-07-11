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
  topic?: string | null;
}

export interface UIAgent {
  id: string;
  handle: string;
  displayName: string;
  taskId: string;
  subtaskId: string;
  role: string;
  modelRole: string;
  status: "planned" | "working" | "blocked" | "completed" | "failed" | "exited";
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
}

export interface UIConversation {
  id: string;
  taskId: string;
  kind: "public" | "agent_thread";
  title: string;
  participantIds: string[];
  agentId?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface UIConversationMessage {
  id: string;
  taskId: string;
  conversationId: string;
  authorId: string;
  authorKind: "user" | "orchestrator" | "agent" | "system";
  content: string;
  createdAt: string;
}

export class TaskModel {
  static getElectronAPI() {
    const api = (window as any).electronAPI;
    if (!api) {
      throw new Error("Electron API context bridge not found.");
    }
    return api;
  }

  /**
   * Ask the orchestrator's NLP layer whether a message is casual conversation
   * or an actionable mission. Conversational messages come back with a reply
   * and must not start a task.
   */
  static async routeUserMessage(
    message: string,
  ): Promise<{ kind: "conversation"; reply: string } | { kind: "task" }> {
    return this.getElectronAPI().routeUserMessage(message);
  }

  static async startTask(goal: string): Promise<string> {
    return this.getElectronAPI().startTask(goal);
  }

  /**
   * Send a follow-up message to an existing mission. Re-plans on the SAME
   * task/channel instead of creating a new one.
   */
  static async continueTask(
    taskId: string,
    message: string,
  ): Promise<{ status: "conversation" | "task" | "cancelled" | "error"; error?: string }> {
    return this.getElectronAPI().continueTask(taskId, message);
  }

  static async confirmTask(taskId: string): Promise<{ status: string }> {
    return this.getElectronAPI().confirmTask(taskId);
  }


  static async resolveApproval(
    callId: string,
    approved: boolean,
  ): Promise<any> {
    return this.getElectronAPI().resolveApproval(callId, approved);
  }

  static async listTasks(): Promise<UITask[]> {
    return this.getElectronAPI().listTasks();
  }

  static async deleteTask(taskId: string): Promise<{ status: string }> {
    return this.getElectronAPI().deleteTask(taskId);
  }

  static async readTaskOrchestrator(taskId: string): Promise<string | null> {
    return this.getElectronAPI().readTaskOrchestrator(taskId);
  }

  static async readArtifact(taskId: string, artifactPath: string): Promise<string | null> {
    return this.getElectronAPI().readArtifact(taskId, artifactPath);
  }

  /** Registered MCP servers (global + task scope) for the Active Integrations panel. */
  static async listMcpIntegrations(taskId?: string): Promise<
    Array<{
      definition: { id: string; displayName: string };
      state: { trust: "trusted" | "untrusted"; enabled: boolean };
    }>
  > {
    return this.getElectronAPI().listMcpIntegrations(taskId);
  }

  /** Read a binary artifact (image) as a data URL for in-app preview. */
  static async readArtifactBinary(
    taskId: string,
    artifactPath: string,
  ): Promise<{ dataUrl: string; mimeType: string } | null> {
    return this.getElectronAPI().readArtifactBinary(taskId, artifactPath);
  }

  /**
   * Persist canvas-commenter bounding boxes for an artifact; the backend
   * routes the JSON payload to @orchestrator for the owning agent to fix.
   */
  static async saveArtifactAnnotations(
    taskId: string,
    artifactPath: string,
    annotations: Array<{ x: number; y: number; width: number; height: number; comment: string }>,
  ): Promise<{ annotationPath: string; routes: unknown[] }> {
    return this.getElectronAPI().saveArtifactAnnotations(taskId, artifactPath, annotations);
  }
  /**
   * Retrieves the complete execution log and chat history messages for a specific task.
   * @param {string} taskId - The unique identifier of the task.
   * @returns {Promise<any[]>} A promise resolving to an array of log/chat message objects.
   */
  static async getTaskHistory(taskId: string): Promise<any[]> {
    return this.getElectronAPI().getTaskHistory(taskId);
  }

  static async getTaskAgents(taskId: string): Promise<UIAgent[]> {
    return this.getElectronAPI().getTaskAgents(taskId);
  }

  static async createPublicConversation(taskId: string, title?: string): Promise<UIConversation> {
    return this.getElectronAPI().createPublicConversation(taskId, title);
  }

  static async getTaskConversations(taskId: string): Promise<UIConversation[]> {
    return this.getElectronAPI().getTaskConversations(taskId);
  }

  static async getConversationMessages(
    taskId: string,
    conversationId: string,
  ): Promise<UIConversationMessage[]> {
    return this.getElectronAPI().getConversationMessages(taskId, conversationId);
  }

  static async postConversationMessage(message: Omit<UIConversationMessage, "id" | "createdAt">) {
    return this.getElectronAPI().postConversationMessage(message);
  }

  /**
   * Retrieves the absolute path to the YAAA data directory.
   */
  static async getYaaaDir(): Promise<string> {
    return this.getElectronAPI().getYaaaDir();
  }

  /**
   * Checks the onboarding status (Mesh API keys and user profile details existence).
   */
  static async getOnboardingStatus(): Promise<{
    hasKey: boolean;
    hasProfile: boolean;
    skipped: boolean;
  }> {
    return this.getElectronAPI().getOnboardingStatus();
  }

  /**
   * Retrieves the saved onboarding personalization profile (name, profession, description).
   */
  static async getOnboardingProfile(): Promise<{
    name: string;
    profession: string;
    description: string;
  }> {
    return this.getElectronAPI().getOnboardingProfile();
  }

  /**
   * Saves the Mesh API Access Key to the central config.
   */
  static async saveOnboardingKeys(key: string): Promise<{ success: boolean }> {
    return this.getElectronAPI().saveOnboardingKeys(key);
  }

  /**
   * Saves the user profile configuration details (name, profession, bio).
   */
  static async saveOnboardingProfile(profile: {
    name?: string;
    profession?: string;
    description?: string;
    skip?: boolean;
  }): Promise<{ success: boolean }> {
    return this.getElectronAPI().saveOnboardingProfile(profile);
  }

  /**
   * Parses resume text content via the AI LLM parser subprocess.
   */
  static async parseResume(text: string): Promise<any> {
    return this.getElectronAPI().parseResume(text);
  }

  static subscribeEvents(
    onEvent: (eventData: { topic: string; data: any }) => void,
    onApproval: (approvalData: { agentId: string; toolCall: any }) => void,
    onComplete: (resultData: {
      success: boolean;
      summary: string;
      reason?: string;
    }) => void,
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
