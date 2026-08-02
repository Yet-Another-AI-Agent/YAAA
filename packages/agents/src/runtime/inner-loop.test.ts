import { describe, it, expect, vi, beforeEach } from "vitest";
import { container, PermissionEngine, orchestratorMailbox } from "@yaaa/platform";
import type { IBus } from "@yaaa/interfaces";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { InnerLoop } from "./inner-loop.js";

/**
 * A scripted chat model: each turn returns the next AIMessage in the script
 * (repeating the last one once exhausted). Tool-calling AIMessages route through
 * createReactAgent's ToolNode; a plain-content message ends the run. This lets us
 * exercise the real ReAct loop, real tools, and the real PermissionEngine without
 * a live model.
 */
class ScriptedChatModel extends BaseChatModel {
  private turn = 0;
  /** Messages the model was actually asked to generate against, per turn. */
  readonly seenTurns: BaseMessage[][] = [];
  constructor(private readonly script: AIMessage[]) {
    super({});
  }
  _llmType() {
    return "scripted-test-model";
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seenTurns.push(messages);
    const message = this.script[Math.min(this.turn, this.script.length - 1)];
    this.turn++;
    const text = typeof message.content === "string" ? message.content : "";
    return { generations: [{ text, message }] };
  }
  // createReactAgent binds tools to the model; the fake ignores them and scripts
  // its own tool calls, so it just returns itself.
  override bindTools() {
    return this;
  }
}

class HangingChatModel extends BaseChatModel {
  constructor() {
    super({});
  }
  readonly seenTurns: BaseMessage[][] = [];
  _llmType() {
    return "hanging-test-model";
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seenTurns.push(messages);
    return new Promise(() => {});
  }
  override bindTools() {
    return this;
  }
}

class ToolThenHangThenCheckpointChatModel extends BaseChatModel {
  private turn = 0;
  readonly seenTurns: BaseMessage[][] = [];
  constructor() {
    super({});
  }
  _llmType() {
    return "tool-hang-checkpoint-test-model";
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seenTurns.push(messages);
    this.turn++;
    if (this.turn === 1) {
      const message = toolCall("read_file", { path: "notes.md" });
      return { generations: [{ text: "", message }] };
    }
    if (this.turn === 2) {
      return new Promise(() => {});
    }
    const message = new AIMessage({
      content: "Status: partial. Completed reading notes.md. Next agent should continue with a fresh timer.",
    });
    return { generations: [{ text: String(message.content), message }] };
  }
  override bindTools() {
    return this;
  }
}

class FailingThenScriptedChatModel extends BaseChatModel {
  private turn = 0;
  readonly seenTurns: BaseMessage[][] = [];
  constructor(private readonly script: AIMessage[], private readonly error = new Error("temporary model failure")) {
    super({});
  }
  _llmType() {
    return "failing-then-scripted-test-model";
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seenTurns.push(messages);
    if (this.turn === 0) {
      this.turn++;
      throw this.error;
    }
    const message = this.script[Math.min(this.turn - 1, this.script.length - 1)];
    this.turn++;
    const text = typeof message.content === "string" ? message.content : "";
    return { generations: [{ text, message }] };
  }
  override bindTools() {
    return this;
  }
}

function toolCall(name: string, args: Record<string, unknown>, id = "call_1") {
  return new AIMessage({ content: "", tool_calls: [{ name, args, id, type: "tool_call" }] });
}

describe("InnerLoop Worker Loop (ReAct)", () => {
  let mockBus: IBus;
  let permissions: PermissionEngine;
  let mockFilesProvider: any;
  let scripted: ScriptedChatModel;
  let innerLoop: InnerLoop;

  function install(script: AIMessage[]) {
    scripted = new ScriptedChatModel(script);
    container.register("ChatModelFactory", () => scripted);
    innerLoop = new InnerLoop();
  }

  beforeEach(() => {
    container.clear();
    mockBus = { publish: vi.fn(), subscribe: vi.fn() } as any;
    permissions = new PermissionEngine();
    mockFilesProvider = {
      readFile: vi.fn().mockResolvedValue("file contents"),
      writeFile: vi.fn().mockResolvedValue(undefined),
      listFiles: vi.fn().mockResolvedValue([]),
      searchFiles: vi.fn().mockResolvedValue([]),
    };
    container.register("IBus", mockBus);
    container.register("PermissionEngine", permissions);
    container.register("capability:files", mockFilesProvider);
  });

  it("runs a tool then returns a summary, tracking the written file as an artifact", async () => {
    install([
      toolCall("write_file", { path: "test.txt", content: "hello" }),
      new AIMessage({ content: "Done test" }),
    ]);

    const result = await innerLoop.run({
      agentId: "test-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "write hello to test.txt",
    });

    expect(result.summary).toBe("Done test");
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        { path: "test.txt", mimeType: "text/plain", description: "File produced by FilesAgent." },
        expect.objectContaining({ path: "agent-workspaces/test-agent/handOff.md", mimeType: "text/markdown" }),
      ]),
    );
    expect(mockFilesProvider.writeFile).toHaveBeenCalledWith("test.txt", "hello");
    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-123.agent_message",
      expect.objectContaining({ kind: "result", summary: "Done test" }),
    );
  });

  it("returns a permission blocker when a required file operation is denied", async () => {
    install([
      toolCall("write_file", { path: "/tmp/yaaa-denied.txt", content: "must not escape the workspace" }),
      new AIMessage({ content: "I cannot create the required file because the write permission was denied." }),
    ]);

    const result = await innerLoop.run({
      agentId: "permission-blocked-agent",
      taskId: "task-permission-blocked",
      templateName: "FilesAgent",
      instruction: "Create the required file inside the assigned workspace.",
      executionContract: {
        requiredArtifacts: ["required.txt"],
        targetWorkspace: "task workspace",
        expectedNextActions: ["create required.txt"],
        dependencyGraph: [],
        preflight: { runOncePerAssignment: true, targetPaths: [] },
        completionSignals: ["required.txt exists"],
        noProgress: { correctionAfter: 1, stopAfter: 2 },
        actionQueue: { useWhen: [], maxActions: 2, maxDepth: 1, stopOnError: true },
        verificationSurface: "files",
      },
    });

    expect(result.permissionBlocked).toBe(true);
    expect(result.permissionBlockReasons?.join(" ")).toContain("Approval required");
    expect(mockFilesProvider.writeFile).not.toHaveBeenCalledWith("/tmp/yaaa-denied.txt", expect.anything());
    expect((mockBus.publish as any).mock.calls.some(([event]: [string]) => event.endsWith("action_denied"))).toBe(true);
  });

  it("rejects zero-byte file writes instead of recording a fake deliverable", async () => {
    install([
      toolCall("write_file", { path: "empty.pptx", content: "" }),
      new AIMessage({ content: "The producer was stopped because the deliverable would be empty." }),
    ]);

    const result = await innerLoop.run({
      agentId: "empty-artifact-agent",
      taskId: "task-empty-artifact",
      templateName: "FilesAgent",
      instruction: "Create the presentation artifact.",
    });

    expect(result.summary).toContain("producer was stopped");
    expect(mockFilesProvider.writeFile).not.toHaveBeenCalledWith("empty.pptx", "");
    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-empty-artifact.agent.empty-artifact-agent.action_failed",
      expect.objectContaining({ error: expect.stringContaining("EMPTY_ARTIFACT") }),
    );
  });

  it("returns bounded file evidence references with ranges and hashes", async () => {
    install([
      toolCall("read_file", { path: "game.js" }),
      new AIMessage({ content: "Inspected the file reference." }),
    ]);

    await innerLoop.run({
      agentId: "file-reference-agent",
      taskId: "task-file-reference",
      templateName: "FilesAgent",
      instruction: "Inspect game.js before editing it.",
      executionContract: {
        contextPolicy: {
          maxInputTokens: 3_000,
          maxDependencyChars: 1_000,
          maxHistoryTurns: 2,
          maxFileExcerptLines: 40,
          includeFullSkillDocs: false,
          allowOnDemandReads: true,
          allowedTools: ["read_file"],
        },
        requiredArtifacts: [],
        targetWorkspace: "workspace",
        expectedNextActions: ["inspect game.js"],
        dependencyGraph: [],
        preflight: { runOncePerAssignment: true, targetPaths: [] },
        completionSignals: ["reference recorded"],
        noProgress: { correctionAfter: 1, stopAfter: 2 },
        actionQueue: { useWhen: [], maxActions: 2, maxDepth: 1, stopOnError: true },
        verificationSurface: "files",
      },
    });

    const evidence = scripted.seenTurns.flat()
      .find((message) => message.getType() === "tool" && String(message.content).includes("sha256"));
    expect(evidence).toBeTruthy();
    expect(String(evidence?.content)).toContain("game.js");
    expect(String(evidence?.content)).toContain("startLine");
  });

  it("blocks same-agent full rewrites and requires targeted edits", async () => {
    install([
      toolCall("write_file", { path: "index.html", content: "first version" }, "write_1"),
      toolCall("write_file", { path: "index.html", content: "second version" }, "write_2"),
      new AIMessage({ content: "I will inspect the existing file before making another edit." }),
    ]);

    const result = await innerLoop.run({
      agentId: "rewrite-guard-agent",
      taskId: "task-rewrite-guard",
      templateName: "FilesAgent",
      instruction: "create index.html without destroying existing work",
    });

    expect(result.summary).toContain("inspect the existing file");
    expect(mockFilesProvider.writeFile.mock.calls.filter((call: [string, ...unknown[]]) => call[0] === "index.html")).toHaveLength(1);
    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-rewrite-guard.agent.rewrite-guard-agent.action_completed",
      expect.objectContaining({
        method: "writeFile",
        result: expect.objectContaining({ status: "unchanged" }),
      }),
    );
  });

  it("requires and records graph preflight before code-generation writes", async () => {
    install([
      toolCall("code_review_graph_preflight", { targetFiles: ["index.html", "script.js"], searchQuery: "Snake" }, "graph_1"),
      toolCall("write_file", { path: "index.html", content: "<!doctype html>" }, "write_1"),
      new AIMessage({ content: "Graph scope established and the file was created." }),
    ]);

    await innerLoop.run({
      agentId: "graph-preflight-agent",
      taskId: "task-graph-preflight",
      templateName: "FilesAgent",
      instruction: "Use code-generation-skill to create index.html and script.js.",
    });

    expect(mockFilesProvider.writeFile).toHaveBeenCalledWith("index.html", "<!doctype html>");
    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-graph-preflight.agent.graph-preflight-agent.action_completed",
      expect.objectContaining({ method: "preflightCheck" }),
    );
  });

  it("executes file_multi sequentially from index 0 with recursive batches and line operations", async () => {
    mockFilesProvider.readLines = vi.fn().mockResolvedValue({ content: "two", startLine: 10, endLine: 12, totalLines: 20 });
    mockFilesProvider.writeLines = vi.fn().mockResolvedValue(undefined);
    install([
      toolCall("file_multi", {
        actions: [
          { action: "read_file_lines", params: { path: "game.js", startLine: 10, endLine: 12 } },
          { action: "multi", actions: [{ action: "write_file_lines", params: { path: "game.js", startLine: 20, endLine: 21, content: "next" } }] },
        ],
      }),
      new AIMessage({ content: "Batch complete." }),
    ]);

    const result = await innerLoop.run({
      agentId: "file-multi-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "make the targeted code edits",
    });

    expect(result.summary).toBe("Batch complete.");
    expect(mockFilesProvider.readLines).toHaveBeenCalledWith("game.js", 10, 12);
    expect(mockFilesProvider.writeLines).toHaveBeenCalledWith("game.js", 20, 21, "next");
    expect(result.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ path: "game.js" })]));
  });

  it("accepts common file_multi aliases and directory operations", async () => {
    mockFilesProvider.listFiles = vi.fn().mockResolvedValue(["betta_presentation.js"]);
    mockFilesProvider.createDirectory = vi.fn().mockResolvedValue({ status: "created" });
    install([
      toolCall("file_multi", {
        actions: [
          { action: "list", params: { path: "." } },
          { action: "create_directory", params: { path: "images" } },
        ],
      }),
      new AIMessage({ content: "Workspace prepared." }),
    ]);

    const result = await innerLoop.run({
      agentId: "file-multi-alias-agent",
      taskId: "task-file-multi-alias",
      templateName: "DocumentAgent",
      instruction: "Prepare the image directory before generating the deck.",
    });

    expect(result.summary).toBe("Workspace prepared.");
    expect(mockFilesProvider.listFiles).toHaveBeenCalledWith(".");
    expect(mockFilesProvider.createDirectory).toHaveBeenCalledWith("images");
  });

  it("loads only the selected skill on demand when full skill docs are omitted from the brief", async () => {
    install([
      toolCall("read_skill", { skillId: "code-generation-skill" }),
      new AIMessage({ content: "Skill preflight complete." }),
    ]);

    const result = await innerLoop.run({
      agentId: "lazy-skill-agent",
      taskId: "task-lazy-skill",
      templateName: "FilesAgent",
      instruction: "Use the selected code-generation skill before working.",
      skillIds: ["code-generation-skill"],
      executionContract: {
        contextPolicy: {
          maxInputTokens: 3_000,
          maxDependencyChars: 1_000,
          maxHistoryTurns: 2,
          maxFileExcerptLines: 80,
          includeFullSkillDocs: false,
          allowOnDemandReads: true,
          allowedTools: ["read_skill"],
        },
        requiredArtifacts: [],
        targetWorkspace: "task working directory",
        expectedNextActions: ["read selected skill"],
        dependencyGraph: [],
        preflight: { runOncePerAssignment: true, targetPaths: [] },
        completionSignals: ["preflight complete"],
        noProgress: { correctionAfter: 1, stopAfter: 2 },
        actionQueue: { useWhen: [], maxActions: 4, maxDepth: 1, stopOnError: true },
        verificationSurface: "files",
      },
    });

    expect(result.summary).toBe("Skill preflight complete.");
    const skillResult = scripted.seenTurns
      .flat()
      .find((message) => message.getType() === "tool" && String(message.content).includes("Bounded Code Generation Skill"));
    expect(skillResult).toBeTruthy();
    const contextEvent = (mockBus.publish as any).mock.calls.find(
      ([event]: [string]) => event === "task.task-lazy-skill.agent.lazy-skill-agent.llm_context",
    )?.[1];
    // The allowlist removes the normal ~50k-character FilesAgent schema. The
    // completion/communication tools remain intentionally essential.
    expect(contextEvent?.toolSchemaChars).toBeLessThan(8000);
    expect(contextEvent?.contextBudgetExceeded).toBe(false);
  });

  it("enforces the provider-facing context budget even when the assignment is huge", async () => {
    install([new AIMessage({ content: "Finished without reading unrelated context." })]);

    await innerLoop.run({
      agentId: "bounded-input-agent",
      taskId: "task-bounded-input",
      templateName: "FilesAgent",
      instruction: "Implement the requested change.\n" + "unrelated transcript ".repeat(10_000),
      executionContract: {
        contextPolicy: {
          maxInputTokens: 3_000,
          maxDependencyChars: 500,
          maxHistoryTurns: 2,
          maxFileExcerptLines: 40,
          includeFullSkillDocs: false,
          allowOnDemandReads: true,
          allowedTools: ["read_file"],
        },
        requiredArtifacts: [],
        targetWorkspace: "task workspace",
        expectedNextActions: ["implement the targeted change"],
        dependencyGraph: [],
        preflight: { runOncePerAssignment: true, targetPaths: [] },
        completionSignals: ["agent reports completion"],
        noProgress: { correctionAfter: 1, stopAfter: 2 },
        actionQueue: { useWhen: [], maxActions: 2, maxDepth: 1, stopOnError: true },
        verificationSurface: "files",
      },
    });

    const contextEvent = (mockBus.publish as any).mock.calls.find(
      ([event]: [string]) => event === "task.task-bounded-input.agent.bounded-input-agent.llm_context",
    )?.[1];
    // The deliberately tiny tool allowlist keeps the message packet bounded;
    // telemetry separately exposes when tool declarations themselves consume
    // the remaining provider budget.
    expect(contextEvent?.contextChars).toBeLessThan(1_200);
    expect(contextEvent?.contextBudgetExceeded).toBe(true);
    expect(contextEvent?.omittedSections).toEqual(expect.arrayContaining(["older-tool-history", "unselected-skills"]));
    const sentChars = scripted.seenTurns[0].reduce((total, message) => total + String(message.content).length, 0);
    expect(sentChars).toBeLessThan(15_000);
    expect(scripted.seenTurns[0].every((message) => !String(message.content).includes("unrelated transcript ".repeat(100)))).toBe(true);
  });

  it("caps read_file_lines at the selected excerpt size and returns reference metadata", async () => {
    mockFilesProvider.readLines = vi.fn().mockResolvedValue({
      content: "line 10\nline 11",
      startLine: 10,
      endLine: 11,
      totalLines: 200,
    });
    install([
      toolCall("read_file_lines", { path: "game.js", startLine: 10, endLine: 100 }),
      new AIMessage({ content: "The bounded excerpt is enough." }),
    ]);

    await innerLoop.run({
      agentId: "bounded-lines-agent",
      taskId: "task-bounded-lines",
      templateName: "FilesAgent",
      instruction: "Inspect only the relevant lines of game.js.",
      executionContract: {
        contextPolicy: {
          maxInputTokens: 3_000,
          maxDependencyChars: 500,
          maxHistoryTurns: 2,
          maxFileExcerptLines: 2,
          includeFullSkillDocs: false,
          allowOnDemandReads: true,
          allowedTools: ["read_file_lines"],
        },
        requiredArtifacts: [],
        targetWorkspace: "task workspace",
        expectedNextActions: ["inspect the relevant lines"],
        dependencyGraph: [],
        preflight: { runOncePerAssignment: true, targetPaths: ["game.js"] },
        completionSignals: ["excerpt inspected"],
        noProgress: { correctionAfter: 1, stopAfter: 2 },
        actionQueue: { useWhen: [], maxActions: 2, maxDepth: 1, stopOnError: true },
        verificationSurface: "files",
      },
    });

    expect(mockFilesProvider.readLines).toHaveBeenCalledWith("game.js", 10, 11);
    const completed = (mockBus.publish as any).mock.calls.find(
      ([event]: [string]) => event === "task.task-bounded-lines.agent.bounded-lines-agent.action_completed",
    )?.[1];
    expect(completed?.result).toEqual(expect.objectContaining({
      path: "game.js",
      sha256: expect.any(String),
      endLine: 11,
      truncatedByContextPolicy: true,
    }));
  });

  it("compacts old tool results while preserving the live ReAct loop", async () => {
    install([
      toolCall("read_file", { path: "file-1.txt" }, "read_1"),
      toolCall("read_file", { path: "file-2.txt" }, "read_2"),
      toolCall("read_file", { path: "file-3.txt" }, "read_3"),
      toolCall("read_file", { path: "file-4.txt" }, "read_4"),
      toolCall("read_file", { path: "file-5.txt" }, "read_5"),
      new AIMessage({ content: "Completed after retaining only recent evidence." }),
    ]);

    const result = await innerLoop.run({
      agentId: "history-compaction-agent",
      taskId: "task-history-compaction",
      templateName: "FilesAgent",
      instruction: "Inspect the files and summarize the result.",
      executionContract: {
        contextPolicy: {
          maxInputTokens: 3_000,
          maxDependencyChars: 500,
          maxHistoryTurns: 1,
          maxFileExcerptLines: 40,
          includeFullSkillDocs: false,
          allowOnDemandReads: true,
          allowedTools: ["read_file"],
        },
        requiredArtifacts: [],
        targetWorkspace: "task workspace",
        expectedNextActions: ["inspect files"],
        dependencyGraph: [],
        preflight: { runOncePerAssignment: true, targetPaths: [] },
        completionSignals: ["summary returned"],
        noProgress: { correctionAfter: 10, stopAfter: 12 },
        actionQueue: { useWhen: [], maxActions: 6, maxDepth: 1, stopOnError: true },
        verificationSurface: "files",
      },
    });

    expect(result.summary).toContain("Completed after retaining only recent evidence.");
    expect(scripted.seenTurns.flat().some((message) => String(message.content).includes("[earlier tool result elided"))).toBe(true);
    const contextEvents = (mockBus.publish as any).mock.calls
      .filter(([event]: [string]) => event.endsWith(".llm_context"))
      .map(([, payload]: [string, any]) => payload);
    expect(contextEvents.some((event: any) => event.historyChars > 0)).toBe(true);
  });

  it("serializes multiple tool calls emitted in one model turn", async () => {
    let active = 0;
    let maximumActive = 0;
    mockFilesProvider.readFile.mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return "file contents";
    });
    install([
      new AIMessage({
        content: "",
        tool_calls: [
          { name: "read_file", args: { path: "a.txt" }, id: "call_a", type: "tool_call" },
          { name: "read_file", args: { path: "b.txt" }, id: "call_b", type: "tool_call" },
        ],
      }),
      new AIMessage({ content: "Verified both files." }),
    ]);

    const result = await innerLoop.run({
      agentId: "serialized-tools-agent",
      taskId: "task-serialized-tools",
      templateName: "FilesAgent",
      instruction: "Read both files and report the result.",
    });

    expect(result.summary).toBe("Verified both files.");
    expect(maximumActive).toBe(1);
    // The model emitted two calls in one scripted turn. The provider-facing
    // replay must collapse that history to one call/response pair rather than
    // forwarding a Gemini-invalid multi-function turn.
    const replayMessages = scripted.seenTurns[1] ?? [];
    const replayAi = replayMessages.find((message) => message.getType() === "ai") as AIMessage | undefined;
    expect(replayAi?.tool_calls?.length ?? 0).toBeLessThanOrEqual(1);
    expect(replayMessages.filter((message) => message.getType() === "tool").length).toBeLessThanOrEqual(1);
  });

  it("parses a verifier's structured result", async () => {
    install([new AIMessage({ content: JSON.stringify({ status: "passed", summary: "All sections present.", findings: [], evidence: ["report.md inspected"] }) })]);

    const result = await innerLoop.run({
      agentId: "test-verifier",
      taskId: "task-123",
      templateName: "VerifierAgent",
      instruction: "verify the output",
    });

    expect(result.status).toBe("passed");
    expect(result.reason).toContain("All sections present");
  });

  it("queues an agent question with its identity for the orchestrator event loop", async () => {
    install([
      toolCall("ask_orchestrator", { question: "Should I preserve the existing API or migrate it?" }),
      new AIMessage({ content: "I asked the orchestrator and will continue safely." }),
    ]);

    await innerLoop.run({
      agentId: "sub-agent-1",
      taskId: "task-queue-contract",
      templateName: "FilesAgent",
      instruction: "Inspect the API and ask for guidance if the compatibility decision is ambiguous.",
    });

    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-queue-contract.agent_message",
      expect.objectContaining({ kind: "help_request", from: "sub-agent-1", to: "orchestrator" }),
    );
    expect(orchestratorMailbox.drain("task-queue-contract")).toEqual([
      expect.objectContaining({ from: "agent", agentId: "sub-agent-1", content: "Should I preserve the existing API or migrate it?" }),
    ]);
    orchestratorMailbox.clear("task-queue-contract");
  });

  it("reads a structured failed verdict too", async () => {
    install([new AIMessage({ content: JSON.stringify({ status: "failed", summary: "Missing conclusion slide.", findings: ["missing slide"], evidence: [] }) })]);
    const result = await innerLoop.run({
      agentId: "v2",
      taskId: "task-123",
      templateName: "VerifierAgent",
      instruction: "verify",
    });
    expect(result.status).toBe("failed");
  });

  it("fails closed when verifier prose is not structured JSON", async () => {
    install([new AIMessage({ content: "Everything looks good and passed." })]);
    const result = await innerLoop.run({ agentId: "v3", taskId: "task-123", templateName: "VerifierAgent", instruction: "verify" });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("invalid structured output");
  });

  it("fails cleanly when the step budget is exhausted (no infinite loop)", async () => {
    // Model that never stops calling a tool → recursion limit → surfaced as a
    // max-turns failure the outer loop can retry.
    install([toolCall("write_file", { path: "t.txt", content: "1" })]);

    await expect(
      innerLoop.run({
        agentId: "test-agent",
        taskId: "task-123",
        templateName: "FilesAgent",
        instruction: "loop forever",
        maxTurns: 2,
      }),
    ).rejects.toThrow("exceeded max turns of 2");
  });

  it("fails closed when the model returns only a synthetic tool transcript", async () => {
    install([
      new AIMessage({
        content:
          '[Assistant called tool list_files with arguments {"path":"agent-workspaces/browser-agent"}](no text content)',
      }),
    ]);

    await expect(
      innerLoop.run({
        agentId: "tool-summary-agent",
        taskId: "task-123",
        templateName: "FilesAgent",
        instruction: "produce the requested deliverable",
      }),
    ).rejects.toThrow("produced no deliverable artifacts");
    expect(mockFilesProvider.writeFile).toHaveBeenCalledWith(
      "agent-workspaces/tool-summary-agent/handOff.md",
      expect.stringContaining("Status: FAILED"),
    );
    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-123.agent_message",
      expect.objectContaining({
        kind: "result",
        from: "tool-summary-agent",
        summary: expect.stringContaining("produced no deliverable artifacts"),
      }),
    );
  });

  it("completes with incomplete work evidence when inspection work produces no deliverable artifacts", async () => {
    install([
      toolCall("list_files", { path: "." }, "call_list"),
      new AIMessage({
        content:
          '[Assistant called tool list_files with arguments {"path":"."}](no text content)',
      }),
      new AIMessage({
        content:
          '[Assistant called tool list_files with arguments {"path":"."}](no text content)',
      }),
    ]);

    const result = await innerLoop.run({
      agentId: "inspection-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "produce the requested deliverable",
    });

    expect(result.summary).toContain("Subtask completed with produced artifacts");
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "agent-workspaces/inspection-agent/incompleteWork.md" }),
        expect.objectContaining({ path: "agent-workspaces/inspection-agent/handOff.md" }),
      ]),
    );
    expect(mockFilesProvider.writeFile).toHaveBeenCalledWith(
      "agent-workspaces/inspection-agent/incompleteWork.md",
      expect.stringContaining("files.listFiles (path: .): ok"),
    );
  });

  it("promotes an existing deliverable read by the agent when final text is synthetic", async () => {
    mockFilesProvider.readFile.mockResolvedValue("# Solar System Outline\n\nA High School Exploration Course");
    install([
      toolCall("read_file", { path: "solar_system_outline.md" }, "call_read_outline"),
      new AIMessage({
        content:
          '[Assistant called tool read_file with arguments {"path":"solar_system_outline.md"}](no text content)',
      }),
    ]);

    const result = await innerLoop.run({
      agentId: "reader-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "verify or continue the requested deliverable",
    });

    expect(result.summary).toContain("Subtask completed with produced artifacts");
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "solar_system_outline.md",
          description: expect.stringContaining("Existing deliverable inspected"),
        }),
      ]),
    );
  });

  it("completes from produced artifacts when the final text is only a synthetic tool transcript", async () => {
    install([
      toolCall("write_file", { path: "solar_system_outline.md", content: "# Outline" }),
      new AIMessage({
        content:
          '[Assistant called tool write_file with arguments {"path":"solar_system_outline.md"}](no text content)',
      }),
    ]);

    const result = await innerLoop.run({
      agentId: "artifact-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "produce the requested deliverable",
    });

    expect(result.summary).toContain("Subtask completed with produced artifacts");
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "solar_system_outline.md" }),
        expect.objectContaining({ path: "agent-workspaces/artifact-agent/handOff.md" }),
      ]),
    );
    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-123.agent_message",
      expect.objectContaining({
        kind: "result",
        from: "artifact-agent",
        summary: expect.stringContaining("solar_system_outline.md"),
      }),
    );
  });

  it("asks for one continuation when a synthetic tool transcript produced no artifacts", async () => {
    install([
      new AIMessage({
        content:
          '[Assistant called tool list_files with arguments {"path":"agent-workspaces"}](no text content)',
      }),
      toolCall("write_file", { path: "solar_system_outline.md", content: "# Outline" }, "call_after_nudge"),
      new AIMessage({ content: "Created and verified solar_system_outline.md." }),
    ]);

    const result = await innerLoop.run({
      agentId: "continue-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "produce the requested deliverable",
    });

    expect(result.summary).toContain("Created and verified");
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "solar_system_outline.md" }),
        expect.objectContaining({ path: "agent-workspaces/continue-agent/handOff.md" }),
      ]),
    );
    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-123.agent.continue-agent.thought",
      expect.objectContaining({
        content: expect.stringContaining("self-introspection"),
      }),
    );
  });

  it("self-introspects and recovers from a recoverable model failure", async () => {
    const recovering = new FailingThenScriptedChatModel([
      toolCall("write_file", { path: "recovered.md", content: "# Recovered" }, "call_recover"),
      new AIMessage({ content: "Recovered by changing approach and wrote recovered.md." }),
    ]);
    container.register("ChatModelFactory", () => recovering);
    innerLoop = new InnerLoop();

    const result = await innerLoop.run({
      agentId: "recover-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "produce the requested deliverable",
    });

    expect(result.summary).toContain("Recovered by changing approach");
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "recovered.md" }),
        expect.objectContaining({ path: "agent-workspaces/recover-agent/handOff.md" }),
      ]),
    );
    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-123.agent.recover-agent.thought",
      expect.objectContaining({
        content: expect.stringContaining("self-introspection"),
      }),
    );
  });

  it("returns a tool error to the model so it can recover, not crashing the run", async () => {
    mockFilesProvider.writeFile.mockRejectedValueOnce(new Error("Disk Full"));
    install([
      toolCall("write_file", { path: "fail.txt", content: "hello" }),
      new AIMessage({ content: "Recovered from tool failure" }),
    ]);

    const result = await innerLoop.run({
      agentId: "test-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "test tool failure",
    });

    expect(result.summary).toBe("Recovered from tool failure");
    // The failed write is NOT recorded as an artifact; the runtime still records
    // handoff documents for the recovered attempt.
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "agent-workspaces/test-agent/handOff.md" }),
      ]),
    );
    expect(result.artifacts.some((artifact: any) => artifact.path === "fail.txt")).toBe(false);
  });

  it("stops executing an identical tool call after the repeat cap so a failing tool can't thrash", async () => {
    // A model that keeps issuing the exact same read_file call, then finally
    // yields a summary. The provider must only be hit MAX_REPEATED_CALLS (3)
    // times; further identical calls are short-circuited with a directive.
    mockFilesProvider.readFile.mockResolvedValue("same contents every time");
    install([
      toolCall("read_file", { path: "loop.txt" }, "call_1"),
      toolCall("read_file", { path: "loop.txt" }, "call_2"),
      toolCall("read_file", { path: "loop.txt" }, "call_3"),
      toolCall("read_file", { path: "loop.txt" }, "call_4"),
      toolCall("read_file", { path: "loop.txt" }, "call_5"),
      new AIMessage({ content: "Giving up and reporting." }),
    ]);

    const result = await innerLoop.run({
      agentId: "loop-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "read the same file forever",
    });

    expect(result.summary).toContain("Agent stopped by supervisor");
    expect(mockFilesProvider.readFile).toHaveBeenCalledTimes(2);
  });

  it("never sends an empty text content block to the model (Bedrock rejects them)", async () => {
    // The assistant's tool-call turn carries content:"" and the tool result is
    // empty — both must be rewritten to non-empty before reaching the model.
    mockFilesProvider.readFile.mockResolvedValue("");
    install([
      toolCall("read_file", { path: "empty.txt" }, "call_1"),
      new AIMessage({ content: "Done." }),
    ]);

    await innerLoop.run({
      agentId: "sanitize-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "read the empty file",
    });

    // On the second turn the model sees [Human, AI(tool call), Tool(result)];
    // none of those message contents may be blank.
    const finalTurn = scripted.seenTurns[scripted.seenTurns.length - 1];
    const blank = finalTurn.filter(
      (m) => typeof m.content === "string" && m.content.trim() === "",
    );
    expect(blank).toHaveLength(0);
  });

  it("reports what a tool is doing (its salient argument) and that it completed", async () => {
    install([
      toolCall("read_file", { path: "notes/plan.md" }, "call_1"),
      new AIMessage({ content: "Read it." }),
    ]);

    await innerLoop.run({
      agentId: "verbose-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "read the plan",
    });

    const toolLogs = (mockBus.publish as any).mock.calls
      .filter((c: any[]) => String(c[0]).endsWith(".tool_requested"))
      .map((c: any[]) => c[1].content as string);

    // The request line names what it's acting on; a completion line follows.
    expect(toolLogs.some((line: string) => line.includes("path: notes/plan.md"))).toBe(true);
    expect(toolLogs.some((line: string) => line.startsWith("✓"))).toBe(true);
  });

  it("streams the model-provided progress key before executing a tool", async () => {
    install([
      toolCall("read_file", { path: "notes/plan.md", progress: "Checking the existing plan before making the next decision." }, "call-progress"),
      new AIMessage({ content: "Read it." }),
    ]);

    await innerLoop.run({
      agentId: "progress-agent",
      taskId: "task-progress",
      templateName: "FilesAgent",
      instruction: "read the plan",
    });

    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-progress.agent.progress-agent.tool_requested",
      expect.objectContaining({
        content: "Checking the existing plan before making the next decision.",
        metadata: expect.objectContaining({ progress: "Checking the existing plan before making the next decision." }),
      }),
    );
    expect(mockFilesProvider.readFile).toHaveBeenCalledWith("notes/plan.md");
  });

  it("times out when the first model call never returns", async () => {
    process.env.YAAA_AGENT_INVOKE_TIMEOUT_MS = "20";
    container.register("ChatModelFactory", () => new HangingChatModel());
    innerLoop = new InnerLoop();

    try {
      await expect(
        innerLoop.run({
          agentId: "hung-agent",
          taskId: "task-123",
          templateName: "FilesAgent",
          instruction: "do work",
        }),
      ).rejects.toThrow("Agent model invocation timed out");
      expect(mockBus.publish).toHaveBeenCalledWith(
        "task.task-123.agent.hung-agent.thought",
        expect.objectContaining({ content: expect.stringContaining("Waiting for FilesAgent model response") }),
      );
      expect(mockBus.publish).toHaveBeenCalledWith(
        "task.task-123.agent.hung-agent.tool_requested",
        expect.objectContaining({ content: expect.stringContaining("hung-agent: model.invoke") }),
      );
      expect(mockFilesProvider.writeFile).toHaveBeenCalledWith(
        "agent-workspaces/hung-agent/handOff.md",
        expect.stringContaining("Tool progress observed before failure: No"),
      );
      expect(mockBus.publish).toHaveBeenCalledWith(
        "task.task-123.agent_message",
        expect.objectContaining({
          kind: "result",
          from: "hung-agent",
          artifacts: expect.arrayContaining([
            expect.objectContaining({ path: "agent-workspaces/hung-agent/handOff.md" }),
          ]),
        }),
      );
    } finally {
      delete process.env.YAAA_AGENT_INVOKE_TIMEOUT_MS;
    }
  });

  it("asks for a checkpoint after timing out with tool progress", async () => {
    process.env.YAAA_AGENT_INVOKE_TIMEOUT_MS = "20";
    process.env.YAAA_AGENT_CHECKPOINT_TIMEOUT_MS = "50";
    const model = new ToolThenHangThenCheckpointChatModel();
    container.register("ChatModelFactory", () => model);
    innerLoop = new InnerLoop();

    try {
      const result = await innerLoop.run({
        agentId: "checkpoint-agent",
        taskId: "task-123",
        templateName: "FilesAgent",
        instruction: "read notes and produce output",
      });

      expect(result.incomplete).toBe(true);
      expect(result.summary).toContain("Checkpoint");
      expect(result.summary).toContain("Completed reading notes.md");
      expect(mockFilesProvider.writeFile).toHaveBeenCalledWith(
        "agent-workspaces/checkpoint-agent/incompleteWork.md",
        expect.stringContaining("Agent Checkpoint"),
      );
      expect(mockFilesProvider.writeFile).toHaveBeenCalledWith(
        "agent-workspaces/checkpoint-agent/handOff.md",
        expect.stringContaining("- Status: INCOMPLETE"),
      );
      expect(mockBus.publish).toHaveBeenCalledWith(
        "task.task-123.agent.checkpoint-agent.thought",
        expect.objectContaining({ content: expect.stringContaining("Asking agent for a checkpoint") }),
      );
    } finally {
      delete process.env.YAAA_AGENT_INVOKE_TIMEOUT_MS;
      delete process.env.YAAA_AGENT_CHECKPOINT_TIMEOUT_MS;
    }
  });

  it("throws if the template is not found in the registry", async () => {
    install([new AIMessage({ content: "noop" })]);
    await expect(
      innerLoop.run({
        agentId: "test-agent",
        taskId: "task-123",
        templateName: "NonExistentTemplate",
        instruction: "test",
      }),
    ).rejects.toThrow("Agent template NonExistentTemplate not found in registry.");
  });

  it("injects loop guard warnings in preModelHook when tools loop or fail", async () => {
    const mockWebProvider = {
      search: vi.fn().mockResolvedValue([]),
    };
    container.register("capability:web", mockWebProvider);

    const responses = [
      toolCall("web_search", { query: "q1" }, "c1"),
      toolCall("web_search", { query: "q2" }, "c2"),
      toolCall("web_search", { query: "q3" }, "c3"),
      new AIMessage({
        content: "I will stop searching now.",
      })
    ];
    install(responses);

    const result = await innerLoop.run({
      agentId: "loop-guard-agent",
      taskId: "task-123",
      templateName: "ResearcherAgent",
      instruction: "Find information on something",
    });

    expect(result.summary).toContain("I will stop searching now.");
    // Verify that the thought topic was published for loop guard
    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-123.agent.loop-guard-agent.thought",
      expect.objectContaining({ content: expect.stringContaining("Course correction injected by YAAA") }),
    );

    // Verify that the last turn model input messages actually contain the system notice
    const lastTurnMessages = scripted.seenTurns[3];
    const hasNotice = lastTurnMessages.some(
      (m) => m.content.toString().includes("System Notice: The last 3 web searches returned no useful results")
    );
    expect(hasNotice).toBe(true);
  });

  it("does not warn merely because three web searches returned useful results", async () => {
    const mockWebProvider = {
      search: vi.fn().mockResolvedValue([{ title: "Useful result", url: "https://example.com" }]),
    };
    container.register("capability:web", mockWebProvider);
    install([
      toolCall("web_search", { query: "first" }, "s1"),
      toolCall("web_search", { query: "second" }, "s2"),
      toolCall("web_search", { query: "third" }, "s3"),
      new AIMessage({ content: "I found useful sources." }),
    ]);

    await innerLoop.run({
      agentId: "useful-search-agent",
      taskId: "task-123",
      templateName: "ResearcherAgent",
      instruction: "research the topic",
    });

    const notices = (mockBus.publish as any).mock.calls.filter(
      ([topic, payload]: [string, any]) => topic.endsWith(".thought") && payload?.content?.includes("last 3 web searches"),
    );
    expect(notices).toHaveLength(0);
  });

  it("stops repeated successful evidence instead of spending more model turns", async () => {
    mockFilesProvider.listFiles.mockResolvedValue(["index.html"]);
    install([
      toolCall("list_files", { path: "." }, "list_1"),
      toolCall("list_files", { path: "." }, "list_2"),
      toolCall("list_files", { path: "." }, "list_3"),
      new AIMessage({ content: "The workspace is ready." }),
    ]);

    await innerLoop.run({
      agentId: "no-progress-agent",
      taskId: "task-no-progress",
      templateName: "FilesAgent",
      instruction: "inspect the workspace and stop when the evidence is unchanged",
    });

    expect(scripted.seenTurns.length).toBeLessThanOrEqual(3);
    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-no-progress.agent.no-progress-agent.thought",
      expect.objectContaining({ content: expect.stringContaining("No progress detected") }),
    );
  });

  it("stops an identical file-tool contract failure instead of retrying forever", async () => {
    install([
      toolCall("file_multi", {
        actions: [{ action: "execute_shell_command", params: { command: "node generate_presentation.js" } }],
      }, "bad-1"),
      toolCall("file_multi", {
        actions: [{ action: "execute_shell_command", params: { command: "node generate_presentation.js" } }],
      }, "bad-2"),
      toolCall("file_multi", {
        actions: [{ action: "execute_shell_command", params: { command: "node generate_presentation.js" } }],
      }, "bad-3"),
    ]);

    const result = await innerLoop.run({
      agentId: "contract-loop-agent",
      taskId: "task-contract-loop",
      templateName: "DocumentAgent",
      instruction: "Run the existing presentation generator and produce the PPTX.",
    });

    expect(result.incomplete).toBe(true);
    expect(result.stopReason).toBe("no-progress");
    expect(result.summary).toContain("No progress budget exhausted");
    expect(scripted.seenTurns.length).toBeLessThanOrEqual(3);
    const failures = (mockBus.publish as any).mock.calls.filter(
      ([topic]: [string]) => topic === "task.task-contract-loop.agent.contract-loop-agent.action_failed",
    );
    expect(failures).toHaveLength(2);
  });

  it("groups different shell commands hidden inside file_multi as one contract failure", async () => {
    install([
      toolCall("file_multi", {
        actions: [{ action: "execute_command", params: { command: "python3 generate_pptx.py" } }],
      }, "bad-python"),
      toolCall("file_multi", {
        actions: [{ action: "execute_command", params: { command: "node create_pptx.js" } }],
      }, "bad-node"),
    ]);

    const result = await innerLoop.run({
      agentId: "contract-variant-agent",
      taskId: "task-contract-variant",
      templateName: "DocumentAgent",
      instruction: "Run the generator and produce the final presentation.",
    });

    expect(result.incomplete).toBe(true);
    expect(result.stopReason).toBe("no-progress");
    expect(scripted.seenTurns.length).toBeLessThanOrEqual(3);
  });

  it("does not call successful void writes failures", async () => {
    install([
      toolCall("write_file", { path: "one.txt", content: "1" }, "w1"),
      toolCall("write_file", { path: "two.txt", content: "2" }, "w2"),
      toolCall("write_file", { path: "three.txt", content: "3" }, "w3"),
      new AIMessage({ content: "All files written." }),
    ]);

    const result = await innerLoop.run({
      agentId: "write-guard-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "write three files",
    });

    expect(result.summary).toBe("All files written.");
    const notices = (mockBus.publish as any).mock.calls.filter(
      ([topic, payload]: [string, any]) => topic.endsWith(".thought") && payload?.content?.includes("repeatedly failed"),
    );
    expect(notices).toHaveLength(0);
  });
});
