import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DBEngine, AICallLoop } from "@yaaa/providers";
import type { IMeshGateway, ChatMessage, ChatResult, ChatOptions, IBus, IStore } from "@yaaa/interfaces";
import type { TaskPlan, Subtask } from "@yaaa/shared";
import { OuterEventLoop } from "../runtime/outer-event-loop.js";
import { CustomInnerLoop } from "../runtime/custom-inner-loop.js";
import { CanvasCommenterTool } from "../tools/canvas-commenter.js";
import { CodeReviewPreflightTool } from "../tools/code-review-preflight.js";
import { QACoverageTool } from "../tools/qa-coverage.js";
import { CVTesterTool } from "../tools/cv-tester-tool.js";
import { Container } from "@yaaa/platform";

describe("YAAA Multi-Loop Architecture Complex Edge-Case Integration Suite", () => {
  const testDir = path.resolve("./.yaaa/test_edge_cases_workspace");
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

  describe("1. Outer Event Loop Edge Cases", () => {
    it("handles rapid state transitions under active execution without deadlocks", async () => {
      const mockBus: IBus = {
        publish: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn(),
      };
      const mockStore: IStore = {
        savePlan: vi.fn().mockResolvedValue(undefined),
        getPlan: vi.fn().mockResolvedValue(null),
        initTaskDb: vi.fn().mockResolvedValue(undefined),
        saveMessage: vi.fn().mockResolvedValue(undefined),
        getMessages: vi.fn().mockResolvedValue([]),
        saveLedgerEntry: vi.fn().mockResolvedValue(undefined),
        getLedgerEntries: vi.fn().mockResolvedValue([]),
        saveAuditLog: vi.fn().mockResolvedValue(undefined),
        getAuditLogs: vi.fn().mockResolvedValue([]),
        saveExecutionSession: vi.fn().mockResolvedValue(undefined),
        getExecutionSessions: vi.fn().mockResolvedValue([]),
        saveExecutionObservation: vi.fn().mockResolvedValue(undefined),
        getExecutionObservations: vi.fn().mockResolvedValue([]),
        saveAgent: vi.fn().mockResolvedValue(undefined),
        getAgents: vi.fn().mockResolvedValue([]),
      };

      const scope = new Container();
      scope.register("IBus", mockBus);
      scope.register("IStore", mockStore);
      scope.register("DBEngine", dbEngine);

      const mockMesh: IMeshGateway = {
        async chat(): Promise<ChatResult> {
          return { content: "Subtask response" };
        },
        async *chatStream(): AsyncIterable<string> {
          yield "stream";
        },
      };
      scope.register("IMeshGateway", mockMesh);

      const outerLoop = new OuterEventLoop(scope);

      await outerLoop.transitionState("task-rapid", "BACKGROUND_ISOLATED", "User closed window");
      expect(outerLoop.getCurrentState()).toBe("BACKGROUND_ISOLATED");

      await outerLoop.transitionState("task-rapid", "CHAT_SPACE_ACTIVE", "User re-opened window");
      expect(outerLoop.getCurrentState()).toBe("CHAT_SPACE_ACTIVE");

      await outerLoop.transitionState("task-rapid", "GOING_HOME_SUSPENDED", "User clicked home");
      expect(outerLoop.getCurrentState()).toBe("GOING_HOME_SUSPENDED");

      await outerLoop.transitionState("task-rapid", "RECOVERING", "User restored space");
      expect(outerLoop.getCurrentState()).toBe("RECOVERING");

      const outerDb = dbEngine.getOuterLoopDb("task-rapid");
      const records = dbEngine.getWALRecords(outerDb, "task-rapid");
      expect(records.length).toBe(4);
      expect(records.map((r) => r.type)).toEqual([
        "STATE_TRANSITION",
        "STATE_TRANSITION",
        "STATE_TRANSITION",
        "STATE_TRANSITION",
      ]);
    });

    it("recovers plan state from WAL logs after abrupt process crash", async () => {
      const outerDb = dbEngine.getOuterLoopDb("task-crash");
      dbEngine.writeWALRecord(outerDb, {
        id: "crash-1",
        entityId: "task-crash",
        sequence: 1,
        type: "PLAN_START",
        payload: { subtaskCount: 2 },
        timestamp: new Date().toISOString(),
      });
      dbEngine.writeWALRecord(outerDb, {
        id: "crash-2",
        entityId: "task-crash",
        sequence: 2,
        type: "SUBTASK_COMPLETED",
        payload: { subtaskId: "sub-1", status: "completed", summary: "Part 1 finished" },
        timestamp: new Date().toISOString(),
      });

      const mockPlan: TaskPlan = {
        goal: "Build system",
        subtasks: [
          { id: "sub-1", title: "Subtask 1", roles: ["FilesAgent"], capabilities: ["files"], dependsOn: [], riskLevel: "low", successCriteria: "done", state: "completed" },
          { id: "sub-2", title: "Subtask 2", roles: ["FilesAgent"], capabilities: ["files"], dependsOn: ["sub-1"], riskLevel: "low", successCriteria: "done", state: "pending" },
        ],
      };

      const mockBus: IBus = { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() };
      const mockStore: IStore = {
        savePlan: vi.fn().mockResolvedValue(undefined),
        getPlan: vi.fn().mockResolvedValue(mockPlan),
        initTaskDb: vi.fn().mockResolvedValue(undefined),
        saveMessage: vi.fn().mockResolvedValue(undefined),
        getMessages: vi.fn().mockResolvedValue([]),
        saveLedgerEntry: vi.fn().mockResolvedValue(undefined),
        getLedgerEntries: vi.fn().mockResolvedValue([]),
        saveAuditLog: vi.fn().mockResolvedValue(undefined),
        getAuditLogs: vi.fn().mockResolvedValue([]),
        saveExecutionSession: vi.fn().mockResolvedValue(undefined),
        getExecutionSessions: vi.fn().mockResolvedValue([]),
        saveExecutionObservation: vi.fn().mockResolvedValue(undefined),
        getExecutionObservations: vi.fn().mockResolvedValue([]),
        saveAgent: vi.fn().mockResolvedValue(undefined),
        getAgents: vi.fn().mockResolvedValue([]),
      };

      const scope = new Container();
      scope.register("IBus", mockBus);
      scope.register("IStore", mockStore);
      scope.register("DBEngine", dbEngine);

      const mockMesh: IMeshGateway = {
        async chat(): Promise<ChatResult> { return { content: "ok" }; },
        async *chatStream(): AsyncIterable<string> { yield ""; },
      };
      scope.register("IMeshGateway", mockMesh);

      const outerLoop = new OuterEventLoop(scope);
      const recoveredPlan = await outerLoop.recoverState("task-crash");

      expect(recoveredPlan).not.toBeNull();
      expect(recoveredPlan?.subtasks[0].state).toBe("completed");
    });
  });

  describe("2. Custom Inner Loop Edge Cases", () => {
    it("enforces repeat call guard when tool is invoked with identical parameters 4 times", async () => {
      let callCount = 0;
      const mockMesh: IMeshGateway = {
        async chat(): Promise<ChatResult> {
          callCount++;
          if (callCount <= 4) {
            return {
              content: "Calling tool repeat",
              toolCalls: [{ id: `call-${callCount}`, name: "files:readFile", args: { path: "config.json" } }],
            };
          }
          return { content: "Finishing after repeat guard notice." };
        },
        async *chatStream(): AsyncIterable<string> {
          yield "stream";
        },
      };

      const scope = new Container();
      scope.register("IBus", { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() });
      scope.register("IMeshGateway", mockMesh);
      scope.register("DBEngine", dbEngine);

      const innerLoop = new CustomInnerLoop(scope);
      const res = await innerLoop.run({
        agentId: "agent-repeat-guard",
        taskId: "task-repeat",
        templateName: "FilesAgent",
        instruction: "Read config file",
        workspaceDir: path.join(testDir, "task-repeat"),
        maxTurns: 10,
      });

      expect(res.completed).toBe(true);

      const agentDb = dbEngine.getAgentDb("task-repeat", "agent-repeat-guard");
      const records = dbEngine.getWALRecords(agentDb, "agent-repeat-guard");
      const toolObs = records.filter((r) => r.type === "TOOL_OBSERVATION");
      expect(toolObs.length).toBeGreaterThanOrEqual(4);
      expect(JSON.stringify(toolObs[3].payload)).toContain("REPEAT GUARD");
    });

    it("handles context compaction across 25 turns without memory leaks", async () => {
      let turnCounter = 0;
      const mockMesh: IMeshGateway = {
        async chat(): Promise<ChatResult> {
          turnCounter++;
          if (turnCounter < 25) {
            return {
              content: `Turn ${turnCounter} response`,
              toolCalls: [{ id: `call-${turnCounter}`, name: "qa:checkCoverage", args: { linesTested: 10, linesTotal: 10 } }],
            };
          }
          return { content: "Completed 25 turns." };
        },
        async *chatStream(): AsyncIterable<string> {
          yield "stream";
        },
      };

      const scope = new Container();
      scope.register("IBus", { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() });
      scope.register("IMeshGateway", mockMesh);
      scope.register("DBEngine", dbEngine);

      const innerLoop = new CustomInnerLoop(scope);
      const res = await innerLoop.run({
        agentId: "agent-compaction-25",
        taskId: "task-compaction-25",
        templateName: "FilesAgent",
        instruction: "Execute long task",
        workspaceDir: path.join(testDir, "task-compaction-25"),
        maxTurns: 30,
      });

      expect(res.completed).toBe(true);

      const agentDb = dbEngine.getAgentDb("task-compaction-25", "agent-compaction-25");
      const compaction = dbEngine.getLatestCompactionCheckpoint(agentDb, "agent-compaction-25");
      expect(compaction).not.toBeNull();
      expect(compaction?.sequence).toBeGreaterThanOrEqual(20);
    });

    it("truncates oversized tool outputs (> 20,000 chars) cleanly", async () => {
      const hugeComments = Array.from({ length: 300 }, (_, i) => ({
        x: i, y: i, width: 10, height: 10, comment: `Annotation comment ${i} with long visual rationale details for testing output limit`,
      }));

      const mockMesh: IMeshGateway = {
        async chat(messages: ChatMessage[]): Promise<ChatResult> {
          const lastMsg = messages[messages.length - 1];
          if (lastMsg.role === "user" && lastMsg.content.includes("[Tool Observation")) {
            expect(lastMsg.content.length).toBeLessThan(25_000);
            expect(lastMsg.content).toContain("truncated oversized tool output");
            return { content: "Parsed truncated output successfully." };
          }
          return {
            content: "Generating huge tool output",
            toolCalls: [{ id: "call-huge", name: "canvas:parseAnnotations", args: { imageUrl: "http://example.com/huge.png", annotations: hugeComments } }],
          };
        },
        async *chatStream(): AsyncIterable<string> {
          yield "stream";
        },
      };

      const scope = new Container();
      scope.register("IBus", { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() });
      scope.register("IMeshGateway", mockMesh);
      scope.register("DBEngine", dbEngine);

      const innerLoop = new CustomInnerLoop(scope);
      const res = await innerLoop.run({
        agentId: "agent-huge-output",
        taskId: "task-huge",
        templateName: "DesignerAgent",
        instruction: "Inspect canvas",
        workspaceDir: path.join(testDir, "task-huge"),
        maxTurns: 5,
      });

      expect(res.completed).toBe(true);
    });
  });

  describe("3. Dedicated AI Call Loop Edge Cases", () => {
    it("handles concurrency burst of 10 requests respecting HIGH priority first", async () => {
      const executionOrder: string[] = [];
      let resolveBlocker: (() => void) | undefined;
      const blockerPromise = new Promise<void>((r) => { resolveBlocker = r; });

      const mockMesh: IMeshGateway = {
        async chat(messages: ChatMessage[]): Promise<ChatResult> {
          const id = messages[0].content;
          if (id === "BLOCKER") {
            await blockerPromise;
            return { content: "Blocker finished" };
          }
          executionOrder.push(id);
          return { content: `Response for ${id}` };
        },
        async *chatStream(): AsyncIterable<string> {
          yield "stream";
        },
      };

      const aiCallLoop = new AICallLoop(mockMesh, dbEngine, { maxConcurrentCalls: 1 });

      const blockerCall = aiCallLoop.executeCall("task-burst", "user", "worker", [{ role: "user", content: "BLOCKER" }], {}, "LOW");

      const callLow1 = aiCallLoop.executeCall("task-burst", "user", "worker", [{ role: "user", content: "LOW-1" }], {}, "LOW");
      const callLow2 = aiCallLoop.executeCall("task-burst", "user", "worker", [{ role: "user", content: "LOW-2" }], {}, "LOW");
      const callHigh = aiCallLoop.executeCall("task-burst", "user", "worker", [{ role: "user", content: "HIGH-1" }], {}, "HIGH");
      const callMed = aiCallLoop.executeCall("task-burst", "user", "worker", [{ role: "user", content: "MEDIUM-1" }], {}, "MEDIUM");

      resolveBlocker?.();
      await Promise.all([blockerCall, callLow1, callLow2, callHigh, callMed]);

      expect(executionOrder).toEqual(["HIGH-1", "MEDIUM-1", "LOW-1", "LOW-2"]);
    });

    it("logs failed AI calls accurately into ai_call_logs DB", async () => {
      const mockMesh: IMeshGateway = {
        async chat(): Promise<ChatResult> {
          throw new Error("Provider 500 Internal Server Error");
        },
        async *chatStream(): AsyncIterable<string> {
          yield "stream";
        },
      };

      const aiCallLoop = new AICallLoop(mockMesh, dbEngine);

      await expect(
        aiCallLoop.executeCall("task-fail-log", "agent-1", "worker", [{ role: "user", content: "test" }], {}, "MEDIUM"),
      ).rejects.toThrow("Provider 500 Internal Server Error");

      const aiDb = dbEngine.getAICallLoopDb("task-fail-log");
      const rows = aiDb.prepare("SELECT status, payload FROM ai_call_logs WHERE task_id = ?").all("task-fail-log") as any[];
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe("failed");
      expect(rows[0].payload).toContain("500 Internal Server Error");
    });
  });

  describe("4. Storage Engine & Database Concurrency Edge Cases", () => {
    it("handles simultaneous multi-database writes across isolated DBs", async () => {
      const outerDb = dbEngine.getOuterLoopDb("task-concurrent");
      const aiDb = dbEngine.getAICallLoopDb("task-concurrent");
      const agentDb1 = dbEngine.getAgentDb("task-concurrent", "agent-1");
      const agentDb2 = dbEngine.getAgentDb("task-concurrent", "agent-2");

      const writes = [
        Promise.resolve().then(() => dbEngine.writeWALRecord(outerDb, { id: "w1", entityId: "t1", sequence: 1, type: "TEST", payload: {}, timestamp: new Date().toISOString() })),
        Promise.resolve().then(() => dbEngine.writeWALRecord(aiDb, { id: "w2", entityId: "t1", sequence: 1, type: "TEST", payload: {}, timestamp: new Date().toISOString() })),
        Promise.resolve().then(() => dbEngine.writeWALRecord(agentDb1, { id: "w3", entityId: "a1", sequence: 1, type: "TEST", payload: {}, timestamp: new Date().toISOString() })),
        Promise.resolve().then(() => dbEngine.writeWALRecord(agentDb2, { id: "w4", entityId: "a2", sequence: 1, type: "TEST", payload: {}, timestamp: new Date().toISOString() })),
      ];

      await Promise.all(writes);

      expect(dbEngine.getWALRecords(outerDb, "t1").length).toBe(1);
      expect(dbEngine.getWALRecords(aiDb, "t1").length).toBe(1);
      expect(dbEngine.getWALRecords(agentDb1, "a1").length).toBe(1);
      expect(dbEngine.getWALRecords(agentDb2, "a2").length).toBe(1);
    });
  });

  describe("5. Specialist Tools Boundary Edge Cases", () => {
    it("QACoverageTool evaluates 94.99% as failed and 95.00% as passed", async () => {
      const tool = new QACoverageTool();
      const failRes = await tool.execute({ linesTested: 9499, linesTotal: 10000 });
      expect(failRes.passedMandate).toBe(false);
      expect(failRes.coveragePercentage).toBe("94.99%");

      const passRes = await tool.execute({ linesTested: 9500, linesTotal: 10000 });
      expect(passRes.passedMandate).toBe(true);
      expect(passRes.coveragePercentage).toBe("95.00%");
    });

    it("CanvasCommenterTool handles empty annotation list gracefully", async () => {
      const tool = new CanvasCommenterTool();
      const res = await tool.execute({ imageUrl: "http://example.com/logo.png", annotations: [] });
      expect(res.annotationsParsed).toBe(0);
      expect(res.formattedDirectives).toContain("No visual canvas annotations provided");
    });
  });
});
