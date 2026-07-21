import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult, ChatGeneration } from "@langchain/core/outputs";
import { Supervisor } from "@yaaa/orchestrator";
import type { IBus, IStore, IMeshGateway } from "@yaaa/interfaces";
import { DurableEventQueue, MessageBus, PermissionEngine, Container } from "@yaaa/platform";
import { FilesFs } from "@yaaa/providers";
import type { AgentMessage, AgentRun, LedgerEntry, QueueClaim, QueueItem, QueueItemStatus, QueueName, RuntimeEvent, TaskPlan } from "@yaaa/shared";
import type { IQueueStore } from "@yaaa/interfaces";

type Scenario = "happy" | "parallel" | "tool-failure" | "api-failure" | "handover" | "resume" | "resume-recovery";

function memoryStore(): IStore & { events: RuntimeEvent[] } {
  const plans = new Map<string, TaskPlan>();
  const messages = new Map<string, AgentMessage[]>();
  const ledger = new Map<string, LedgerEntry[]>();
  const audits = new Map<string, any[]>();
  const agents = new Map<string, AgentRun[]>();
  const events: RuntimeEvent[] = [];
  return {
    events,
    async initTaskDb() {},
    async saveMessage(taskId, value) { messages.set(taskId, [...(messages.get(taskId) ?? []), value]); },
    async getMessages(taskId) { return messages.get(taskId) ?? []; },
    async savePlan(taskId, value) { plans.set(taskId, value); },
    async getPlan(taskId) { return plans.get(taskId) ?? null; },
    async saveLedgerEntry(taskId, value) { ledger.set(taskId, [...(ledger.get(taskId) ?? []), value]); },
    async getLedgerEntries(taskId) { return ledger.get(taskId) ?? []; },
    async saveAuditLog(taskId, value) { audits.set(taskId, [...(audits.get(taskId) ?? []), value]); },
    async getAuditLogs(taskId) { return audits.get(taskId) ?? []; },
    async saveAgent(taskId, value) {
      const current = [...(agents.get(taskId) ?? [])];
      const index = current.findIndex((item) => item.id === value.id);
      if (index < 0) current.push(value); else current[index] = value;
      agents.set(taskId, current);
    },
    async getAgents(taskId) { return agents.get(taskId) ?? []; },
    async saveRuntimeEvent(value) { events.push(value); },
    async getRuntimeEvents(taskId) { return events.filter((event) => event.taskId === taskId); },
  };
}

/** A lease-aware queue store used only to keep this E2E test provider-free. */
class QueueMemoryStore implements IQueueStore {
  readonly items = new Map<string, QueueItem & { status: QueueItemStatus; leaseId?: string; leasedUntil?: number }>();
  async enqueueQueueItem(item: QueueItem) {
    if (!this.items.has(item.id)) this.items.set(item.id, { ...item, status: "pending" });
  }
  async claimQueueItems(input: { queue: QueueName; taskId?: string; consumerId: string; limit?: number; leaseMs?: number }): Promise<QueueClaim[]> {
    const now = Date.now();
    const claims: QueueClaim[] = [];
    for (const item of this.items.values()) {
      if (claims.length >= (input.limit ?? 20)) break;
      if (item.queue !== input.queue || (input.taskId && item.taskId !== input.taskId) || item.status !== "pending") continue;
      if (new Date(item.availableAt).getTime() > now) continue;
      if (item.queue === "agent" && item.recipientId !== input.consumerId) continue;
      const leaseId = `${item.id}:${input.consumerId}:${item.attempts + 1}`;
      item.status = "leased";
      item.leaseId = leaseId;
      item.leasedUntil = now + (input.leaseMs ?? 30_000);
      item.attempts += 1;
      claims.push({ item, leaseId, leasedUntil: new Date(item.leasedUntil).toISOString() });
    }
    return claims;
  }
  async acknowledgeQueueItem(input: { id: string; leaseId: string }) {
    const item = this.items.get(input.id);
    if (!item || item.status !== "leased" || item.leaseId !== input.leaseId) throw new Error("invalid queue acknowledgement lease");
    item.status = "done";
  }
  async retryQueueItem(input: { id: string; leaseId: string; availableAt?: string }) {
    const item = this.items.get(input.id);
    if (!item || item.status !== "leased" || item.leaseId !== input.leaseId) throw new Error("invalid queue retry lease");
    item.status = "pending";
    item.availableAt = input.availableAt ?? new Date().toISOString();
    delete item.leaseId;
    delete item.leasedUntil;
  }
  async releaseExpiredQueueLeases(queue?: QueueName) {
    const now = Date.now(); let released = 0;
    for (const item of this.items.values()) {
      if (item.status === "leased" && (!queue || item.queue === queue) && (item.leasedUntil ?? 0) <= now) {
        item.status = "pending"; delete item.leaseId; delete item.leasedUntil; released++;
      }
    }
    return released;
  }
  async getQueueItems(taskId: string, options?: { queue?: QueueName; status?: QueueItemStatus }) {
    return [...this.items.values()].filter((item) => item.taskId === taskId && (!options?.queue || item.queue === options.queue) && (!options?.status || item.status === options.status));
  }
}

const call = (name: string, args: Record<string, unknown>, id: string) =>
  new AIMessage({ content: "", tool_calls: [{ name, args, id, type: "tool_call" }] });

class ScriptedWorker extends BaseChatModel {
  constructor(
    private readonly roleOrModel: string,
    private readonly scenario: Scenario,
    private readonly calls: Array<{ role: string; text: string }>,
    private readonly state: {
      apiFailures: number;
      toolFailures: number;
      resumeCalls: number;
      parallelStarted: number;
      parallelOverlap: boolean;
      parallelReady: Promise<void>;
      releaseParallel: () => void;
    },
  ) { super({}); }
  _llmType() { return "yaaa-e2e-scripted"; }
  override bindTools() { return this; }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const text = messages.map((message) => String(message.content ?? "")).join("\n");
    const role = this.roleOrModel === "verifier" ? "verifier" : "worker";
    this.calls.push({ role, text });
    if (role === "verifier") {
      const message = new AIMessage({ content: JSON.stringify({ status: "passed", summary: "All scripted criteria passed.", findings: [], evidence: ["artifacts and event journal inspected"] }) });
      return { generations: [{ text: String(message.content), message }] as ChatGeneration[] };
    }
    const hasToolResult = messages.some((message) => message._getType?.() === "tool");
    if (this.scenario === "api-failure" && this.state.apiFailures++ === 0) throw new Error("mock provider timeout");
    if (this.scenario === "resume" && (!hasToolResult || this.state.resumeCalls > 0)) {
      if (!hasToolResult && this.state.resumeCalls++ === 0) {
        return { generations: [{ text: "", message: call("write_file", { path: "partial.txt", content: "checkpoint-before-failure" }, "partial-1") }] };
      }
      throw new Error("mock worker stopped after checkpoint");
    }
    if (!hasToolResult) {
      if (this.scenario === "parallel") {
        this.state.parallelStarted++;
        if (this.state.parallelStarted === 2) {
          this.state.parallelOverlap = true;
          this.state.releaseParallel();
        }
        await this.state.parallelReady;
      }
      if (this.scenario === "resume-recovery") {
        return { generations: [{ text: "", message: call("read_file", { path: "partial.txt" }, "read-checkpoint") }] };
      }
      if (this.scenario === "handover") return { generations: [{ text: "", message: call("ask_orchestrator", { question: "Please confirm the handover path before finalizing the artifact." }, "handover-1") }] };
      const match = text.match(/(?:write|create|artifact)[^\n]*?([a-z][a-z0-9_-]*\.txt)/i);
      const file = match?.[1] ?? "result.txt";
      return { generations: [{ text: "", message: call("write_file", { path: file, content: `completed:${file}` }, `write-${file}`) }] };
    }
    if (this.scenario === "resume-recovery" && messages.some((message) => (message as any).name === "read_file") && !messages.some((message) => (message as any).name === "write_file")) {
      return { generations: [{ text: "", message: call("write_file", { path: "resumed.txt", content: "completed:resumed.txt" }, "resume-write") }] };
    }
    if (this.scenario === "tool-failure" && this.state.toolFailures++ === 0) {
      return { generations: [{ text: "", message: call("write_file", { path: "recovered.txt", content: "retry-success" }, "write-retry") }] };
    }
    const message = new AIMessage({ content: "Subtask completed from the current workspace state." });
    return { generations: [{ text: String(message.content), message }] };
  }
}

function gatewayFor(calls: Array<{ role: string; text: string }>, failUtilityOnce = false): IMeshGateway {
  let failed = false;
  return {
    async chat(messages, options) {
      calls.push({ role: options.modelRole, text: messages.map((message) => message.content).join("\n") });
      if (failUtilityOnce && !failed && options.modelRole === "utility") { failed = true; throw new Error("mock assessor API outage"); }
      if (messages[0]?.content.includes("final synthesis")) return { content: JSON.stringify({ passed: true, summary: "E2E synthesis passed." }) };
      return { content: JSON.stringify({ action: "continue", reason: "scripted progress is sufficient" }) };
    },
    async *chatStream() {},
  };
}

async function setup(scenario: Scenario, store = memoryStore()) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "yaaa-e2e-"));
  const scope = new Container();
  const modelCalls: Array<{ role: string; text: string }> = [];
  let releaseParallel = () => {};
  const parallelReady = new Promise<void>((resolve) => { releaseParallel = resolve; });
  const state = {
    apiFailures: 0,
    toolFailures: 0,
    resumeCalls: 0,
    parallelStarted: 0,
    parallelOverlap: false,
    parallelReady,
    releaseParallel,
  };
  const permissions = new PermissionEngine();
  permissions.registerApprovalHandler(async () => true);
  scope.register("IStore", store);
  scope.register("IBus", new MessageBus(store));
  scope.register("PermissionEngine", permissions);
  scope.register("IMeshGateway", gatewayFor(modelCalls, scenario === "api-failure"));
  scope.register("capability:files", new FilesFs(workspace, { allowedRoots: [] }));
  scope.register("workingDir", workspace);
  scope.register("ChatModelFactory", (role: string) => new ScriptedWorker(role, scenario, modelCalls, state));
  return { scope, store, workspace, modelCalls, state };
}

const plan = (subtasks: TaskPlan["subtasks"]): TaskPlan => ({ goal: "Complete the scripted end-to-end mission", subtasks });
const subtask = (id: string, title: string, dependsOn: string[] = [], capability: "files" | "verify" = "files") => ({ id, title, capability, dependsOn, riskLevel: "low" as const, successCriteria: "the requested artifact exists", state: "pending" as const });

describe("agent event loops — end-to-end scenarios", () => {
  const workspaces: string[] = [];
  afterEach(async () => { await Promise.all(workspaces.splice(0).map((workspace) => fs.rm(workspace, { recursive: true, force: true }))); });

  it("runs a single worker happy path through planning, tool use, persistence, and synthesis", async () => {
    const h = await setup("happy"); workspaces.push(h.workspace);
    const result = await new Supervisor(h.scope).runPlan(plan([subtask("one", "write result.txt")]), "single");
    expect(result.success).toBe(true);
    expect(await fs.readFile(path.join(h.workspace, "result.txt"), "utf8")).toContain("completed");
    expect(h.store.events.map((event) => event.topic)).toEqual(expect.arrayContaining(["task.single.agent_message", "task.single.completed"]));
    expect(h.store.events.filter((event) => event.topic.endsWith("action_completed"))).not.toHaveLength(0);
  });

  it("executes dependent subtasks sequentially and threads the producer handoff", async () => {
    const h = await setup("happy"); workspaces.push(h.workspace);
    const result = await new Supervisor(h.scope).runPlan(plan([subtask("first", "write first.txt"), subtask("second", "write second.txt", ["first"])]), "sequential");
    expect(result.success).toBe(true);
    expect(await fs.readFile(path.join(h.workspace, "first.txt"), "utf8")).toContain("first.txt");
    expect(await fs.readFile(path.join(h.workspace, "second.txt"), "utf8")).toContain("second.txt");
    const workers = h.modelCalls.filter((entry) => entry.role === "worker");
    expect(workers.at(-1)?.text).toContain("first");
  });

  it("runs independent subtasks in parallel", async () => {
    const h = await setup("parallel"); workspaces.push(h.workspace);
    const result = await new Supervisor(h.scope).runPlan(plan([subtask("left", "write left.txt"), subtask("right", "write right.txt")]), "parallel");
    expect(result.success).toBe(true);
    await expect(fs.access(path.join(h.workspace, "left.txt"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(h.workspace, "right.txt"))).resolves.toBeUndefined();
    expect(h.state.parallelOverlap).toBe(true);
    expect(h.state.parallelStarted).toBe(2);
    expect((await h.store.getAgents("parallel")).filter((agent) => agent.status === "completed")).toHaveLength(2);
  });

  it("handles an explicit worker-to-orchestrator handover before completing", async () => {
    const h = await setup("handover"); workspaces.push(h.workspace);
    const result = await new Supervisor(h.scope).runPlan(plan([subtask("handover", "ask for handover and write handover.txt")]), "handover");
    expect(result.success).toBe(true);
    expect(h.store.events.some((event) => event.topic === "task.handover.agent_message" && (event.payload as any)?.kind === "help_request")).toBe(true);
  });

  it("delivers sub-agent questions and main-agent replies through durable queues", async () => {
    const taskId = "queue-handoff";
    const store = new QueueMemoryStore();
    const queue = new DurableEventQueue(store);
    const now = new Date().toISOString();
    const trace: string[] = [];

    await queue.enqueue({
      id: "assignment-1",
      taskId,
      queue: "agent",
      recipientId: "sub-agent-1",
      payload: { kind: "assignment", instruction: "prepare the report" },
      createdAt: now,
      availableAt: now,
      attempts: 0,
    });

    const mainAgent = (async () => {
      await queue.waitForWork(taskId, 1_000);
      const [claim] = await queue.claim("orchestrator", taskId, "main-agent");
      expect(claim?.item.payload).toEqual({ kind: "question", from: "sub-agent-1", question: "Which format should I use?" });
      trace.push("main-picked-question");
      await queue.acknowledge(claim);
      await queue.enqueue({
        id: "reply-1",
        taskId,
        queue: "agent",
        recipientId: "sub-agent-1",
        payload: { kind: "reply", from: "main-agent", answer: "Use markdown." },
        createdAt: new Date().toISOString(),
        availableAt: new Date().toISOString(),
        attempts: 0,
      });
      trace.push("main-sent-reply");
    })();

    const subAgent = (async () => {
      const [assignment] = await queue.claim("agent", taskId, "sub-agent-1");
      expect(assignment?.item.payload).toEqual({ kind: "assignment", instruction: "prepare the report" });
      trace.push("sub-picked-assignment");
      await queue.acknowledge(assignment);
      await queue.enqueue({
        id: "question-1",
        taskId,
        queue: "orchestrator",
        payload: { kind: "question", from: "sub-agent-1", question: "Which format should I use?" },
        createdAt: new Date().toISOString(),
        availableAt: new Date().toISOString(),
        attempts: 0,
      });
      trace.push("sub-asked-main");
      await queue.waitForWork(taskId, 1_000);
      const [reply] = await queue.claim("agent", taskId, "sub-agent-1");
      expect(reply?.item.payload).toEqual({ kind: "reply", from: "main-agent", answer: "Use markdown." });
      trace.push("sub-picked-reply");
      await queue.acknowledge(reply);
    })();

    await Promise.all([mainAgent, subAgent]);
    expect(trace).toEqual([
      "sub-picked-assignment",
      "sub-asked-main",
      "main-picked-question",
      "main-sent-reply",
      "sub-picked-reply",
    ]);
    expect(await store.getQueueItems(taskId, { status: "done" })).toHaveLength(3);
    expect(await store.getQueueItems(taskId, { status: "pending" })).toHaveLength(0);
    expect(await store.getQueueItems(taskId, { status: "leased" })).toHaveLength(0);
  });

  it("records a tool failure and lets the worker recover with a follow-up tool call", async () => {
    const h = await setup("tool-failure"); workspaces.push(h.workspace);
    const files = h.scope.resolve<any>("capability:files");
    const original = files.writeFile.bind(files); let failed = false;
    files.writeFile = async (...args: any[]) => { if (!failed && args[0] === "recovered.txt") { failed = true; throw new Error("mock disk failure"); } return original(...args); };
    const result = await new Supervisor(h.scope).runPlan(plan([subtask("tools", "write recovered.txt")]), "tool-failure");
    expect(result.success).toBe(true);
    expect(await fs.readFile(path.join(h.workspace, "recovered.txt"), "utf8")).toBe("retry-success");
    expect(h.store.events.some((event) => event.topic.endsWith("action_failed"))).toBe(true);
  });

  it("retries an API failure and still completes the mission", async () => {
    const h = await setup("api-failure"); workspaces.push(h.workspace);
    const result = await new Supervisor(h.scope).runPlan(plan([subtask("api", "write api.txt")]), "api-failure");
    expect(result.success).toBe(true);
    expect(h.modelCalls.filter((entry) => entry.role === "worker").length).toBeGreaterThan(1);
  });

  it("restarts from persisted workspace/checkpoint state after a failed attempt", async () => {
    const first = await setup("resume"); workspaces.push(first.workspace);
    const mission = plan([subtask("resume", "write resumed.txt")]);
    const failed = await new Supervisor(first.scope).runPlan(mission, "resume");
    expect(failed.success).toBe(false);
    expect(await fs.readFile(path.join(first.workspace, "partial.txt"), "utf8")).toBe("checkpoint-before-failure");
    const second = await setup("resume-recovery", first.store); workspaces.push(second.workspace);
    // The durable store and the checkpoint workspace are deliberately reused.
    second.scope.register("capability:files", new FilesFs(first.workspace, { allowedRoots: [] }));
    second.scope.register("workingDir", first.workspace);
    const resumed = await new Supervisor(second.scope).runPlan(mission, "resume");
    expect(resumed.success).toBe(true);
    expect(await fs.readFile(path.join(first.workspace, "resumed.txt"), "utf8")).toContain("completed");
    expect(second.modelCalls.some((entry) => entry.role === "worker" && entry.text.includes("checkpoint-before-failure"))).toBe(true);
    expect((await second.store.getLedgerEntries("resume")).length).toBeGreaterThan(1);
  });
});
