import { describe, it, expect, vi, beforeEach } from "vitest";
import { container, PermissionEngine } from "@yaaa/platform";
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
        expect.objectContaining({ path: "agent-workspaces/test-agent/proofOfWork.md", mimeType: "text/markdown" }),
        expect.objectContaining({ path: "agent-workspaces/test-agent/handOff.md", mimeType: "text/markdown" }),
      ]),
    );
    expect(mockFilesProvider.writeFile).toHaveBeenCalledWith("test.txt", "hello");
    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-123.agent_message",
      expect.objectContaining({ kind: "result", summary: "Done test" }),
    );
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
    // proof/handoff documents for the recovered attempt.
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "agent-workspaces/test-agent/proofOfWork.md" }),
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

    expect(result.summary).toBe("Giving up and reporting.");
    expect(mockFilesProvider.readFile).toHaveBeenCalledTimes(3);
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
    } finally {
      delete process.env.YAAA_AGENT_INVOKE_TIMEOUT_MS;
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
});
