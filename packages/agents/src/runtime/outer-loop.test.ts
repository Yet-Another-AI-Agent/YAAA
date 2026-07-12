import { describe, it, expect, vi, beforeEach } from "vitest";
import { container, PermissionEngine } from "@yaaa/platform";
import type { IBus, IStore, ModelRole } from "@yaaa/interfaces";
import type { TaskPlan } from "@yaaa/shared";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { OuterLoop } from "./outer-loop.js";

/**
 * The outer loop's job is orchestration — dependency ordering, concurrency, the
 * retry/kill-switch state machine — not agent internals. So we control what each
 * inner agent does purely through the chat model the runtime hands it: a shared
 * `responder` decides, per model turn, whether the agent finishes (returns an
 * AIMessage), fails (throws), or parks (returns a pending promise).
 */
type Responder = (role: ModelRole, messages: BaseMessage[]) => Promise<AIMessage>;

interface CapturedCall {
  role: ModelRole;
  messages: BaseMessage[];
}

class ProgrammableChatModel extends BaseChatModel {
  constructor(
    private readonly role: ModelRole,
    private readonly responder: () => Responder,
    private readonly captured: CapturedCall[],
  ) {
    super({});
  }
  _llmType() {
    return "programmable-test-model";
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.captured.push({ role: this.role, messages });
    const message = await this.responder()(this.role, messages);
    const text = typeof message.content === "string" ? message.content : "";
    return { generations: [{ text, message }] };
  }
  override bindTools() {
    return this;
  }
}

const finalMessage = (text: string) => new AIMessage({ content: text });

describe("OuterLoop Manager", () => {
  let mockBus: IBus;
  let mockStore: IStore;
  let permissions: PermissionEngine;
  let outerLoop: OuterLoop;
  let captured: CapturedCall[];
  // Default: every agent finishes immediately with a generic summary.
  let responder: Responder = async (role) =>
    role === "verifier" ? finalMessage("Looks good.\nVERDICT: PASSED") : finalMessage("Subtask completed.");

  beforeEach(() => {
    container.clear();
    captured = [];
    responder = async (role) =>
      role === "verifier" ? finalMessage("Looks good.\nVERDICT: PASSED") : finalMessage("Subtask completed.");

    mockBus = { publish: vi.fn(), subscribe: vi.fn() } as any;
    mockStore = {
      initTaskDb: vi.fn(),
      saveMessage: vi.fn(),
      getMessages: vi.fn(),
      savePlan: vi.fn(),
      getPlan: vi.fn(),
      saveLedgerEntry: vi.fn(),
      getLedgerEntries: vi.fn(),
      saveAuditLog: vi.fn(),
      getAuditLogs: vi.fn(),
      saveAgent: vi.fn(),
      getAgents: vi.fn(),
    } as any;
    permissions = new PermissionEngine();

    container.register("IBus", mockBus);
    container.register("IStore", mockStore);
    container.register("PermissionEngine", permissions);
    container.register("capability:files", {
      readFile: vi.fn().mockResolvedValue(""),
      writeFile: vi.fn().mockResolvedValue(undefined),
      listFiles: vi.fn().mockResolvedValue([]),
      searchFiles: vi.fn().mockResolvedValue([]),
    });
    container.register(
      "ChatModelFactory",
      (role: ModelRole) => new ProgrammableChatModel(role, () => responder, captured),
    );

    outerLoop = new OuterLoop();
  });

  it("should execute sequential plan subtasks matching dependencies", async () => {
    const plan: TaskPlan = {
      goal: "Run test task",
      subtasks: [
        { id: "task-1", title: "Write file facts", capability: "files", dependsOn: [], riskLevel: "low", successCriteria: "file exists", state: "pending" },
        { id: "task-2", title: "Verify task facts contents", capability: "verify", dependsOn: ["task-1"], riskLevel: "low", successCriteria: "facts verified", state: "pending" },
      ],
    };

    await expect(outerLoop.run("task-123", plan)).resolves.not.toThrow();

    expect(mockStore.savePlan).toHaveBeenCalledWith("task-123", plan);
    expect(mockStore.saveLedgerEntry).toHaveBeenCalled();
    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-123.started",
      expect.objectContaining({ kind: "status", state: "working" }),
    );
    expect(mockStore.saveAgent).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({ handle: "@sage-1", status: "working" }),
    );
  });

  it("should throw an error if a subtask dependency loop or deadlock is detected", async () => {
    const deadlockedPlan: TaskPlan = {
      goal: "Deadlock task",
      subtasks: [
        { id: "task-1", title: "Task 1", capability: "files", dependsOn: ["task-2"], riskLevel: "low", successCriteria: "done", state: "pending" },
        { id: "task-2", title: "Task 2", capability: "files", dependsOn: ["task-1"], riskLevel: "low", successCriteria: "done", state: "pending" },
      ],
    };

    await expect(outerLoop.run("task-deadlock", deadlockedPlan)).rejects.toThrow(
      "Deadlock detected in subtask execution dependency graph.",
    );
  });

  it("should handle subtask failures and throw error eventually on blocked state", async () => {
    const failingPlan: TaskPlan = {
      goal: "Failing task",
      subtasks: [
        { id: "task-1", title: "Failing subtask", capability: "files", dependsOn: [], riskLevel: "low", successCriteria: "done", state: "pending" },
        { id: "task-2", title: "Dependent pending subtask", capability: "files", dependsOn: ["task-1"], riskLevel: "low", successCriteria: "done", state: "pending" },
      ],
    };

    responder = async () => {
      throw new Error("LLM failure");
    };

    await expect(outerLoop.run("task-failing", failingPlan)).rejects.toThrow(
      "Task execution failed due to subtask failure.",
    );
  });

  const singleSubtaskPlan = (): TaskPlan => ({
    goal: "Kill switch task",
    subtasks: [
      { id: "task-1", title: "Write the report file", capability: "files", dependsOn: [], riskLevel: "low", successCriteria: "report exists", state: "pending" },
    ],
  });

  it("trips the kill switch after 3 identical errors and retries once with a different approach", async () => {
    responder = async () => {
      throw new Error("segfault in strategy A");
    };

    await expect(outerLoop.run("task-loop", singleSubtaskPlan())).rejects.toThrow(
      "Task execution failed due to subtask failure.",
    );

    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-loop.started",
      expect.objectContaining({ kind: "status", note: expect.stringContaining("Kill switch") }),
    );

    // The replacement agent was explicitly ordered to change approach — the
    // directive is threaded into the instruction the model receives.
    const instructions = captured.map((c) => c.messages.map((m) => String(m.content)).join("\n"));
    expect(instructions.some((text) => text.includes("COMPLETELY DIFFERENT"))).toBe(true);

    // 3 identical failures + 1 different-approach attempt = 4 agents, all failed.
    const savedAgents = (mockStore.saveAgent as any).mock.calls.map((c: any[]) => c[1]);
    const failedAgents = savedAgents.filter((agent: any) => agent.status === "failed");
    expect(failedAgents).toHaveLength(4);
  });

  it("runs independent ready subtasks concurrently", async () => {
    const parallelPlan: TaskPlan = {
      goal: "Parallel task",
      subtasks: [
        { id: "task-a", title: "Independent A", capability: "files", dependsOn: [], riskLevel: "low", successCriteria: "a done", state: "pending" },
        { id: "task-b", title: "Independent B", capability: "files", dependsOn: [], riskLevel: "low", successCriteria: "b done", state: "pending" },
      ],
    };

    // Each agent's first model turn parks on a deferred promise so neither
    // subtask can finish until we release it — proving genuine concurrency.
    const resolvers: Array<() => void> = [];
    responder = () =>
      new Promise<AIMessage>((resolve) => resolvers.push(() => resolve(finalMessage("done"))));

    const runPromise = outerLoop.run("task-parallel", parallelPlan);

    await vi.waitFor(() => {
      expect(captured.length).toBe(2);
    });
    expect(resolvers).toHaveLength(2);

    resolvers.forEach((release) => release());
    await expect(runPromise).resolves.not.toThrow();

    const savedAgents = (mockStore.saveAgent as any).mock.calls.map((c: any[]) => c[1]);
    const completedSubtaskIds = savedAgents
      .filter((agent: any) => agent.status === "completed")
      .map((agent: any) => agent.subtaskId);
    expect(completedSubtaskIds).toContain("task-a");
    expect(completedSubtaskIds).toContain("task-b");
  });

  it("recovers when a retry succeeds before the kill switch trips", async () => {
    let attempt = 0;
    responder = async () => {
      attempt++;
      if (attempt === 1) throw new Error("transient timeout");
      return finalMessage("Recovered on retry.");
    };

    await expect(outerLoop.run("task-retry", singleSubtaskPlan())).resolves.not.toThrow();

    const savedAgents = (mockStore.saveAgent as any).mock.calls.map((c: any[]) => c[1]);
    expect(savedAgents.some((agent: any) => agent.status === "completed")).toBe(true);
    const killSwitchNotes = (mockBus.publish as any).mock.calls.filter(
      (call: any[]) => typeof call[1]?.note === "string" && call[1].note.includes("Kill switch"),
    );
    expect(killSwitchNotes).toHaveLength(0);
  });
});
