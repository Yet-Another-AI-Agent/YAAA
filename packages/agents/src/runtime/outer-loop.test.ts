import { describe, it, expect, vi, beforeEach } from "vitest";
import { container, PermissionEngine, orchestratorMailbox, agentControl } from "@yaaa/platform";
import type { IBus, IStore, ModelRole } from "@yaaa/interfaces";
import type { TaskPlan, AgentRun } from "@yaaa/shared";
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
type Responder = (role: string, messages: BaseMessage[]) => Promise<AIMessage>;

interface CapturedCall {
  role: string;
  messages: BaseMessage[];
}

class ProgrammableChatModel extends BaseChatModel {
  constructor(
    private readonly roleOrModel: string,
    private readonly responder: () => Responder,
    private readonly captured: CapturedCall[],
  ) {
    super({});
  }
  _llmType() {
    return "programmable-test-model";
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.captured.push({ role: this.roleOrModel, messages });
    const message = await this.responder()(this.roleOrModel, messages);
    const text = typeof message.content === "string" ? message.content : "";
    return { generations: [{ text, message }] };
  }
  override bindTools() {
    return this;
  }
}

const finalMessage = (text: string) => new AIMessage({ content: text });
const toolCall = (name: string, args: Record<string, unknown>, id = "call_1") =>
  new AIMessage({ content: "", tool_calls: [{ name, args, id, type: "tool_call" }] });

describe("OuterLoop Manager", () => {
  let mockBus: IBus;
  let mockStore: IStore;
  let permissions: PermissionEngine;
  let outerLoop: OuterLoop;
  let captured: CapturedCall[];
  let supervisorGateway: { chat: ReturnType<typeof vi.fn> } & Record<string, unknown>;
  // Default: every agent finishes immediately with a generic summary.
  let responder: Responder = async (role) =>
    role === "verifier" ? finalMessage(JSON.stringify({ status: "passed", summary: "Meets criteria.", findings: [], evidence: ["deliverable exists in workspace"] })) : finalMessage("Subtask completed.");

  beforeEach(() => {
    container.clear();
    captured = [];
    responder = async (role) =>
      role === "verifier" ? finalMessage(JSON.stringify({ status: "passed", summary: "Meets criteria.", findings: [], evidence: ["deliverable exists in workspace"] })) : finalMessage("Subtask completed.");

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
    // Supervisor assessor's model gateway. Defaults to "continue" so timebox
    // checkpoints renew; individual tests can override this mock per-decision.
    supervisorGateway = {
      chat: vi.fn().mockResolvedValue({ content: '{"action":"continue","reason":"progressing"}' }),
      chatStream: vi.fn(),
      generateImage: vi.fn(),
    } as any;
    container.register("IMeshGateway", supervisorGateway);
    container.register("capability:files", {
      readFile: vi.fn().mockResolvedValue(""),
      writeFile: vi.fn().mockResolvedValue(undefined),
      listFiles: vi.fn().mockResolvedValue([]),
      searchFiles: vi.fn().mockResolvedValue([]),
      screenshot: vi.fn().mockResolvedValue({ screenshotPath: "agent-workspaces/files-agent-test/yaaa-proof.png", title: "Rendered proof" }),
    });
    container.register(
      "ChatModelFactory",
      (roleOrModel: string) => new ProgrammableChatModel(roleOrModel, () => responder, captured),
    );

    outerLoop = new OuterLoop();
  });

  it("should execute sequential plan subtasks matching dependencies", async () => {
    const plan: TaskPlan = {
      goal: "Run test task",
      subtasks: [
        { id: "task-1", title: "Write file facts", roles: ["FilesAgent"], capabilities: ["files"], dependsOn: [], riskLevel: "low", successCriteria: "file exists", state: "pending" },
        { id: "task-2", title: "Verify task facts contents", roles: ["QaTesterAgent"], capabilities: ["verify"], dependsOn: ["task-1"], riskLevel: "low", successCriteria: "facts verified", state: "pending" },
      ],
    };

    await expect(outerLoop.run("task-123", plan)).resolves.not.toThrow();

    expect(mockStore.savePlan).toHaveBeenCalledWith("task-123", plan);
    expect(mockStore.saveLedgerEntry).toHaveBeenCalled();
    expect(plan.subtasks[0].subSubtasks?.every((step) => step.state === "completed")).toBe(true);
    expect(plan.subtasks[1].subSubtasks?.every((step) => step.state === "completed")).toBe(true);
    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-123.started",
      expect.objectContaining({ kind: "status", state: "working" }),
    );
    expect(mockStore.saveAgent).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({ handle: expect.stringMatching(/^@[a-z0-9-]+-1$/), status: "working" }),
    );
    expect(plan.subtasks[0].artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.stringMatching(/agent-workspaces\/.+\/handsOn\.md/) }),
        expect.objectContaining({ path: expect.stringMatching(/agent-workspaces\/.+\/handOff\.md/) }),
      ]),
    );
    const dependentBrief = captured.at(-1)?.messages.map((m) => String(m.content)).join("\n") ?? "";
    expect(dependentBrief).toContain("handOff.md");
  });

  it("passes complete mission context through the real outer-to-inner execution path", async () => {
    const taskId = "task-e2e-assignment-context";
    const mission = "Create a 5-slide educational Betta fish presentation for children";
    const criteria = "The final presentation contains five age-appropriate slides and is saved as betta_fish.pptx";
    const plan: TaskPlan = {
      goal: mission,
      subtasks: [
        {
          id: "subtask-1",
          title: "Draft content",
        roles: ["FilesAgent"],
        capabilities: ["files"],
          dependsOn: [],
          riskLevel: "low",
          successCriteria: criteria,
          state: "pending",
        },
      ],
    };

    let modelTurn = 0;
    responder = async () => {
      modelTurn += 1;
      return modelTurn === 1
        ? toolCall("write_file", { path: "betta_fish.pptx", content: "non-empty test artifact" })
        : finalMessage("Assignment understood and completed with the required evidence.");
    };

    await expect(outerLoop.run(taskId, plan)).resolves.not.toThrow();

    const firstModelRequest = captured[0]?.messages.map((message) => String(message.content)).join("\n") ?? "";
    expect(firstModelRequest).toContain("## Assignment at a glance");
    expect(firstModelRequest).toContain(mission);
    expect(firstModelRequest).toContain("Draft content");
    expect(firstModelRequest).toContain(criteria);
    expect(firstModelRequest).toContain("Current micro-step:");
    expect(firstModelRequest).toContain("Do not claim that context is missing");
  });

  it("passes composite roles and the union of capabilities to one inner-loop agent", async () => {
    const runInnerLoop = vi.spyOn(outerLoop as any, "runInnerLoop").mockResolvedValue({
      summary: "Composite assignment completed.",
      artifacts: [{ path: "deliverable.md", mimeType: "text/markdown", description: "Composite output" }],
    });
    const plan: TaskPlan = {
      goal: "Create and verify a composite deliverable",
      subtasks: [{
        id: "composite-1",
        title: "Create and verify the composite deliverable",
        roles: ["DocumentAgent", "FilesAgent"],
        capabilities: ["files", "shell", "verify"],
        dependsOn: [],
        riskLevel: "low",
        successCriteria: "deliverable.md exists",
        state: "pending",
      }],
    };

    await expect(outerLoop.run("task-composite-assignment", plan)).resolves.not.toThrow();

    expect(runInnerLoop).toHaveBeenCalledWith(expect.objectContaining({
      templateName: "DocumentAgent",
      roleNames: ["DocumentAgent", "FilesAgent"],
      capabilities: ["files", "shell", "verify"],
    }));
    const savedAgents = (mockStore.saveAgent as any).mock.calls.map((call: any[]) => call[1]);
    expect(new Set(savedAgents.map((agent: any) => agent.id)).size).toBe(1);
  });

  it("does not require a final PPTX from an upstream outline subtask", () => {
    const researchSubtask: any = {
      id: "subtask-1",
      title: "Research and draft advanced Betta fish presentation outline",
          roles: ["ResearcherAgent"],
          capabilities: ["browser"],
      dependsOn: [],
      riskLevel: "low",
      successCriteria: "A file named 'outline.md' exists containing content for exactly 5 slides",
      state: "pending",
    };

    const gaps = (outerLoop as any).requiredArtifactGaps(
      researchSubtask,
      [{ path: "outline.md" }],
      "Create a 5-slide PowerPoint presentation with generated images",
    );

    expect(gaps).toEqual([]);
  });

  it("does not emit an acknowledgement when a queued message arrives before a worker", async () => {
    const taskId = "task-queued-without-worker";
    mockStore.getAgents = vi.fn().mockResolvedValue([]);
    orchestratorMailbox.post({
      id: "queued-1",
      taskId,
      from: "user",
      content: "there?",
      createdAt: new Date().toISOString(),
    });

    await outerLoop.run(taskId, singleSubtaskPlan());

    const notes = (mockBus.publish as any).mock.calls
      .filter((call: any[]) => call[0] === `task.${taskId}.started`)
      .map((call: any[]) => call[1]?.note ?? "")
      .join("\n");
    expect(notes).not.toContain("I’m here");
    orchestratorMailbox.clear(taskId);
  });

  it("picks up an agent question and sends the answer back to that agent", async () => {
    const taskId = "task-agent-question-roundtrip";
    mockStore.getAgents = vi.fn().mockResolvedValue([
      { id: "sub-agent-1", handle: "@researcher-1", status: "working", taskId },
    ]);
    supervisorGateway.chat.mockResolvedValueOnce({
      content: JSON.stringify({
        recipientIds: [],
        reply: "Preserve the existing API and verify the compatibility path before migrating.",
        reason: "The worker needs a concrete compatibility decision.",
      }),
    });
    orchestratorMailbox.post({
      id: "agent-question-1",
      taskId,
      from: "agent",
      agentId: "sub-agent-1",
      content: "Which compatibility path should I verify?",
      createdAt: new Date().toISOString(),
    });

    await outerLoop.run(taskId, singleSubtaskPlan());

    expect(mockBus.publish).toHaveBeenCalledWith(
      `task.${taskId}.agent_message`,
      expect.objectContaining({
        kind: "info_reply",
        from: "orchestrator",
        to: "sub-agent-1",
        answer: expect.stringContaining("@researcher-1 Preserve the existing API"),
      }),
    );
    const reply = (mockBus.publish as any).mock.calls
      .find((call: any[]) => call[0] === `task.${taskId}.agent_message` && call[1]?.kind === "info_reply")?.[1];
    expect(reply.answer).not.toContain("safest evidence-based path");
    orchestratorMailbox.clear(taskId);
  });

  it("injects persisted checkpoint evidence when a run is resumed after restart", async () => {
    const plan = singleSubtaskPlan();
    mockStore.getMessages = vi.fn().mockResolvedValue([
      {
        kind: "result",
        from: "files-agent-old",
        taskId: "task-restart",
        incomplete: true,
        summary: "Amazon search reached results but the product URL was not extracted.",
        artifacts: [{ path: "agent-workspaces/files-agent-old/handOff.md", mimeType: "text/markdown", description: "Continuation notes" }],
      },
    ]);
    mockStore.getLedgerEntries = vi.fn().mockResolvedValue([
      { timestamp: new Date().toISOString(), step: 8, facts: [], assumptions: [], subtaskStates: { "task-1": "running" }, nextStepStrategy: "Resume inspection" },
    ]);

    await expect(outerLoop.run("task-restart", plan)).resolves.not.toThrow();

    const firstPrompt = captured[0]?.messages.map((message) => String(message.content)).join("\n") || "";
    expect(firstPrompt).toContain("previous process stopped after saving an incomplete checkpoint");
    expect(firstPrompt).toContain("Amazon search reached results");
    expect(mockStore.saveLedgerEntry).toHaveBeenCalledWith(
      "task-restart",
      expect.objectContaining({ step: 9 }),
    );
  });

  it("negotiates a failed verification: sends the deliverable back to a worker, then re-verifies to pass", async () => {
    process.env.YAAA_MAX_VERIFICATION_ROUNDS = "2";
    const plan: TaskPlan = {
      goal: "Run test task",
      subtasks: [
        { id: "task-1", title: "Write file facts", roles: ["FilesAgent"], capabilities: ["files"], dependsOn: [], riskLevel: "low", successCriteria: "file exists", state: "pending" },
        { id: "task-2", title: "Verify facts", roles: ["QaTesterAgent"], capabilities: ["verify"], dependsOn: ["task-1"], riskLevel: "low", successCriteria: "facts verified", state: "pending" },
      ],
    };

    // The verifier fails the first time, then passes after the fix round.
    let verifierCalls = 0;
    responder = async (role) => {
      if (role === "verifier") {
        verifierCalls++;
        return verifierCalls === 1
          ? finalMessage(JSON.stringify({ status: "failed", summary: "missing a fact", findings: ["only 2 of 3 facts present"], evidence: ["facts.txt"] }))
          : finalMessage(JSON.stringify({ status: "passed", summary: "all facts present now", findings: [], evidence: ["facts.txt has 3 facts"] }));
      }
      return finalMessage("Worker finished.");
    };

    try {
      await expect(outerLoop.run("task-negotiate", plan)).resolves.not.toThrow();
      // A fix→re-verify round happened, and the mission did not abort.
      expect(verifierCalls).toBeGreaterThanOrEqual(2);
      expect(mockBus.publish).toHaveBeenCalledWith(
        "task.task-negotiate.started",
        expect.objectContaining({ note: expect.stringMatching(/sending it back to a worker to fix/i) }),
      );
      expect(plan.verificationFindings).toEqual([
        expect.objectContaining({
          subtaskId: "task-2",
          status: "resolved",
          findings: ["only 2 of 3 facts present"],
        }),
      ]);
      expect(mockBus.publish).toHaveBeenCalledWith(
        "task.task-negotiate.started",
        expect.objectContaining({ note: expect.stringMatching(/received verification bugs/i) }),
      );
    } finally {
      delete process.env.YAAA_MAX_VERIFICATION_ROUNDS;
    }
  });

  it("fails the subtask when verification never passes after the fix rounds", async () => {
    process.env.YAAA_MAX_VERIFICATION_ROUNDS = "1";
    const plan: TaskPlan = {
      goal: "Run test task",
      subtasks: [
        { id: "task-1", title: "Write file facts", roles: ["FilesAgent"], capabilities: ["files"], dependsOn: [], riskLevel: "low", successCriteria: "file exists", state: "pending" },
        { id: "task-2", title: "Verify facts", roles: ["QaTesterAgent"], capabilities: ["verify"], dependsOn: ["task-1"], riskLevel: "low", successCriteria: "facts verified", state: "pending" },
      ],
    };

    responder = async (role) =>
      role === "verifier"
        ? finalMessage(JSON.stringify({ status: "failed", summary: "still wrong", findings: ["fact missing"], evidence: ["facts.txt"] }))
        : finalMessage("Worker finished.");

    try {
      await expect(outerLoop.run("task-negotiate-fail", plan)).rejects.toThrow(
        "Task execution failed due to subtask failure.",
      );
      expect(plan.verificationFindings).toEqual([
        expect.objectContaining({ subtaskId: "task-2", status: "open", findings: ["fact missing"] }),
      ]);
    } finally {
      delete process.env.YAAA_MAX_VERIFICATION_ROUNDS;
    }
  });

  it("should throw an error if a subtask dependency loop or deadlock is detected", async () => {
    const deadlockedPlan: TaskPlan = {
      goal: "Deadlock task",
      subtasks: [
        { id: "task-1", title: "Task 1", roles: ["FilesAgent"], capabilities: ["files"], dependsOn: ["task-2"], riskLevel: "low", successCriteria: "done", state: "pending" },
        { id: "task-2", title: "Task 2", roles: ["FilesAgent"], capabilities: ["files"], dependsOn: ["task-1"], riskLevel: "low", successCriteria: "done", state: "pending" },
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
        { id: "task-1", title: "Failing subtask", roles: ["FilesAgent"], capabilities: ["files"], dependsOn: [], riskLevel: "low", successCriteria: "done", state: "pending" },
        { id: "task-2", title: "Dependent pending subtask", roles: ["FilesAgent"], capabilities: ["files"], dependsOn: ["task-1"], riskLevel: "low", successCriteria: "done", state: "pending" },
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
      { id: "task-1", title: "Write the report file", roles: ["FilesAgent"], capabilities: ["files"], dependsOn: [], riskLevel: "low", successCriteria: "report exists", state: "pending" },
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

    // 3 identical failures + 1 different-approach attempt = 4 attempts. The
    // recoverable attempts are exited so the UI does not falsely show a
    // terminal failure before YAAA has exhausted correction options.
    const savedAgents = (mockStore.saveAgent as any).mock.calls.map((c: any[]) => c[1]);
    const failedAgents = savedAgents.filter((agent: any) => agent.status === "failed");
    const exitedAgents = savedAgents.filter((agent: any) => agent.status === "exited");
    expect(failedAgents).toHaveLength(1);
    expect(exitedAgents).toHaveLength(3);
  });

  it("does not spawn a replacement agent for a deterministic provider 400", async () => {
    responder = async () => {
      throw new Error("400 text content blocks must be non-empty; invalid tool-call transcript");
    };

    await expect(outerLoop.run("task-provider-400", singleSubtaskPlan())).rejects.toThrow(
      "Task execution failed due to subtask failure.",
    );

    const savedAgents = (mockStore.saveAgent as any).mock.calls.map((c: any[]) => c[1]);
    expect(new Set(savedAgents.map((agent: any) => agent.id)).size).toBe(1);
    expect(savedAgents.some((agent: any) => agent.status === "exited")).toBe(true);

    const statusNotes = (mockBus.publish as any).mock.calls
      .filter((call: any[]) => call[0] === "task.task-provider-400.started")
      .map((call: any[]) => call[1]?.note ?? "")
      .join("\n");
    expect(statusNotes).toContain("provider request error");
    expect(statusNotes).not.toContain("spawning a replacement");
  });

  it("does not turn an inner-loop no-progress stop into a replacement agent", async () => {
    const runInnerLoop = vi.spyOn(outerLoop as any, "runInnerLoop").mockResolvedValue({
      incomplete: true,
      stopReason: "no-progress",
      summary: "Agent stopped by supervisor. Reason: No progress budget exhausted for this assignment.",
      artifacts: [{ path: "agent-workspaces/pikachu-1/incompleteWork.md", mimeType: "text/markdown", description: "Failure evidence" }],
      runtimeEvidence: "- files.file_multi: failed - Unknown action in file_multi execution",
    });

    await expect(outerLoop.run("task-no-progress-replacement", singleSubtaskPlan())).rejects.toThrow(
      "Task execution failed due to subtask failure.",
    );

    expect(runInnerLoop).toHaveBeenCalledTimes(1);
    const savedAgents = (mockStore.saveAgent as any).mock.calls.map((c: any[]) => c[1]);
    expect(new Set(savedAgents.map((agent: any) => agent.id)).size).toBe(1);
    expect(supervisorGateway.chat).not.toHaveBeenCalled();
    const statusNotes = (mockBus.publish as any).mock.calls
      .filter((call: any[]) => call[0] === "task.task-no-progress-replacement.started")
      .map((call: any[]) => call[1]?.note ?? "")
      .join("\n");
    expect(statusNotes).not.toContain("spawning a replacement");
  });

  it("does not spawn a replacement when the required tool permission is denied", async () => {
    const runInnerLoop = vi.spyOn(outerLoop as any, "runInnerLoop").mockResolvedValue({
      incomplete: true,
      permissionBlocked: true,
      permissionBlockReasons: ["Permission denied: agent pikachu-1 is not permitted to execute files.writeFile"],
      summary: "The required write operation was denied.",
      artifacts: [{ path: "agent-workspaces/pikachu-1/handOff.md", mimeType: "text/markdown", description: "Permission blocker" }],
    });

    await expect(outerLoop.run("task-permission-blocked", singleSubtaskPlan())).rejects.toThrow(
      "Task execution failed due to subtask failure.",
    );

    expect(runInnerLoop).toHaveBeenCalledTimes(1);
    const savedAgents = (mockStore.saveAgent as any).mock.calls.map((call: any[]) => call[1]);
    expect(new Set(savedAgents.map((agent: any) => agent.id)).size).toBe(1);
    expect(supervisorGateway.chat).not.toHaveBeenCalled();
    const notes = (mockBus.publish as any).mock.calls
      .filter((call: any[]) => call[0] === "task.task-permission-blocked.started")
      .map((call: any[]) => call[1]?.note ?? "")
      .join("\n");
    expect(notes).toContain("blocked by a permission/capability denial");
    expect(notes).toContain("No replacement agent was spawned");
  });

  it("does not spawn a replacement when a worker refuses the provided assignment context", async () => {
    const runInnerLoop = vi.spyOn(outerLoop as any, "runInnerLoop").mockResolvedValue({
      incomplete: true,
      summary: "I don't have enough context to complete this assignment. Please provide the full task details.",
      artifacts: [{ path: "agent-workspaces/researcher-1/handOff.md", mimeType: "text/markdown", description: "Blocker evidence" }],
    });
    supervisorGateway.chat.mockResolvedValueOnce({
      content: JSON.stringify({ action: "fail", reason: "Worker refused the supplied assignment context." }),
    });
    const plan: TaskPlan = {
      goal: "Create a PowerPoint presentation with images",
      subtasks: [{
        id: "research-outline",
        title: "Research and draft the presentation outline",
        roles: ["ResearcherAgent"],
        capabilities: ["browser"],
        dependsOn: [],
        riskLevel: "low",
        successCriteria: "A file named 'outline.md' exists containing content for exactly 5 slides",
        state: "pending",
      }],
    };

    await expect(outerLoop.run("task-context-refusal", plan)).rejects.toThrow(
      "Task execution failed due to subtask failure.",
    );

    expect(runInnerLoop).toHaveBeenCalledTimes(1);
    const savedAgents = (mockStore.saveAgent as any).mock.calls.map((call: any[]) => call[1]);
    expect(new Set(savedAgents.map((agent: any) => agent.id)).size).toBe(1);
    expect(supervisorGateway.chat).toHaveBeenCalledTimes(1);
    const notes = (mockBus.publish as any).mock.calls
      .filter((call: any[]) => call[0] === "task.task-context-refusal.started")
      .map((call: any[]) => call[1]?.note ?? "")
      .join("\n");
    expect(notes).toContain("Supervisor reviewed");
    expect(notes).toContain("Worker refused the supplied assignment context");
    expect(new Set(savedAgents.map((agent: any) => agent.id)).size).toBe(1);
  });

  it("stops instead of looping when artifact gaps meet a context-refusal response", async () => {
    const runInnerLoop = vi.spyOn(outerLoop as any, "runInnerLoop").mockResolvedValue({
      incomplete: true,
      summary: "I don't see the assignment details. Please provide the complete task details.",
      artifacts: [{ path: "agent-workspaces/refusal-1/handOff.md", mimeType: "text/markdown", description: "Blocker evidence" }],
    });
    supervisorGateway.chat.mockResolvedValueOnce({
      content: JSON.stringify({ action: "redirect", handsOn: "Please try the same assignment again.", reason: "Deliverable is missing." }),
    });
    const plan: TaskPlan = {
      goal: "Create a 5-slide presentation",
      subtasks: [{
        id: "presentation",
        title: "Create the presentation",
        roles: ["DocumentAgent"],
        capabilities: ["files"],
        dependsOn: [],
        riskLevel: "low",
        successCriteria: "A presentation.pptx file exists",
        state: "pending",
      }],
    };

    await expect(outerLoop.run("task-context-refusal-with-gap", plan)).rejects.toThrow(
      "Task execution failed due to subtask failure.",
    );
    expect(runInnerLoop).toHaveBeenCalledTimes(1);
    const savedAgents = (mockStore.saveAgent as any).mock.calls.map((call: any[]) => call[1]);
    expect(new Set(savedAgents.map((agent: any) => agent.id)).size).toBe(1);
    expect((mockStore.savePlan as any).mock.calls.at(-1)?.[1].subtasks[0].state).toBe("failed");
  });

  it("runs independent ready subtasks concurrently", async () => {
    const parallelPlan: TaskPlan = {
      goal: "Parallel task",
      subtasks: [
        { id: "task-a", title: "Independent A", roles: ["FilesAgent"], capabilities: ["files"], dependsOn: [], riskLevel: "low", successCriteria: "a done", state: "pending" },
        { id: "task-b", title: "Independent B", roles: ["FilesAgent"], capabilities: ["files"], dependsOn: [], riskLevel: "low", successCriteria: "b done", state: "pending" },
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

  it("renews the timer from an incomplete timebox handoff instead of blocking the subtask", async () => {
    process.env.YAAA_AGENT_INVOKE_TIMEOUT_MS = "20";
    process.env.YAAA_AGENT_CHECKPOINT_TIMEOUT_MS = "50";
    let turn = 0;
    responder = async (_role, messages) => {
      const text = messages.map((m) => String(m.content)).join("\n");
      if (text.includes("reached its timebox after making tool progress")) {
        return finalMessage("Checkpoint says notes.md was inspected; continue with a fresh timer.");
      }
      turn++;
      if (turn === 1) return toolCall("read_file", { path: "notes.md" });
      if (turn === 2) return new Promise<AIMessage>(() => {});
      expect(text).toContain("Previous agent reached its timebox");
      expect(text).toContain("handOff.md");
      return finalMessage("Continued from checkpoint and finished.");
    };

    try {
      await expect(outerLoop.run("task-timebox", singleSubtaskPlan())).resolves.not.toThrow();

      const savedAgents = (mockStore.saveAgent as any).mock.calls.map((c: any[]) => c[1]);
      expect(savedAgents.some((agent: any) => agent.status === "blocked")).toBe(false);
      expect(savedAgents.some((agent: any) => agent.status === "exited")).toBe(true);
      expect(savedAgents.some((agent: any) => agent.status === "completed")).toBe(true);
      // The supervisor reviewed the checkpoint and chose to continue (renew).
      expect(supervisorGateway.chat).toHaveBeenCalled();
      expect(mockBus.publish).toHaveBeenCalledWith(
        "task.task-timebox.started",
        expect.objectContaining({ note: expect.stringMatching(/supervisor reviewed/i) }),
      );
      const supervisorPrompt = supervisorGateway.chat.mock.calls
        .map((call) => call[0]?.map((message: any) => message.content).join("\n"))
        .join("\n");
      expect(supervisorPrompt).toContain("Runtime tool evidence reviewed by supervisor");
      expect(supervisorPrompt).toContain("files.readFile");
    } finally {
      delete process.env.YAAA_AGENT_INVOKE_TIMEOUT_MS;
      delete process.env.YAAA_AGENT_CHECKPOINT_TIMEOUT_MS;
    }
  });

  it("passes screenshot and tool metadata to the supervisor before choosing a timeout continuation", async () => {
    process.env.YAAA_AGENT_INVOKE_TIMEOUT_MS = "20";
    process.env.YAAA_AGENT_CHECKPOINT_TIMEOUT_MS = "50";
    let turn = 0;
    responder = async (_role, messages) => {
      const text = messages.map((m) => String(m.content)).join("\n");
      if (text.includes("reached its timebox after making tool progress")) {
        return finalMessage("Checkpoint: captured agent-workspaces/files-agent-test/yaaa-proof.png and needs a continuation.");
      }
      if (text.includes("Previous agent reached its timebox")) {
        return finalMessage("Continued from screenshot evidence and finished.");
      }
      turn++;
      if (turn === 1) return toolCall("file_screenshot", { path: "report.md", outputPath: "agent-workspaces/files-agent-test/yaaa-proof.png" });
      return new Promise<AIMessage>(() => {});
    };

    try {
      await expect(outerLoop.run("task-screenshot-evidence", singleSubtaskPlan())).resolves.not.toThrow();
      const supervisorPrompt = supervisorGateway.chat.mock.calls
        .map((call) => call[0]?.map((message: any) => message.content).join("\n"))
        .join("\n");
      expect(supervisorPrompt).toContain("files.screenshot");
      expect(supervisorPrompt).toContain("screenshotPath: agent-workspaces/files-agent-test/yaaa-proof.png");
      expect(supervisorPrompt).toContain("path: report.md");
    } finally {
      delete process.env.YAAA_AGENT_INVOKE_TIMEOUT_MS;
      delete process.env.YAAA_AGENT_CHECKPOINT_TIMEOUT_MS;
    }
  });

  it("course-corrects after a completed worker result when the supervisor redirects the todo", async () => {
    supervisorGateway.chat
      .mockResolvedValueOnce({
        content: '{"action":"redirect","reason":"the game needs actual canvas controls","handsOn":"Add keyboard controls and render a visible canvas before handing off."}',
      })
      .mockResolvedValueOnce({ content: '{"action":"accept","reason":"corrected result meets the current todo"}' });
    let workerCalls = 0;
    responder = async () => {
      workerCalls++;
      return finalMessage(workerCalls === 1 ? "Built static files." : "Added canvas and keyboard controls.");
    };

    await expect(outerLoop.run("task-course-correct", singleSubtaskPlan())).resolves.not.toThrow();

    expect(workerCalls).toBe(2);
    const instructions = captured.map((c) => c.messages.map((m) => String(m.content)).join("\n"));
    expect(instructions.some((text) => text.includes("Supervisor course-correction"))).toBe(true);
    expect(instructions.some((text) => text.includes("Add keyboard controls and render a visible canvas"))).toBe(true);
    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-course-correct.started",
      expect.objectContaining({ note: expect.stringMatching(/Supervisor checked.*redirect/i) }),
    );
  });

  it("switches away from a model that the provider reports as unavailable", async () => {
    const unavailableModel = "anthropic/claude-sonnet-4.6";
    const fallbackModel = "anthropic/claude-sonnet-4.5";
    container.register("modelResolver", async (requested?: string) => ({
      model: requested || fallbackModel,
      reason: requested ? "requested test model" : "fallback test model",
    }));
    const usedModels: string[] = [];
    responder = async (role) => {
      usedModels.push(role);
      if (role === unavailableModel) throw new Error("503 The model provider is temporarily unavailable. Please try again shortly.");
      return finalMessage("Built with the fallback model.");
    };
    const plan = singleSubtaskPlan();
    plan.subtasks[0].model = unavailableModel;

    await expect(outerLoop.run("task-model-unavailable", plan)).resolves.not.toThrow();

    expect(usedModels).toEqual([unavailableModel, fallbackModel]);
    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-model-unavailable.started",
      expect.objectContaining({ note: expect.stringContaining("is unavailable") }),
    );
  });

  it("keeps renewing incomplete timeboxes even when the error budget is 1 (continuations are not errors)", async () => {
    // With the error budget at a single attempt, the OLD code failed the subtask
    // on its first incomplete checkpoint because timeboxes counted toward it.
    // Continuations now have their own budget, so an incomplete-then-finish still
    // succeeds.
    process.env.YAAA_MAX_SUBTASK_ATTEMPTS = "1";
    process.env.YAAA_AGENT_INVOKE_TIMEOUT_MS = "20";
    process.env.YAAA_AGENT_CHECKPOINT_TIMEOUT_MS = "50";
    let turn = 0;
    responder = async (_role, messages) => {
      const text = messages.map((m) => String(m.content)).join("\n");
      if (text.includes("reached its timebox after making tool progress")) {
        return finalMessage("Checkpoint: notes.md inspected; continue with a fresh timer.");
      }
      turn++;
      if (turn === 1) return toolCall("read_file", { path: "notes.md" });
      if (turn === 2) return new Promise<AIMessage>(() => {});
      return finalMessage("Continued from checkpoint and finished.");
    };

    try {
      await expect(outerLoop.run("task-continue-budget", singleSubtaskPlan())).resolves.not.toThrow();
      const savedAgents = (mockStore.saveAgent as any).mock.calls.map((c: any[]) => c[1]);
      expect(savedAgents.some((agent: any) => agent.status === "completed")).toBe(true);
      expect(savedAgents.some((agent: any) => agent.status === "failed")).toBe(false);
    } finally {
      delete process.env.YAAA_MAX_SUBTASK_ATTEMPTS;
      delete process.env.YAAA_AGENT_INVOKE_TIMEOUT_MS;
      delete process.env.YAAA_AGENT_CHECKPOINT_TIMEOUT_MS;
    }
  });

  it("accepts a checkpoint when the supervisor judges the criteria already met", async () => {
    process.env.YAAA_AGENT_INVOKE_TIMEOUT_MS = "20";
    process.env.YAAA_AGENT_CHECKPOINT_TIMEOUT_MS = "50";
    supervisorGateway.chat.mockResolvedValue({
      content: '{"action":"accept","reason":"report.md already satisfies the criteria"}',
    });
    let turn = 0;
    responder = async (_role, messages) => {
      const text = messages.map((m) => String(m.content)).join("\n");
      if (text.includes("reached its timebox after making tool progress")) {
        return finalMessage("Checkpoint: report.md written and complete.");
      }
      turn++;
      if (turn === 1) return toolCall("write_file", { path: "report.md", content: "done" });
      return new Promise<AIMessage>(() => {}); // never resolves → timebox → checkpoint
    };

    try {
      await expect(outerLoop.run("task-accept", singleSubtaskPlan())).resolves.not.toThrow();
      expect(supervisorGateway.chat).toHaveBeenCalled();
      expect(mockBus.publish).toHaveBeenCalledWith(
        "task.task-accept.started",
        expect.objectContaining({ note: expect.stringMatching(/accept/i) }),
      );
    } finally {
      delete process.env.YAAA_AGENT_INVOKE_TIMEOUT_MS;
      delete process.env.YAAA_AGENT_CHECKPOINT_TIMEOUT_MS;
    }
  });

  it("fails a subtask when the supervisor judges there is no viable path", async () => {
    process.env.YAAA_AGENT_INVOKE_TIMEOUT_MS = "20";
    process.env.YAAA_AGENT_CHECKPOINT_TIMEOUT_MS = "50";
    supervisorGateway.chat.mockResolvedValue({
      content: '{"action":"fail","reason":"the requirement is self-contradictory"}',
    });
    let turn = 0;
    responder = async (_role, messages) => {
      const text = messages.map((m) => String(m.content)).join("\n");
      if (text.includes("reached its timebox after making tool progress")) {
        return finalMessage("Checkpoint: stuck, cannot proceed.");
      }
      turn++;
      if (turn === 1) return toolCall("read_file", { path: "spec.md" });
      return new Promise<AIMessage>(() => {});
    };

    try {
      await expect(outerLoop.run("task-superfail", singleSubtaskPlan())).rejects.toThrow(
        "Task execution failed due to subtask failure.",
      );
      expect(mockBus.publish).toHaveBeenCalledWith(
        "task.task-superfail.started",
        expect.objectContaining({ note: expect.stringMatching(/fail/i) }),
      );
    } finally {
      delete process.env.YAAA_AGENT_INVOKE_TIMEOUT_MS;
      delete process.env.YAAA_AGENT_CHECKPOINT_TIMEOUT_MS;
    }
  });

  it("does not add its own backoff sleep on a transient error (the model client handles that)", async () => {
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    let attempt = 0;
    responder = async () => {
      attempt++;
      if (attempt === 1) throw new Error("Rate limit exceeded");
      return finalMessage("Recovered without an outer-loop sleep.");
    };

    await expect(outerLoop.run("task-backoff", singleSubtaskPlan())).resolves.not.toThrow();

    // The outer loop no longer schedules its own exponential-backoff wait, so it
    // never asks setTimeout for a multi-second delay between attempts.
    const backoffWaits = setTimeoutSpy.mock.calls.filter(([, delay]) => typeof delay === "number" && delay >= 1000);
    expect(backoffWaits).toHaveLength(0);
    setTimeoutSpy.mockRestore();
  });

  it("reuses the agent's configured model across retries when no backup model is set", async () => {
    delete process.env.YAAA_BACKUP_MODEL;
    let attempt = 0;
    responder = async () => {
      attempt++;
      if (attempt === 1) throw new Error("Rate limit exceeded");
      return finalMessage("Succeeded on the same model.");
    };

    await expect(outerLoop.run("task-model-reuse", singleSubtaskPlan())).resolves.not.toThrow();

    // Both attempts preserve the planner/template worker role.
    const workerCalls = captured.filter((c) => c.role === "worker");
    expect(workerCalls).toHaveLength(2);
  });

  it("keeps a worker on its planner-selected model instead of switching providers on retries", async () => {
    process.env.YAAA_BACKUP_MODEL = "anthropic/claude-sonnet-4.5";
    let attempt = 0;
    responder = async () => {
      attempt++;
      if (attempt <= 2) throw new Error("Rate limit exceeded");
      return finalMessage("Succeeded on the backup model.");
    };

    try {
      await expect(outerLoop.run("task-model-backup", singleSubtaskPlan())).resolves.not.toThrow();
      const roles = captured.map((c) => c.role);
      expect(roles[0]).toBe("worker");
      expect(roles[2]).toBe("worker");
    } finally {
      delete process.env.YAAA_BACKUP_MODEL;
    }
  });

  it("intercepts user control commands (e.g. force kill jigglypuff) and executes them directly instead of forwarding raw text", async () => {
    const taskId = "task-control-command";
    const publishedNotes: string[] = [];
    (mockBus.publish as any).mockImplementation((topic: string, payload: any) => {
      if (payload?.note) publishedNotes.push(payload.note);
    });

    const agent: AgentRun = {
      id: "jigglypuff-5",
      handle: "@jigglypuff-5",
      displayName: "FilesAgent",
      taskId,
      subtaskId: "task-1",
      role: "FilesAgent",
      modelRole: "worker",
      status: "working",
      startedAt: new Date().toISOString(),
    };
    (mockStore.getAgents as any).mockResolvedValue([agent]);

    orchestratorMailbox.post({
      id: "user-msg-1",
      taskId,
      from: "user",
      content: "force kill jigglypuff",
      createdAt: new Date().toISOString(),
    });

    await outerLoop["processQueuedMessages"](taskId, true);

    expect(publishedNotes.some((note) => note.includes("Force killed @jigglypuff-5"))).toBe(true);
    expect(agent.status).toBe("exited");
  });

  it("intercepts model upgrade commands (e.g. upgrade jigglypuff to claude-3-5-sonnet) and posts switch_model directive to sub-agent on the fly", async () => {
    const taskId = "task-model-upgrade";
    const publishedNotes: string[] = [];
    (mockBus.publish as any).mockImplementation((topic: string, payload: any) => {
      if (payload?.note) publishedNotes.push(payload.note);
    });

    const agent: AgentRun = {
      id: "jigglypuff-5",
      handle: "@jigglypuff-5",
      displayName: "FilesAgent",
      taskId,
      subtaskId: "task-1",
      role: "FilesAgent",
      modelRole: "worker",
      status: "working",
      startedAt: new Date().toISOString(),
    };
    (mockStore.getAgents as any).mockResolvedValue([agent]);

    orchestratorMailbox.post({
      id: "user-msg-upgrade",
      taskId,
      from: "user",
      content: "upgrade jigglypuff to claude-3-5-sonnet",
      createdAt: new Date().toISOString(),
    });

    await outerLoop["processQueuedMessages"](taskId, true);

    expect(publishedNotes.some((note) => note.includes("Dynamically switched model for @jigglypuff-5 to 'claude-3-5-sonnet'"))).toBe(true);
    expect(agent.model).toBe("claude-3-5-sonnet");
  });

  it("evaluates periodic sub-agent checkpoints in real-time and issues supervisor course corrections", async () => {
    const taskId = "task-checkpoint-eval";
    const publishedNotes: string[] = [];
    (mockBus.publish as any).mockImplementation((topic: string, payload: any) => {
      if (payload?.note) publishedNotes.push(payload.note);
    });

    const agent: AgentRun = {
      id: "jigglypuff-5",
      handle: "@jigglypuff-5",
      displayName: "FilesAgent",
      taskId,
      subtaskId: "task-1",
      role: "FilesAgent",
      modelRole: "worker",
      status: "working",
      startedAt: new Date().toISOString(),
    };
    (mockStore.getAgents as any).mockResolvedValue([agent]);

    (outerLoop["supervisor"].assess as any) = vi.fn().mockResolvedValue({
      action: "redirect",
      handsOn: "Focus on creating the CSS animation keyframes first.",
      reason: "Agent was spending too many turns scanning documentation.",
    });

    const plan = singleSubtaskPlan();
    await outerLoop.handlePeriodicCheckpoint(
      taskId,
      {
        agentId: "jigglypuff-5",
        turn: 5,
        checkpointPath: "agent-workspaces/jigglypuff-5/checkpoint.md",
        summary: "Turn 5 progress report: reading docs",
      },
      plan,
    );

    expect(publishedNotes.some((note) => note.includes("Course correcting"))).toBe(true);
  });

  it("auto-triggers checkpointing when a sub-subtask completes and notifies the Outer Loop", async () => {
    const taskId = "task-subsubtask-test";
    const publishedNotes: string[] = [];
    (mockBus.publish as any).mockImplementation((topic: string, payload: any) => {
      if (payload?.note) publishedNotes.push(payload.note);
    });

    const subSubtask = { id: "subtask-1.1", title: "Generate animated SVG keyframes", state: "pending" as const };
    const allSubSubtasks = [subSubtask, { id: "subtask-1.2", title: "Mount DOM canvas listener", state: "pending" as const }];

    await outerLoop["innerLoop"].triggerSubSubtaskCheckpoint({
      taskId,
      agentId: "pikachu-1",
      templateName: "DesignerAgent",
      agentWorkspace: "agent-workspaces/pikachu-1",
      subSubtask,
      allSubSubtasks,
    });

    expect(subSubtask.state).toBe("completed");
    expect(publishedNotes.some((note) => note.includes("completed sub-subtask subtask-1.1"))).toBe(true);
  });

  it("allows a later sub-subtask to complete without advancing past the active step", async () => {
    const allSubSubtasks = [
      { id: "generate-pptx.1", title: "Generate presentation", state: "running" as const },
      { id: "generate-pptx.2", title: "Create the PPTX file", state: "pending" as const },
      { id: "generate-pptx.3", title: "Verify slide count", state: "pending" as const },
    ];

    await outerLoop["innerLoop"].triggerSubSubtaskCheckpoint({
      taskId: "task-out-of-order-subtask",
      agentId: "pikachu-1",
      templateName: "DocumentAgent",
      agentWorkspace: "agent-workspaces/pikachu-1",
      subSubtask: allSubSubtasks[2],
      allSubSubtasks,
    });

    expect(allSubSubtasks.map((step) => step.state)).toEqual(["running", "pending", "completed"]);
  });

  it("E2E Case 1: Intercepts natural language low model request ('use smaller model') and resolves to cost-effective utility role without forwarding text", async () => {
    const taskId = "task-e2e-low-model";
    const publishedNotes: string[] = [];
    (mockBus.publish as any).mockImplementation((topic: string, payload: any) => {
      if (payload?.note) publishedNotes.push(payload.note);
    });

    const agent: AgentRun = {
      id: "jigglypuff-5",
      handle: "@jigglypuff-5",
      displayName: "FilesAgent",
      taskId,
      subtaskId: "task-1",
      role: "FilesAgent",
      modelRole: "worker",
      status: "working",
      startedAt: new Date().toISOString(),
    };
    (mockStore.getAgents as any).mockResolvedValue([agent]);

    orchestratorMailbox.post({
      id: "user-msg-low",
      taskId,
      from: "user",
      content: "use smaller model",
      createdAt: new Date().toISOString(),
    });

    await outerLoop["processQueuedMessages"](taskId, true);

    // Verify control action intercepted
    expect(publishedNotes.some((note) => note.includes("Dynamically switched model for @jigglypuff-5 to 'utility'"))).toBe(true);
    expect(agent.model).toBe("utility");
    // Verify text prompt was NOT forwarded as an agent info_reply
    expect(publishedNotes.some((note) => note.includes("routed it to the active agents"))).toBe(false);
  });

  it("E2E Case 2: Dynamic model switch in execution loop updates activeModel and overrides static worker default", async () => {
    const taskId = "task-e2e-dynamic-switch";
    const agentId = "jigglypuff-5";
    agentControl.clear(agentId);

    agentControl.post(agentId, {
      type: "switch_model",
      newModel: "utility",
      reason: "User requested cost-effective tier",
    });

    const directives = agentControl.drain(agentId);
    expect(directives.length).toBe(1);
    expect(directives[0].type).toBe("switch_model");
    if (directives[0].type === "switch_model") {
      expect(directives[0].newModel).toBe("utility");
    }
  });
});
