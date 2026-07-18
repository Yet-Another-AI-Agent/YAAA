import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workspace, buildStrategyAcknowledgement } from "./workspace.js";

const temporaryDirectories: string[] = [];

function createWorkspace(): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaaa-workspace-"));
  temporaryDirectories.push(root);
  return new Workspace(root);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Workspace", () => {
  it("builds a concise pre-plan acknowledgement that honors explicit agent count", () => {
    expect(
      buildStrategyAcknowledgement(
        "spin 2 agents and one to write Python code and another to test",
      ),
    ).toBe(
      "Got it — I’ll prepare a strategy using exactly 2 agents, preserving the roles you requested. You can review it before any agent starts.",
    );
    expect(buildStrategyAcknowledgement("Build a Python tool")).toContain(
      "implementation strategy",
    );
  });

  it("emits the acknowledgement before returning a plan for review", async () => {
    const workspace = createWorkspace();
    const goal = "spin 2 agents and one to write Python code and another to test";
    const task = workspace.createTask(goal);
    vi.spyOn(workspace, "routeUserMessage").mockResolvedValue({ kind: "task" });
    vi.spyOn(workspace, "evaluateConversationalOnboarding").mockResolvedValue({
      thought: "A plan is appropriate.",
      reply: "",
      action: "prepare_plan",
    });
    vi.spyOn(workspace as any, "generateStrategyAcknowledgement").mockResolvedValue(
      buildStrategyAcknowledgement(goal)
    );
    vi.spyOn(workspace, "prepareTask").mockResolvedValue({ goal, subtasks: [] });
    const events: any[] = [];

    const result = await workspace.startConversationalOnboarding(task.taskId, goal, {
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({
      kind: "task",
      reply: expect.stringContaining("exactly 2 agents"),
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "status",
        note: expect.stringContaining("review it before any agent starts"),
      }),
    );
  });

  it("persists plan proposals and review actions in task history", async () => {
    const workspace = createWorkspace();
    const task = workspace.createTask("Build a Python tool");

    await workspace.recordPlanReviewMessage(
      task.taskId,
      "[plan-proposal] Implementation plan ready for review.",
      "orchestrator",
    );
    await workspace.recordPlanReviewMessage(
      task.taskId,
      "Accepted the implementation plan with comments:\nkeep it small",
      "user",
    );

    await expect(workspace.getTaskHistory(task.taskId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "thought",
          from: "orchestrator",
          content: expect.stringContaining("[plan-proposal]"),
        }),
        expect.objectContaining({
          kind: "thought",
          from: "user",
          content: expect.stringContaining("keep it small"),
        }),
      ]),
    );
  });
  it("persists onboarding configuration without exposing a missing profile", () => {
    const workspace = createWorkspace();

    expect(workspace.getOnboardingStatus()).toEqual({
      hasKey: false,
      hasProfile: false,
      skipped: false,
    });
    workspace.saveKey("test-key");
    workspace.saveProfile({
      name: "Ada",
      profession: "Engineer",
      description: "Builds systems",
    });

    expect(workspace.getOnboardingStatus()).toEqual({
      hasKey: true,
      hasProfile: true,
      skipped: false,
    });
    expect(workspace.getOnboardingProfile()).toEqual({
      name: "Ada",
      profession: "Engineer",
      description: "Builds systems",
    });
  });

  it("keeps a task inert until its generated plan is explicitly confirmed", async () => {
    const workspace = createWorkspace();
    const task = workspace.createTask(
      "Create a file named workspace.txt with a short note",
    );

    expect(workspace.listTasks()[0]).toMatchObject({
      id: task.taskId,
      status: "planning",
    });
    const plan = await workspace.prepareTask(
      "Create a file named workspace.txt with a short note",
      task,
    );

    expect(plan.subtasks.length).toBeGreaterThan(0);
    expect(workspace.listTasks()[0]).toMatchObject({
      id: task.taskId,
      status: "awaiting_confirmation",
    });
    expect(workspace.readOrchestrator(task.taskId)).toContain(
      "awaiting_confirmation",
    );
    await expect(workspace.getTaskAgents(task.taskId)).resolves.toEqual([]);

    const result = await workspace.confirmTask(task.taskId);
    expect(result.success).toBe(true);
    expect(workspace.listTasks()[0]).toMatchObject({
      id: task.taskId,
      status: "success",
    });
    await expect(workspace.getTaskAgents(task.taskId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ handle: expect.stringMatching(/^@[a-z0-9-]+-1$/), status: "completed" }),
      ]),
    );
  });

  it("continues an existing mission in the same channel instead of creating a new task", async () => {
    const workspace = createWorkspace();
    const task = workspace.createTask("Create a file named notes.txt");
    await workspace.prepareTask("Create a file named notes.txt", task);
    await workspace.confirmTask(task.taskId);
    expect(workspace.listTasks()).toHaveLength(1);

    const result = await workspace.continueMission(task.taskId, "Now add a second note");
    expect(result.kind).toBe("task");
    const plan = result.kind === "task" ? result.plan : null;
    expect(plan?.subtasks.length).toBeGreaterThan(0);

    // No new channel/task was created — same id, still one task.
    expect(workspace.listTasks()).toHaveLength(1);
    expect(workspace.listTasks()[0].id).toBe(task.taskId);
    // The follow-up produced a fresh plan awaiting confirmation on the same task.
    expect(workspace.listTasks()[0].status).toBe("awaiting_confirmation");

    // The follow-up message is persisted in the mission's conversation.
    const conversations = await workspace.getTaskConversations(task.taskId);
    const publicConv = conversations.find((c) => c.kind === "public");
    expect(publicConv).toBeTruthy();
    const messages = await workspace.getConversationMessages(task.taskId, publicConv!.id);
    expect(messages.some((m) => m.content === "Now add a second note")).toBe(true);
  });

  it("refuses to continue an unknown mission", async () => {
    const workspace = createWorkspace();
    await expect(workspace.continueMission("not-a-real-task", "hi")).rejects.toThrow(
      "Task not found.",
    );
  });

  it("answers a conversational follow-up in-channel without re-planning", async () => {
    const workspace = createWorkspace();
    const task = workspace.createTask("Create a file named notes.txt");
    await workspace.prepareTask("Create a file named notes.txt", task);
    await workspace.confirmTask(task.taskId);

    // Force the intent gate to classify the follow-up as small talk.
    vi.spyOn(workspace, "routeUserMessage").mockResolvedValue({
      kind: "conversation",
      reply: "I created notes.txt with your note earlier. Anything else?",
    });

    const events: any[] = [];
    const result = await workspace.continueMission(task.taskId, "what did you do?", {
      onEvent: (e) => events.push(e),
    });

    expect(result.kind).toBe("conversation");
    if (result.kind === "conversation") {
      expect(result.reply).toContain("notes.txt");
    }
    // No re-plan: the task stays in its completed state, still one task.
    expect(workspace.listTasks()).toHaveLength(1);
    expect(workspace.listTasks()[0].status).toBe("success");
    // The reply was emitted as an orchestrator status event...
    expect(events.some((e) => e.type === "status" && e.from === "orchestrator")).toBe(true);
    // ...and persisted (user question + orchestrator reply) in the channel.
    const conversations = await workspace.getTaskConversations(task.taskId);
    const publicConv = conversations.find((c) => c.kind === "public");
    const messages = await workspace.getConversationMessages(task.taskId, publicConv!.id);
    expect(messages.some((m) => m.content === "what did you do?")).toBe(true);
    expect(messages.some((m) => m.authorKind === "orchestrator")).toBe(true);
  });

  it("surfaces a direct_execute answer once — persisted, not re-emitted as a status event", async () => {
    const workspace = createWorkspace();
    const goal = "give me the trapping rain water code";
    const task = workspace.createTask(goal);

    // Skip the small-talk gate so onboarding reaches the evaluation step.
    vi.spyOn(workspace, "routeUserMessage").mockResolvedValue({ kind: "task" });
    const reply =
      'Here you go:\n```yaaa-viewer\n{"type":"code","source":{"content":"function trap(){ return 0; }"},"language":"javascript"}\n```';
    vi.spyOn(workspace, "evaluateConversationalOnboarding").mockResolvedValue({
      thought: "Simple query — answer directly.",
      reply,
      action: "direct_execute",
    });

    const events: any[] = [];
    const result = await workspace.startConversationalOnboarding(task.taskId, goal, {
      onEvent: (e) => events.push(e),
    });

    expect(result).toMatchObject({ kind: "direct_execute", reply });
    // The reply reaches the renderer once via the task-complete summary
    // (main.js). It must NOT also be re-emitted as an orchestrator status event,
    // or the UI renders the same answer — and its viewer — twice.
    expect(events.some((e) => e.type === "status" && e.note === reply)).toBe(false);
    // It is still persisted in the channel for history/reload.
    const conversations = await workspace.getTaskConversations(task.taskId);
    const publicConv = conversations.find((c) => c.kind === "public");
    const messages = await workspace.getConversationMessages(task.taskId, publicConv!.id);
    expect(messages.some((m) => m.content === reply)).toBe(true);
  });

  it("generates a channel topic alongside the plan without blocking it", async () => {
    const workspace = createWorkspace();
    const task = workspace.createTask(
      "Create a file named workspace.txt with a short note",
    );

    expect(workspace.listTasks()[0].topic).toBeNull();
    await workspace.prepareTask(
      "Create a file named workspace.txt with a short note",
      task,
    );

    // Topic generation is fire-and-forget alongside planning; give its promise
    // a tick to settle before asserting the persisted row.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(workspace.listTasks()[0].topic).toBeTruthy();
  });

  it("permanently purges a task's row and on-disk directory", () => {
    const workspace = createWorkspace();
    const task = workspace.createTask("Delete me later");

    expect(workspace.listTasks()).toHaveLength(1);
    expect(fs.existsSync(task.taskDir)).toBe(true);

    workspace.deleteTask(task.taskId);

    expect(workspace.listTasks()).toHaveLength(0);
    expect(fs.existsSync(task.taskDir)).toBe(false);
  });

  it("rejects deleting an unknown task", () => {
    const workspace = createWorkspace();
    expect(() => workspace.deleteTask("not-a-real-task")).toThrow(
      "Task not found.",
    );
  });

  it("reads a generated artifact's text content for in-app preview", () => {
    const workspace = createWorkspace();
    const task = workspace.createTask("Write a report");
    fs.writeFileSync(
      path.join(task.workingDir, "summary.md"),
      "# Hello\n\nSome text.",
      "utf-8",
    );

    expect(workspace.readArtifact(task.taskId, "summary.md")).toBe(
      "# Hello\n\nSome text.",
    );
  });

  it("returns null for a missing artifact instead of throwing", () => {
    const workspace = createWorkspace();
    const task = workspace.createTask("Write a report");
    expect(workspace.readArtifact(task.taskId, "does-not-exist.md")).toBeNull();
  });

  it("refuses to read a path that escapes the task's working directory", () => {
    const workspace = createWorkspace();
    const task = workspace.createTask("Write a report");
    expect(
      workspace.readArtifact(task.taskId, "../../orchestrator.md"),
    ).toBeNull();
    expect(workspace.readArtifact(task.taskId, "../secrets.txt")).toBeNull();
  });

  it("refuses artifact symlink escapes and non-regular files", () => {
    const workspace = createWorkspace();
    const task = workspace.createTask("Write a report");
    const secret = path.join(path.dirname(task.taskDir), "secret.txt");
    fs.writeFileSync(secret, "private", "utf-8");
    fs.symlinkSync(secret, path.join(task.workingDir, "report.md"));
    fs.mkdirSync(path.join(task.workingDir, "folder.md"));

    expect(workspace.readArtifact(task.taskId, "report.md")).toBeNull();
    expect(workspace.readArtifact(task.taskId, "folder.md")).toBeNull();
  });

  it("does not create orphan task databases for history or agent reads", async () => {
    const workspace = createWorkspace();
    const root = workspace.getYaaaDir();

    await expect(workspace.getTaskHistory("missing-task")).rejects.toThrow(
      "Task not found.",
    );
    await expect(workspace.getTaskAgents("missing-task")).rejects.toThrow(
      "Task not found.",
    );
    expect(fs.existsSync(path.join(root, "tasks", "missing-task"))).toBe(false);
  });

  it("rejects confirmation for an unknown or non-reviewable task", async () => {
    const workspace = createWorkspace();
    const task = workspace.createTask("Not prepared");

    await expect(workspace.confirmTask("not-a-real-task")).rejects.toThrow(
      "Task not found.",
    );
    await expect(workspace.confirmTask(task.taskId)).rejects.toThrow(
      "Task is not awaiting plan confirmation.",
    );
    expect(workspace.readOrchestrator("../escape")).toBeNull();
    await expect(workspace.getTaskHistory("../escape")).rejects.toThrow(
      "Task not found.",
    );
  });

  it("claims confirmation once when callers race", async () => {
    const workspace = createWorkspace();
    const task = workspace.createTask("Create a file");
    await workspace.prepareTask("Create a file", task);

    const first = workspace.confirmTask(task.taskId);
    await expect(workspace.confirmTask(task.taskId)).rejects.toThrow(
      "not awaiting plan confirmation",
    );
    await expect(first).resolves.toMatchObject({ success: true });
  });

  it("does not recreate a task deleted while execution is in flight", async () => {
    const workspace = createWorkspace();
    const task = workspace.createTask("Create a file");
    await workspace.prepareTask("Create a file", task);

    const run = workspace.confirmTask(task.taskId);
    workspace.deleteTask(task.taskId);

    await expect(run).rejects.toThrow("Task was deleted.");
    expect(workspace.listTasks()).toHaveLength(0);
    expect(fs.existsSync(task.taskDir)).toBe(false);
  });

  it("answers a greeting conversationally without creating any task state", async () => {
    const workspace = createWorkspace();

    const routed = await workspace.routeUserMessage("hi");

    expect(routed.kind).toBe("conversation");
    if (routed.kind === "conversation") {
      expect(routed.reply.length).toBeGreaterThan(0);
    }
    // The "Hi" bug: no task row, folder, or plan may exist after small talk.
    expect(workspace.listTasks()).toHaveLength(0);
    expect(fs.existsSync(path.join(workspace.getYaaaDir(), "tasks"))).toBe(
      false,
    );
  });

  it("routes an actionable request to the task pipeline", async () => {
    const workspace = createWorkspace();

    const routed = await workspace.routeUserMessage(
      "Create a file named workspace.txt with a short note",
    );

    expect(routed).toEqual({ kind: "task" });
  });

  it("reads an image artifact as a data URL and refuses non-images and escapes", () => {
    const workspace = createWorkspace();
    const task = workspace.createTask("Design a logo");
    // Minimal valid PNG header bytes are irrelevant — only containment and
    // encoding are under test here.
    fs.writeFileSync(path.join(task.workingDir, "logo.png"), Buffer.from([1, 2, 3]));

    const image = workspace.readArtifactBinary(task.taskId, "logo.png");
    expect(image?.mimeType).toBe("image/png");
    expect(image?.dataUrl).toBe(
      `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`,
    );

    expect(workspace.readArtifactBinary(task.taskId, "missing.png")).toBeNull();
    expect(workspace.readArtifactBinary(task.taskId, "notes.txt")).toBeNull();
    expect(
      workspace.readArtifactBinary(task.taskId, "../orchestrator.md"),
    ).toBeNull();
  });

  it("saves artifact annotations and routes the JSON payload to the orchestrator", async () => {
    const workspace = createWorkspace();
    const task = workspace.createTask("Design a pamphlet");
    fs.writeFileSync(path.join(task.workingDir, "pamphlet.md"), "# Draft", "utf-8");

    const result = await workspace.saveArtifactAnnotations(
      task.taskId,
      "pamphlet.md",
      [{ x: 10, y: 20, width: 120, height: 40, comment: "Logo is misaligned" }],
    );

    const saved = JSON.parse(fs.readFileSync(result.annotationPath, "utf-8"));
    expect(saved.artifactPath).toBe("pamphlet.md");
    expect(saved.annotations[0].comment).toBe("Logo is misaligned");
    expect(result.routes).toEqual([
      expect.objectContaining({ recipientKind: "orchestrator" }),
    ]);

    // The payload landed in the mission's public conversation.
    const conversations = await workspace.getTaskConversations(task.taskId);
    const publicChannel = conversations.find((c) => c.kind === "public");
    expect(publicChannel).toBeDefined();
    const messages = await workspace.getConversationMessages(
      task.taskId,
      publicChannel!.id,
    );
    expect(messages[0].content).toContain("Visual feedback on pamphlet.md");
    expect(messages[0].content).toContain("Logo is misaligned");
  });

  it("persists line comments with exact locations and routes them to the orchestrator", async () => {
    const workspace = createWorkspace();
    const task = workspace.createTask("Review a plan");
    fs.writeFileSync(path.join(task.workingDir, "plan.md"), "# Plan\n- Deploy", "utf-8");
    const comments = [{ line: 2, quote: "- Deploy", comment: "Add rollback steps" }];
    const result = await workspace.saveLineComments(task.taskId, "plan.md", comments);
    expect(JSON.parse(fs.readFileSync(result.annotationPath, "utf-8")).comments).toEqual(comments);
    const conversation = (await workspace.getTaskConversations(task.taskId)).find((item) => item.kind === "public");
    const messages = await workspace.getConversationMessages(task.taskId, conversation!.id);
    expect(messages[0].content).toContain("line 2");
    expect(messages[0].content).toContain("Add rollback steps");
  });

  it("rejects annotations for missing artifacts or empty comments", async () => {
    const workspace = createWorkspace();
    const task = workspace.createTask("Design a pamphlet");
    fs.writeFileSync(path.join(task.workingDir, "pamphlet.md"), "# Draft", "utf-8");

    await expect(
      workspace.saveArtifactAnnotations(task.taskId, "missing.png", [
        { x: 0, y: 0, width: 10, height: 10, comment: "hello" },
      ]),
    ).rejects.toThrow("not found");
    await expect(
      workspace.saveArtifactAnnotations(task.taskId, "../orchestrator.md", [
        { x: 0, y: 0, width: 10, height: 10, comment: "escape" },
      ]),
    ).rejects.toThrow("not found");
    await expect(
      workspace.saveArtifactAnnotations(task.taskId, "pamphlet.md", [
        { x: 0, y: 0, width: 10, height: 10, comment: "   " },
      ]),
    ).rejects.toThrow("bounding box and a comment");
    await expect(
      workspace.saveArtifactAnnotations(task.taskId, "pamphlet.md", [
        { x: Number.NaN, y: 0, width: 10, height: 10, comment: "bad box" },
      ]),
    ).rejects.toThrow("bounding box and a comment");
  });

  it("provisions a trusted MCP integration and enables it, refusing untrusted ones", async () => {
    const workspace = createWorkspace();
    const scope = { kind: "global" } as const;
    workspace.registerMcpIntegration(scope, {
      id: "code-review-graph",
      displayName: "Code Review Graph",
      transport: { kind: "stdio", command: "node" },
    });
    const runner = async (command: string, args: string[]) => {
      if (command === "git") {
        fs.mkdirSync(args[args.length - 1], { recursive: true });
      }
    };

    // Consent has not been granted yet — the fetcher must refuse.
    await expect(
      workspace.provisionMcpIntegration(
        scope,
        "code-review-graph",
        { repoUrl: "https://github.com/example/mcp.git" },
        runner,
      ),
    ).rejects.toThrow("must be trusted");

    workspace.updateMcpIntegrationState(scope, "code-review-graph", {
      trust: "trusted",
    });
    const result = await workspace.provisionMcpIntegration(
      scope,
      "code-review-graph",
      { repoUrl: "https://github.com/example/mcp.git" },
      runner,
    );

    expect(result.installDir).toContain("mcp-servers");
    expect(
      workspace.getMcpIntegration(scope, "code-review-graph")?.state,
    ).toEqual({ trust: "trusted", enabled: true });
  });

  it("pauses a mentioned agent's loop and resumes it explicitly", async () => {
    const workspace = createWorkspace();
    const task = workspace.createTask("Create a file named notes.txt");
    await workspace.prepareTask("Create a file named notes.txt", task);
    await workspace.confirmTask(task.taskId);

    const agents = await workspace.getTaskAgents(task.taskId);
    const worker = agents.find((agent) => agent.handle.endsWith("-1"));
    expect(worker).toBeDefined();

    const conversation = await workspace.createPublicConversation(task.taskId);
    const posted = await workspace.postConversationMessage({
      taskId: task.taskId,
      conversationId: conversation.id,
      authorId: "user-1",
      authorKind: "user",
      content: `${worker!.handle} please pause and explain your approach`,
    });

    expect(posted.pausedAgentIds).toEqual([worker!.id]);
    expect(workspace.getPausedAgents()).toContain(worker!.id);
    expect(workspace.resumeAgent(worker!.id)).toBe(true);
    expect(workspace.getPausedAgents()).not.toContain(worker!.id);

    // Agent-authored messages never pause colleagues.
    const fromAgent = await workspace.postConversationMessage({
      taskId: task.taskId,
      conversationId: conversation.id,
      authorId: worker!.id,
      authorKind: "agent",
      content: `@orchestrator and ${worker!.handle} are discussing`,
    });
    expect(fromAgent.pausedAgentIds).toEqual([]);
  });

  it("persists a mission chat and exposes its routed orchestrator mention", async () => {
    const workspace = createWorkspace();
    const task = workspace.createTask("Coordinate a release");
    const conversation = await workspace.createPublicConversation(task.taskId);
    const posted = await workspace.postConversationMessage({
      taskId: task.taskId,
      conversationId: conversation.id,
      authorId: "user-1",
      authorKind: "user",
      content: "@orchestrator please define the boundary",
    });

    await expect(
      workspace.getTaskConversations(task.taskId),
    ).resolves.toContainEqual(conversation);
    await expect(
      workspace.getConversationMessages(task.taskId, conversation.id),
    ).resolves.toEqual([posted.message]);
    expect(posted.routes).toEqual([
      expect.objectContaining({
        recipientId: "orchestrator",
        recipientKind: "orchestrator",
      }),
    ]);
  });
});
