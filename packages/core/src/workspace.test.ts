import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "./workspace.js";

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
        expect.objectContaining({ handle: "@sage-1", status: "completed" }),
      ]),
    );
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
