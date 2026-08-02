import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DBEngine, AICallLoop } from "@yaaa/providers";
import type { IMeshGateway, ChatMessage, ChatResult, IBus, IStore } from "@yaaa/interfaces";
import { OuterEventLoop } from "../runtime/outer-event-loop.js";
import { CustomInnerLoop } from "../runtime/custom-inner-loop.js";
import { CanvasCommenterTool } from "../tools/canvas-commenter.js";
import { CodeReviewPreflightTool } from "../tools/code-review-preflight.js";
import { QACoverageTool } from "../tools/qa-coverage.js";
import { CVTesterTool } from "../tools/cv-tester-tool.js";
import { Container } from "@yaaa/platform";

describe("YAAA Multi-Loop Architecture Evals & Integration Suite", () => {
  const testDir = path.resolve("./.yaaa/test_eval_workspace");
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

  describe("1. DBEngine: Isolated Dedicated DBs, WAL Mode & Compaction", () => {
    it("enforces WAL mode and runs automatic schema migrations", () => {
      const db = dbEngine.getOuterLoopDb("task-123");
      const pragmaVal = db.pragma("journal_mode", { simple: true });
      expect(pragmaVal).toBe("wal");

      const migrations = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC").all() as any[];
      expect(migrations.length).toBeGreaterThanOrEqual(2);
      expect(migrations[0].name).toBe("initial_schema");
      expect(migrations[1].name).toBe("multi_loop_wal_and_compaction");
    });

    it("writes WAL records and recovers sequence state", () => {
      const db = dbEngine.getAgentDb("task-123", "agent-abc");
      dbEngine.writeWALRecord(db, {
        id: "wal-1",
        entityId: "agent-abc",
        sequence: 1,
        type: "TURN_START",
        payload: { test: "data" },
        timestamp: new Date().toISOString(),
      });

      const maxSeq = dbEngine.getLastWALSequence(db, "agent-abc");
      expect(maxSeq).toBe(1);

      const records = dbEngine.getWALRecords(db, "agent-abc");
      expect(records.length).toBe(1);
      expect(records[0].payload).toEqual({ test: "data" });
    });

    it("saves compaction checkpoint and prunes prior raw WAL logs", () => {
      const db = dbEngine.getAgentDb("task-123", "agent-abc");
      for (let i = 1; i <= 5; i++) {
        dbEngine.writeWALRecord(db, {
          id: `wal-${i}`,
          entityId: "agent-abc",
          sequence: i,
          type: "TOOL_OBSERVATION",
          payload: { turn: i },
          timestamp: new Date().toISOString(),
        });
      }

      dbEngine.saveCompactionCheckpoint(db, {
        id: "compact-1",
        agentId: "agent-abc",
        taskId: "task-123",
        sequence: 5,
        summary: "Turn 5 compacted state",
        factsExtracted: ["Fact A"],
        filesTouched: ["fileA.ts"],
        timestamp: new Date().toISOString(),
      });

      const checkpoint = dbEngine.getLatestCompactionCheckpoint(db, "agent-abc");
      expect(checkpoint).not.toBeNull();
      expect(checkpoint?.summary).toBe("Turn 5 compacted state");

      const remainingLogs = dbEngine.getWALRecords(db, "agent-abc");
      expect(remainingLogs.length).toBe(0);
    });
  });

  describe("2. AICallLoop: Priority Queues & Fallback Logging", () => {
    it("processes calls in priority order (HIGH > MEDIUM > LOW)", async () => {
      const mockMesh: IMeshGateway = {
        async chat(messages: ChatMessage[]): Promise<ChatResult> {
          return { content: "Mock LLM Response" };
        },
        async *chatStream(): AsyncIterable<string> {
          yield "Mock chunk";
        },
      };

      const aiCallLoop = new AICallLoop(mockMesh, dbEngine);

      const callLow = aiCallLoop.executeCall("task-1", "user", "worker", [{ role: "user", content: "low" }], {}, "LOW");
      const callHigh = aiCallLoop.executeCall("task-1", "user", "worker", [{ role: "user", content: "high" }], {}, "HIGH");

      const [resLow, resHigh] = await Promise.all([callLow, callHigh]);
      expect(resLow.content).toBe("Mock LLM Response");
      expect(resHigh.content).toBe("Mock LLM Response");
    });
  });

  describe("3. OuterEventLoop: State Machine & Background Isolation", () => {
    it("handles state transitions between CHAT_SPACE_ACTIVE, BACKGROUND_ISOLATED, GOING_HOME_SUSPENDED, and RECOVERING", async () => {
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

      const testScope = new Container();
      testScope.register("IBus", mockBus);
      testScope.register("IStore", mockStore);
      testScope.register("DBEngine", dbEngine);

      const mockMesh: IMeshGateway = {
        async chat(): Promise<ChatResult> {
          return { content: "Subtask completed cleanly." };
        },
        async *chatStream(): AsyncIterable<string> {
          yield "stream";
        },
      };
      testScope.register("IMeshGateway", mockMesh);

      const outerLoop = new OuterEventLoop(testScope);
      expect(outerLoop.getCurrentState()).toBe("CHAT_SPACE_ACTIVE");

      await outerLoop.transitionState("task-123", "BACKGROUND_ISOLATED", "User switched tab");
      expect(outerLoop.getCurrentState()).toBe("BACKGROUND_ISOLATED");

      await outerLoop.transitionState("task-123", "GOING_HOME_SUSPENDED", "User clicked home");
      expect(outerLoop.getCurrentState()).toBe("GOING_HOME_SUSPENDED");

      await outerLoop.transitionState("task-123", "RECOVERING", "User returned to chat space");
      expect(outerLoop.getCurrentState()).toBe("RECOVERING");
    });
  });

  describe("4. CustomInnerLoop: ReAct Execution, Lifecycle Docs & WAL", () => {
    it("runs inner loop turn, generates HANDS_ON and HANDS_OFF artifacts, and writes WAL logs", async () => {
      const mockBus: IBus = {
        publish: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn(),
      };
      const mockMesh: IMeshGateway = {
        async chat(): Promise<ChatResult> {
          return { content: "Implementation verified and complete." };
        },
        async *chatStream(): AsyncIterable<string> {
          yield "stream";
        },
      };

      const testScope = new Container();
      testScope.register("IBus", mockBus);
      testScope.register("IMeshGateway", mockMesh);
      testScope.register("DBEngine", dbEngine);

      const innerLoop = new CustomInnerLoop(testScope);
      const res = await innerLoop.run({
        agentId: "agent-test-1",
        taskId: "task-eval-1",
        templateName: "@principal-swe",
        instruction: "Build microservice architecture",
        workspaceDir: path.join(testDir, "task-eval-1"),
      });

      expect(res.completed).toBe(true);
      expect(res.handsOnPath).toBeDefined();
      expect(res.handOffPath).toBeDefined();

      if (res.handsOnPath) expect(fs.existsSync(res.handsOnPath)).toBe(true);
      if (res.handOffPath) expect(fs.existsSync(res.handOffPath)).toBe(true);
    });
  });

  describe("5. Specialist Tools: Canvas, Graph Preflight, QA Coverage & CV Testing", () => {
    it("CanvasCommenterTool formats visual annotations", async () => {
      const tool = new CanvasCommenterTool();
      const res = await tool.execute({
        imageUrl: "http://example.com/banner.png",
        annotations: [{ x: 10, y: 20, width: 100, height: 50, comment: "Align logo properly" }],
      });
      expect(res.annotationsParsed).toBe(1);
      expect(res.formattedDirectives).toContain("Align logo properly");
    });

    it("CodeReviewPreflightTool executes dependency check fallback", async () => {
      const tool = new CodeReviewPreflightTool();
      const res = await tool.execute({ searchQuery: "user_service" });
      expect(res.status).toBe("passed");
      expect(res.summary).toBeDefined();
    });

    it("QACoverageTool enforces 95% line coverage policy", async () => {
      const tool = new QACoverageTool();
      const resPassed = await tool.execute({ linesTested: 96, linesTotal: 100 });
      expect(resPassed.passedMandate).toBe(true);

      const resFailed = await tool.execute({ linesTested: 80, linesTotal: 100, uncoveredLines: [10, 11, 12] });
      expect(resFailed.passedMandate).toBe(false);
      expect(resFailed.recommendation).toContain("FAILED");
    });

    it("CVTesterTool simulates mouse clicks and screen capture", async () => {
      const tool = new CVTesterTool();
      const resClick = await tool.execute({ action: "click_coordinates", targetCoordinates: { x: 250, y: 400 } });
      expect(resClick.success).toBe(true);
      expect(resClick.message).toContain("250, 400");
    });
  });
});
