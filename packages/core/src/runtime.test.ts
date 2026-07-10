import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskPlan } from "@yaaa/shared";
import { createRuntime } from "./runtime.js";

const temporaryDirectories: string[] = [];

function createTestRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaaa-runtime-"));
  temporaryDirectories.push(root);
  const taskId = "runtime-test-task";
  const events: any[] = [];
  const runtime = createRuntime({
    taskId,
    tasksBaseDir: path.join(root, "tasks"),
    workingDir: path.join(root, "working"),
    onEvent: (event) => events.push(event),
  });
  return { runtime, taskId, events };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("createRuntime", () => {
  it("creates, persists, and emits a draft plan without running agents", async () => {
    const { runtime, taskId, events } = createTestRuntime();
    try {
      const plan = await runtime.plan(
        "Create a file named runtime.txt with a short note",
      );

      expect(plan.subtasks.length).toBeGreaterThan(0);
      await expect(runtime.store.getPlan(taskId)).resolves.toEqual(plan);
      expect(events).toEqual(
        expect.arrayContaining([
          { type: "task-started", taskId },
          { type: "plan-updated", plan },
        ]),
      );
    } finally {
      runtime.dispose();
    }
  });

  it("runs a previously reviewed plan and emits completion", async () => {
    const { runtime, events } = createTestRuntime();
    const plan: TaskPlan = { goal: "No-op review", subtasks: [] };
    try {
      const result = await runtime.runPlan(plan);

      expect(result.success).toBe(true);
      expect(result.plan).toEqual(plan);
      expect(events).toContainEqual({ type: "complete", result });
    } finally {
      runtime.dispose();
    }
  });

  it("cooperatively stops before starting cancelled work", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaaa-runtime-"));
    temporaryDirectories.push(root);
    let cancelled = false;
    const runtime = createRuntime({
      taskId: "cancelled-task",
      tasksBaseDir: path.join(root, "tasks"),
      workingDir: path.join(root, "working"),
      isCancelled: () => cancelled,
    });
    cancelled = true;

    try {
      await expect(
        runtime.runPlan({ goal: "cancel", subtasks: [] }),
      ).rejects.toThrow("Task was cancelled.");
    } finally {
      runtime.dispose();
    }
  });

  it("scaffolds agent HANDS_ON and HANDS_OFF documents from lifecycle events", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaaa-runtime-"));
    temporaryDirectories.push(root);
    const taskId = "agent-doc-task";
    const tasksBaseDir = path.join(root, "tasks");
    const runtime = createRuntime({
      taskId,
      tasksBaseDir,
      workingDir: path.join(root, "working"),
      onApproval: async () => true,
    });
    const plan: TaskPlan = {
      goal: "Create a lifecycle artifact",
      subtasks: [
        {
          id: "write-report",
          title: "Write the reviewed report",
          capability: "files",
          dependsOn: [],
          riskLevel: "low",
          successCriteria: "A report is written",
          state: "pending",
        },
      ],
    };

    try {
      await runtime.runPlan(plan);
      const agentRoot = path.join(tasksBaseDir, taskId, "agent-workspaces");
      const [agentId] = fs.readdirSync(agentRoot);
      const agentDir = path.join(agentRoot, agentId);
      const handsOn = fs.readFileSync(
        path.join(agentDir, "HANDS_ON.md"),
        "utf-8",
      );
      const handsOff = fs.readFileSync(
        path.join(agentDir, "HANDS_OFF.md"),
        "utf-8",
      );

      expect(handsOn).toContain("Write the reviewed report");
      expect(handsOn).toContain("A report is written");
      expect(handsOff).toContain("## Changed Files");
      expect(handsOff).toContain("## Tests");
      expect(handsOff).toContain("## Risks");
      expect(handsOff).toContain("- Status: completed");
    } finally {
      runtime.dispose();
    }
  });

  it("runs the complete lifecycle without an event sink", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaaa-runtime-"));
    temporaryDirectories.push(root);
    const runtime = createRuntime({
      taskId: "complete-lifecycle-task",
      tasksBaseDir: path.join(root, "tasks"),
      workingDir: path.join(root, "working"),
      onApproval: async () => true,
    });

    try {
      const result = await runtime.run("Create a short deterministic report");
      expect(result.success).toBe(true);
      expect(result.plan?.subtasks.length).toBeGreaterThan(0);
    } finally {
      runtime.dispose();
    }
  });
});
