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
  constructor(private readonly script: AIMessage[]) {
    super({});
  }
  _llmType() {
    return "scripted-test-model";
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
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
    expect(result.artifacts).toEqual([
      { path: "test.txt", mimeType: "text/plain", description: "File produced by FilesAgent." },
    ]);
    expect(mockFilesProvider.writeFile).toHaveBeenCalledWith("test.txt", "hello");
    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-123.agent_message",
      expect.objectContaining({ kind: "result", summary: "Done test" }),
    );
  });

  it("parses a verifier's VERDICT line into a structured verdict", async () => {
    install([new AIMessage({ content: "All sections present.\nVERDICT: PASSED" })]);

    const result = await innerLoop.run({
      agentId: "test-verifier",
      taskId: "task-123",
      templateName: "VerifierAgent",
      instruction: "verify the output",
    });

    expect(result.status).toBe("passed");
    expect(result.reason).toContain("VERDICT: PASSED");
  });

  it("reads a FAILED verdict too", async () => {
    install([new AIMessage({ content: "Missing conclusion slide.\nVERDICT: FAILED" })]);
    const result = await innerLoop.run({
      agentId: "v2",
      taskId: "task-123",
      templateName: "VerifierAgent",
      instruction: "verify",
    });
    expect(result.status).toBe("failed");
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
    mockFilesProvider.writeFile.mockRejectedValue(new Error("Disk Full"));
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
    // The failed write is NOT recorded as an artifact.
    expect(result.artifacts).toEqual([]);
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
