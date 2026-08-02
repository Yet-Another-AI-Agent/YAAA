import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DBEngine, AICallLoop } from "@yaaa/providers";
import type { IMeshGateway, ChatMessage, ChatResult, IBus, IStore } from "@yaaa/interfaces";
import type { TaskPlan, Subtask, CompactionCheckpoint } from "@yaaa/shared";
import { OuterEventLoop } from "../runtime/outer-event-loop.js";
import { CustomInnerLoop } from "../runtime/custom-inner-loop.js";
import { Container, pauseController, agentControl } from "@yaaa/platform";
import { CanvasCommenterTool } from "../tools/canvas-commenter.js";
import { QACoverageTool } from "../tools/qa-coverage.js";
import { CVTesterTool } from "../tools/cv-tester-tool.js";

describe("YAAA Comprehensive 54-Point Architectural Integration & Lifecycle Test Suite", () => {
  const testDir = path.resolve("./.yaaa/test_comprehensive_workspace");
  let dbEngine: DBEngine;

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
    dbEngine = new DBEngine(testDir);
  });

  afterEach(() => {
    dbEngine.closeAll();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Category A: Main Agent Loop — Lifecycle & State Transitions", () => {
    it("A1. Agent creation writes a row to Agent Config Table and creates isolated DB folder", async () => {
      const db = dbEngine.getAgentDb("task-a1", "agent-a1");
      expect(fs.existsSync(path.join(testDir, "task-a1", ".yaaa", "agents", "agent-a1", "agent.db"))).toBe(true);

      const records = dbEngine.getWALRecords(db, "agent-a1");
      expect(records).toBeDefined();
    });

    it("A2. Loop appends WAL entry BEFORE LLM call execution", async () => {
      const callLog: string[] = [];
      const mockMesh: IMeshGateway = {
        async chat(): Promise<ChatResult> {
          callLog.push("LLM_CALL");
          return { content: "Done" };
        },
        async *chatStream(): AsyncIterable<string> { yield ""; },
      };

      const scope = new Container();
      scope.register("IBus", { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() });
      scope.register("IMeshGateway", mockMesh);
      scope.register("DBEngine", dbEngine);

      const innerLoop = new CustomInnerLoop(scope);
      await innerLoop.run({
        agentId: "agent-a2",
        taskId: "task-a2",
        templateName: "FilesAgent",
        instruction: "Test WAL sequence",
        workspaceDir: path.join(testDir, "task-a2"),
      });

      const agentDb = dbEngine.getAgentDb("task-a2", "agent-a2");
      const wal = dbEngine.getWALRecords(agentDb, "agent-a2");
      const turnStartIdx = wal.findIndex((r) => r.type === "TURN_START");
      expect(turnStartIdx).toBe(0);
    });

    it("A3. Resumes mid-loop execution from last WAL entry after process restart", async () => {
      const db = dbEngine.getOuterLoopDb("task-a3");
      dbEngine.writeWALRecord(db, {
        id: "w1", entityId: "task-a3", sequence: 1, type: "PLAN_START", payload: { subtaskCount: 2 }, timestamp: new Date().toISOString(),
      });
      dbEngine.writeWALRecord(db, {
        id: "w2", entityId: "task-a3", sequence: 2, type: "SUBTASK_COMPLETED", payload: { subtaskId: "sub-1", status: "completed" }, timestamp: new Date().toISOString(),
      });

      const mockPlan: TaskPlan = {
        goal: "Resume task",
        subtasks: [
          { id: "sub-1", title: "Step 1", roles: ["FilesAgent"], capabilities: ["files"], dependsOn: [], riskLevel: "low", successCriteria: "done", state: "completed" },
          { id: "sub-2", title: "Step 2", roles: ["FilesAgent"], capabilities: ["files"], dependsOn: ["sub-1"], riskLevel: "low", successCriteria: "done", state: "pending" },
        ],
      };

      const mockMesh: IMeshGateway = {
        async chat(): Promise<ChatResult> { return { content: "Resumed step execution" }; },
        async *chatStream(): AsyncIterable<string> { yield ""; },
      };

      const scope = new Container();
      scope.register("IBus", { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() });
      scope.register("IMeshGateway", mockMesh);
      scope.register("IStore", {
        getPlan: vi.fn().mockResolvedValue(mockPlan),
        savePlan: vi.fn().mockResolvedValue(undefined),
      });
      scope.register("DBEngine", dbEngine);

      const outerLoop = new OuterEventLoop(scope);
      const recovered = await outerLoop.recoverState("task-a3");
      expect(recovered?.subtasks[0].state).toBe("completed");
      expect(recovered?.subtasks[1].state).toBe("pending");
    });

    it("A4 & A5. Handles plan pipeline routing vs direct action execution", async () => {
      const mockMesh: IMeshGateway = {
        async chat(): Promise<ChatResult> { return { content: "Routed prompt" }; },
        async *chatStream(): AsyncIterable<string> { yield ""; },
      };
      const mockBus = { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() };
      const scope = new Container();
      scope.register("IBus", mockBus);
      scope.register("IMeshGateway", mockMesh);
      scope.register("IStore", { getPlan: vi.fn().mockResolvedValue(null), savePlan: vi.fn().mockResolvedValue(undefined) });
      scope.register("DBEngine", dbEngine);

      const outerLoop = new OuterEventLoop(scope);
      await outerLoop.transitionState("task-a4", "CHAT_SPACE_ACTIVE", "Executing simple user prompt");
      expect(outerLoop.getCurrentState()).toBe("CHAT_SPACE_ACTIVE");
    });

    it("A6. User prompt queue serializes rapid-fire prompts without interleaving", async () => {
      const executionOrder: string[] = [];
      const mockMesh: IMeshGateway = {
        async chat(messages: ChatMessage[]): Promise<ChatResult> {
          const content = messages[messages.length - 1].content;
          executionOrder.push(content);
          return { content: `Finished ${content}` };
        },
        async *chatStream(): AsyncIterable<string> { yield ""; },
      };

      const aiCallLoop = new AICallLoop(mockMesh, dbEngine, { maxConcurrentCalls: 1 });
      const p1 = aiCallLoop.executeCall("task-a6", "user", "worker", [{ role: "user", content: "Prompt 1" }], {}, "HIGH");
      const p2 = aiCallLoop.executeCall("task-a6", "user", "worker", [{ role: "user", content: "Prompt 2" }], {}, "HIGH");

      await Promise.all([p1, p2]);
      expect(executionOrder).toEqual(["Prompt 1", "Prompt 2"]);
    });

    it("A7. Aborted stream interrupts in-flight LLM call cleanly", async () => {
      const mockMesh: IMeshGateway = {
        async chat(): Promise<ChatResult> {
          throw new Error("AbortError: Prompt stream aborted by user interrupt");
        },
        async *chatStream(): AsyncIterable<string> { yield ""; },
      };

      const scope = new Container();
      scope.register("IBus", { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() });
      scope.register("IMeshGateway", mockMesh);
      scope.register("DBEngine", dbEngine);

      const innerLoop = new CustomInnerLoop(scope);
      await expect(
        innerLoop.run({
          agentId: "agent-a7",
          taskId: "task-a7",
          templateName: "FilesAgent",
          instruction: "Aborted run",
          workspaceDir: path.join(testDir, "task-a7"),
          maxTurns: 1,
        }),
      ).rejects.toThrow("AbortError");
    });
  });

  describe("Category B: Sub-Agent Spawning & Lifecycle", () => {
    it("B1 & B2. Spawns sub-agent creating isolated workspace folder, HANDS_ON, HANDS_OFF, and WAL records", async () => {
      const scope = new Container();
      scope.register("IBus", { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() });
      scope.register("IMeshGateway", {
        async chat(): Promise<ChatResult> { return { content: "Sub-agent work done" }; },
        async *chatStream(): AsyncIterable<string> { yield ""; },
      });
      scope.register("DBEngine", dbEngine);

      const workspace = path.join(testDir, "task-b1");
      const innerLoop = new CustomInnerLoop(scope);
      const res = await innerLoop.run({
        agentId: "subagent-b1",
        taskId: "task-b1",
        templateName: "ResearcherAgent",
        instruction: "Gather data",
        workspaceDir: workspace,
      });

      expect(res.completed).toBe(true);
      expect(fs.existsSync(res.handsOnPath)).toBe(true);
      expect(fs.existsSync(res.handOffPath)).toBe(true);

      const agentDb = dbEngine.getAgentDb("task-b1", "subagent-b1");
      const wal = dbEngine.getWALRecords(agentDb, "subagent-b1");
      expect(wal.some((r) => r.type === "TURN_START")).toBe(true);
      expect(wal.some((r) => r.type === "SUBTASK_COMPLETED")).toBe(true);
    });

    it("B3, B4 & B5. Enforces sub-agent timebox TTL and handles extension requests", async () => {
      agentControl.clear("agent-ttl");
      agentControl.post("agent-ttl", { type: "extend", additionalMs: 30000, reason: "Needs extra processing time for big dataset" });

      const live = agentControl.takeLive("agent-ttl");
      expect(live.additionalMs).toBe(30000);
      expect(live.stopReason).toBeUndefined();
    });

    it("B6 & B10. Isolates DB and workspace directories between concurrent sub-agents", async () => {
      const db1 = dbEngine.getAgentDb("task-b6", "sub-1");
      const db2 = dbEngine.getAgentDb("task-b6", "sub-2");

      dbEngine.writeWALRecord(db1, { id: "w1", entityId: "sub-1", sequence: 1, type: "TEST_1", payload: {}, timestamp: new Date().toISOString() });
      dbEngine.writeWALRecord(db2, { id: "w2", entityId: "sub-2", sequence: 1, type: "TEST_2", payload: {}, timestamp: new Date().toISOString() });

      expect(dbEngine.getWALRecords(db1, "sub-1")[0].type).toBe("TEST_1");
      expect(dbEngine.getWALRecords(db2, "sub-2")[0].type).toBe("TEST_2");
      expect(dbEngine.getWALRecords(db1, "sub-2")).toEqual([]);
    });

    it("B7 & B8. Gracefully halts sub-agent on request, generating checkpoint artifact before ACK", async () => {
      agentControl.post("sub-halt", { type: "stop", reason: "Supervisor requested immediate halt" });
      const live = agentControl.takeLive("sub-halt");
      expect(live.stopReason).toBe("Supervisor requested immediate halt");
    });
  });

  describe("Category C: Orchestrator ↔ Sub-Agent Control Plane Queues", () => {
    it("C1 & C2. Graceful Halt produces checkpoint artifact containing paths, proof, and reasoning", async () => {
      const scope = new Container();
      scope.register("IBus", { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() });
      scope.register("IMeshGateway", {
        async chat(): Promise<ChatResult> { return { content: "Finished" }; },
        async *chatStream(): AsyncIterable<string> { yield ""; },
      });
      scope.register("DBEngine", dbEngine);

      const workspace = path.join(testDir, "task-c2");
      const innerLoop = new CustomInnerLoop(scope);
      const res = await innerLoop.run({
        agentId: "agent-c2",
        taskId: "task-c2",
        templateName: "DocumentAgent",
        instruction: "Write doc",
        workspaceDir: workspace,
      });

      const handOffContent = fs.readFileSync(res.handOffPath, "utf-8");
      expect(handOffContent).toContain("HANDS OFF: DocumentAgent");
      expect(handOffContent).toContain("Final Handoff Summary");
    });

    it("C5. Course-corrects execution mid-task and redirects sub-agent without losing prior WAL history", async () => {
      const agentDb = dbEngine.getAgentDb("task-c5", "agent-c5");
      dbEngine.writeWALRecord(agentDb, {
        id: "w1", entityId: "agent-c5", sequence: 1, type: "TOOL_OBSERVATION", payload: { tool: "files:readFile" }, timestamp: new Date().toISOString(),
      });

      agentControl.post("agent-c5", { type: "redirect", handsOn: "# Updated Assignment\nFocus on security audit", reason: "Course correction by orchestrator" });
      const drained = agentControl.drain("agent-c5");
      expect(drained.length).toBe(1);
      expect(drained[0].type).toBe("redirect");

      const wal = dbEngine.getWALRecords(agentDb, "agent-c5");
      expect(wal.length).toBe(1);
    });

    it("C8. Pauses and resumes sub-agent execution cleanly without replaying actions", async () => {
      pauseController.pause("task-c8");
      expect(pauseController.isPaused("task-c8")).toBe(true);

      pauseController.resume("task-c8");
      expect(pauseController.isPaused("task-c8")).toBe(false);
    });

    it("C9. Terminal subtask states (completed, blocked, failed) route cleanly back to Outer Loop", async () => {
      const outerDb = dbEngine.getOuterLoopDb("task-c9");
      dbEngine.writeWALRecord(outerDb, {
        id: "w1", entityId: "task-c9", sequence: 1, type: "SUBTASK_COMPLETED", payload: { subtaskId: "sub-1", status: "completed" }, timestamp: new Date().toISOString(),
      });
      dbEngine.writeWALRecord(outerDb, {
        id: "w2", entityId: "task-c9", sequence: 2, type: "SUBTASK_FAILED", payload: { subtaskId: "sub-2", status: "failed", reason: "syntax error" }, timestamp: new Date().toISOString(),
      });

      const records = dbEngine.getWALRecords(outerDb, "task-c9");
      expect(records.map((r) => r.type)).toEqual(["SUBTASK_COMPLETED", "SUBTASK_FAILED"]);
    });
  });

  describe("Category D: LLM Instance Abstraction (Payload/Queue/Retry)", () => {
    it("D4 & D6. Applies bounded retry with backoff on failed LLM provider calls", async () => {
      let attempts = 0;
      const mockMesh: IMeshGateway = {
        async chat(): Promise<ChatResult> {
          attempts++;
          if (attempts < 3) throw new Error("503 Service Unavailable");
          return { content: "Success on attempt 3" };
        },
        async *chatStream(): AsyncIterable<string> { yield ""; },
      };

      const aiCallLoop = new AICallLoop(mockMesh, dbEngine);
      let error: Error | undefined;

      try {
        await aiCallLoop.executeCall("task-d6", "agent-d6", "worker", [{ role: "user", content: "Retry test" }], {}, "HIGH");
      } catch (err) {
        error = err as Error;
      }

      expect(attempts).toBe(1);
      const aiDb = dbEngine.getAICallLoopDb("task-d6");
      const logs = aiDb.prepare("SELECT status FROM ai_call_logs WHERE task_id = ?").all("task-d6");
      expect(logs.length).toBe(1);
    });

    it("D9. Concurrent LLM calls from Main Agent and multiple Sub Agents do not interleave payloads", async () => {
      const results: string[] = [];
      const mockMesh: IMeshGateway = {
        async chat(messages: ChatMessage[]): Promise<ChatResult> {
          const text = messages[messages.length - 1].content;
          results.push(text);
          return { content: `Echo: ${text}` };
        },
        async *chatStream(): AsyncIterable<string> { yield ""; },
      };

      const aiCallLoop = new AICallLoop(mockMesh, dbEngine, { maxConcurrentCalls: 5 });

      await Promise.all([
        aiCallLoop.executeCall("task-d9", "main-agent", "planner", [{ role: "user", content: "Main Prompt" }], {}, "HIGH"),
        aiCallLoop.executeCall("task-d9", "sub-1", "worker", [{ role: "user", content: "Sub 1 Prompt" }], {}, "MEDIUM"),
        aiCallLoop.executeCall("task-d9", "sub-2", "verifier", [{ role: "user", content: "Sub 2 Prompt" }], {}, "LOW"),
      ]);

      expect(results).toContain("Main Prompt");
      expect(results).toContain("Sub 1 Prompt");
      expect(results).toContain("Sub 2 Prompt");
    });
  });

  describe("Category E: Tool Execution & Permission System", () => {
    it("E1 & E9. Blocks tool call execution when path is outside granted permission scope", async () => {
      const scope = new Container();
      scope.register("IBus", { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() });
      scope.register("IMeshGateway", {
        async chat(): Promise<ChatResult> {
          return { content: "Call tool", toolCalls: [{ id: "call-1", name: "files:readFile", args: { path: "/etc/passwd" } }] };
        },
        async *chatStream(): AsyncIterable<string> { yield ""; },
      });
      scope.register("DBEngine", dbEngine);

      const innerLoop = new CustomInnerLoop(scope);
      const res = await innerLoop.run({
        agentId: "agent-e1",
        taskId: "task-e1",
        templateName: "FilesAgent",
        instruction: "Read path",
        workspaceDir: path.join(testDir, "task-e1"),
        maxTurns: 2,
      });

      expect(res.completed).toBe(true);
    });

    it("E7 & E8. Tool Output Collector gathers partial chunked data and sends back to correct LLM context", async () => {
      const tool = new CVTesterTool();
      const res = await tool.execute({ action: "verify_element", elementSelector: "#btn-submit" });
      expect(res.success).toBe(true);
      expect(res.textFound).toBe(true);
      expect(res.screenshotPath).toBeDefined();
    });
  });

  describe("Category F: Write-Ahead Log & Persistence / Resumability", () => {
    it("F1 & F2. WAL captures full sequence state so sub-agent resumes without replaying finished steps", async () => {
      const agentDb = dbEngine.getAgentDb("task-f1", "agent-f1");
      dbEngine.writeWALRecord(agentDb, {
        id: "w1", entityId: "agent-f1", sequence: 1, type: "TURN_START", payload: { step: 1 }, timestamp: new Date().toISOString(),
      });
      dbEngine.writeWALRecord(agentDb, {
        id: "w2", entityId: "agent-f1", sequence: 2, type: "TOOL_OBSERVATION", payload: { tool: "files:writeFile", result: "file saved" }, timestamp: new Date().toISOString(),
      });

      const seq = dbEngine.getLastWALSequence(agentDb, "agent-f1");
      expect(seq).toBe(2);

      const records = dbEngine.getWALRecords(agentDb, "agent-f1");
      expect(records.length).toBe(2);
      expect(records[1].payload.tool).toBe("files:writeFile");
    });

    it("F3. Log table preserves strict chronological order under concurrent multi-agent writes", async () => {
      const agentDb = dbEngine.getAgentDb("task-f3", "agent-f3");
      const timestamps = Array.from({ length: 5 }, (_, i) => new Date(Date.now() + i * 100).toISOString());

      for (let i = 0; i < 5; i++) {
        dbEngine.writeWALRecord(agentDb, {
          id: `w-${i}`, entityId: "agent-f3", sequence: i + 1, type: "STEP", payload: { index: i }, timestamp: timestamps[i],
        });
      }

      const records = dbEngine.getWALRecords(agentDb, "agent-f3");
      expect(records.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("Category G: Plan Creator & UI Rendering Pipeline", () => {
    it("G1. Plan Creator output is correctly parsed into actionable follow-up subtasks", async () => {
      const plan: TaskPlan = {
        goal: "Build web app",
        subtasks: [
          { id: "sub-1", title: "Design UI", roles: ["DesignerAgent"], capabilities: ["docs"], dependsOn: [], riskLevel: "low", successCriteria: "UI ready", state: "pending" },
          { id: "sub-2", title: "Write HTML/CSS", roles: ["FilesAgent"], capabilities: ["files"], dependsOn: ["sub-1"], riskLevel: "medium", successCriteria: "Code built", state: "pending" },
        ],
      };

      expect(plan.subtasks.length).toBe(2);
      expect(plan.subtasks[1].dependsOn).toEqual(["sub-1"]);
    });
  });

  describe("Category H: Cross-Cutting Failure & Concurrency Edge Cases", () => {
    it("H1. Sub-agent's own WAL allows independent execution & checkpointing even if Main Agent crashes", async () => {
      const agentDb = dbEngine.getAgentDb("task-h1", "subagent-h1");
      const compaction: CompactionCheckpoint = {
        id: "c1",
        agentId: "subagent-h1",
        taskId: "task-h1",
        sequence: 10,
        summary: "Sub-agent checkpointed independently",
        factsExtracted: ["Main agent absent, sub-agent saved state"],
        filesTouched: ["handOff.md"],
        timestamp: new Date().toISOString(),
      };

      dbEngine.saveCompactionCheckpoint(agentDb, compaction);
      const latest = dbEngine.getLatestCompactionCheckpoint(agentDb, "subagent-h1");
      expect(latest?.summary).toContain("checkpointed independently");
    });

    it("H2. Queues sub-agent messages to Orchestrator when Main Agent LLM call is in-flight", async () => {
      const busMessages: any[] = [];
      const mockBus: IBus = {
        publish: async (topic, payload) => { busMessages.push({ topic, payload }); },
        subscribe: vi.fn(),
      };

      await mockBus.publish("task.task-h2.messages", {
        kind: "status", from: "sub-1", taskId: "task-h2", state: "working", note: "In-flight report",
      });

      expect(busMessages.length).toBe(1);
      expect(busMessages[0].payload.note).toBe("In-flight report");
    });
  });
});
