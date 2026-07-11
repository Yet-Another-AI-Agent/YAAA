import { describe, it, expect, vi, beforeEach } from "vitest";
import { container, PermissionEngine } from "@yaaa/platform";
import type { IMeshGateway, IBus } from "@yaaa/interfaces";
import { InnerLoop } from "./inner-loop.js";

describe("InnerLoop Worker Loop", () => {
  let mockGateway: IMeshGateway;
  let mockBus: IBus;
  let permissions: PermissionEngine;
  let mockFilesProvider: any;
  let innerLoop: InnerLoop;

  beforeEach(() => {
    container.clear();

    mockGateway = {
      chat: vi.fn(),
      chatStream: vi.fn(),
    };

    mockBus = {
      publish: vi.fn(),
      subscribe: vi.fn(),
    };

    permissions = new PermissionEngine();

    mockFilesProvider = {
      writeFile: vi.fn().mockResolvedValue("written"),
    };

    container.register("IMeshGateway", mockGateway);
    container.register("IBus", mockBus);
    container.register("PermissionEngine", permissions);
    container.register("capability:files", mockFilesProvider);

    innerLoop = new InnerLoop();
  });

  it("should run the loop and return final result successfully", async () => {
    // Turn 1: Model outputs a tool call
    // Turn 2: Model outputs final result
    let chatCount = 0;
    (mockGateway.chat as any).mockImplementation(async (messages: any[]) => {
      chatCount++;
      if (chatCount === 1) {
        return `\`\`\`json
{
  "call": {
    "capability": "files",
    "method": "writeFile",
    "args": {
      "path": "test.txt",
      "content": "hello"
    }
  }
}
\`\`\``;
      }
      return `\`\`\`json
{
  "result": {
    "artifacts": [{ "path": "test.txt", "mimeType": "text/plain", "description": "test" }],
    "summary": "Done test"
  }
}
\`\`\``;
    });

    const result = await innerLoop.run({
      agentId: "test-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "write hello to test.txt",
    });

    expect(result.summary).toBe("Done test");
    expect(mockFilesProvider.writeFile).toHaveBeenCalledWith("test.txt", "hello");
    expect(mockBus.publish).toHaveBeenCalledWith("task.task-123.agent_message", expect.objectContaining({
      kind: "result",
      summary: "Done test",
    }));
  });

  it("should fail if maximum turns is exceeded", async () => {
    // Always returns a tool call to loop infinitely
    (mockGateway.chat as any).mockResolvedValue(`\`\`\`json
{
  "call": {
    "capability": "files",
    "method": "writeFile",
    "args": { "path": "t.txt", "content": "1" }
  }
}
\`\`\``);

    await expect(
      innerLoop.run({
        agentId: "test-agent",
        taskId: "task-123",
        templateName: "FilesAgent",
        instruction: "loop",
        maxTurns: 2,
      })
    ).rejects.toThrow("exceeded max turns of 2");
  });

  it("should validate and return verification status for VerifierAgent", async () => {
    (mockGateway.chat as any).mockResolvedValue(`\`\`\`json
{
  "verification": {
    "status": "passed",
    "reason": "Perfect"
  }
}
\`\`\``);

    const result = await innerLoop.run({
      agentId: "test-verifier",
      taskId: "task-123",
      templateName: "VerifierAgent",
      instruction: "verify file",
    });

    expect(result.status).toBe("passed");
    expect(result.reason).toBe("Perfect");
  });

  it("should handle invalid JSON block and continue", async () => {
    let callCount = 0;
    (mockGateway.chat as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return "{ invalid json }";
      }
      return `\`\`\`json
{
  "result": {
    "artifacts": [],
    "summary": "Recovered from bad JSON"
  }
}
\`\`\``;
    });

    const result = await innerLoop.run({
      agentId: "test-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "test error handling",
    });

    expect(result.summary).toBe("Recovered from bad JSON");
    expect(callCount).toBe(2);
  });

  it("should handle output missing a JSON block and continue", async () => {
    let callCount = 0;
    (mockGateway.chat as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return "This is prose response without JSON";
      }
      return `\`\`\`json
{
  "result": {
    "artifacts": [],
    "summary": "Recovered from prose"
  }
}
\`\`\``;
    });

    const result = await innerLoop.run({
      agentId: "test-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "test prose response",
    });

    expect(result.summary).toBe("Recovered from prose");
    expect(callCount).toBe(2);
  });

  it("should handle tool execution failure and continue", async () => {
    let callCount = 0;
    (mockGateway.chat as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return `\`\`\`json
{
  "call": {
    "capability": "files",
    "method": "writeFile",
    "args": { "path": "fail.txt", "content": "hello" }
  }
}
\`\`\``;
      }
      return `\`\`\`json
{
  "result": {
    "artifacts": [],
    "summary": "Recovered from tool failure"
  }
}
\`\`\``;
    });

    mockFilesProvider.writeFile.mockRejectedValue(new Error("Disk Full"));

    const result = await innerLoop.run({
      agentId: "test-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "test tool failure",
    });

    expect(result.summary).toBe("Recovered from tool failure");
    expect(callCount).toBe(2);
  });

  it("compacts bulky old tool results out of later prompts on a long run", async () => {
    let turn = 0;
    (mockGateway.chat as any).mockImplementation(async () => {
      turn++;
      if (turn < 6) {
        return `\`\`\`json
{ "call": { "capability": "files", "method": "writeFile", "args": { "path": "f.txt", "content": "x" } } }
\`\`\``;
      }
      return `\`\`\`json
{ "result": { "artifacts": [], "summary": "done" } }
\`\`\``;
    });
    // Each tool result is large, so old ones must be elided from later prompts.
    mockFilesProvider.writeFile.mockResolvedValue("y".repeat(1000));

    await innerLoop.run({
      agentId: "test-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "keep writing",
      maxTurns: 10,
    });

    const lastPrompt = (mockGateway.chat as any).mock.calls.at(-1)[0];
    const joined = lastPrompt.map((m: any) => m.content).join("\n");
    expect(joined).toContain("elided to save context");
    // The framing (system + brief) and most-recent turns are still present.
    expect(lastPrompt[0].role).toBe("system");
  });

  it("should throw error if template is not found in registry", async () => {
    await expect(
      innerLoop.run({
        agentId: "test-agent",
        taskId: "task-123",
        templateName: "NonExistentTemplate" as any,
        instruction: "test",
      })
    ).rejects.toThrow("Agent template NonExistentTemplate not found in registry.");
  });

  it("should handle calls to non-existent capability methods gracefully", async () => {
    let callCount = 0;
    (mockGateway.chat as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return `\`\`\`json
{
  "call": {
    "capability": "files",
    "method": "nonExistentMethod",
    "args": {}
  }
}
\`\`\``;
      }
      return `\`\`\`json
{
  "result": {
    "artifacts": [],
    "summary": "Recovered from bad method"
  }
}
\`\`\``;
    });

    const result = await innerLoop.run({
      agentId: "test-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "test non-existent method",
    });

    expect(result.summary).toBe("Recovered from bad method");
    expect(callCount).toBe(2);
  });

  it("rolls the older history into an LLM summary once the cleared prompt is large", async () => {
    // Large, never-elided assistant messages (compactMessages only elides bulky
    // *tool-result* user messages), so the tool-result-cleared prompt grows past
    // the ~24000-char summary threshold after a few turns.
    const padding = "context filler ".repeat(650); // ~9700 chars
    const toolCall =
      "```json\n" +
      '{ "call": { "capability": "files", "method": "writeFile", "args": { "path": "f.txt", "content": "x" } } }\n' +
      "```";
    const finalResult =
      "```json\n" +
      '{ "result": { "artifacts": [], "summary": "done long run" } }\n' +
      "```";

    let workerTurns = 0;
    const workerPrompts: any[][] = [];
    const utilityPrompts: any[][] = [];
    (mockGateway.chat as any).mockImplementation(async (messages: any[], options: any) => {
      if (options.modelRole === "utility") {
        utilityPrompts.push(messages);
        // No onReasoning must be forwarded to the summarization call.
        expect(options.onReasoning).toBeUndefined();
        return "COMPACT SUMMARY: wrote several files; work is mid-flight.";
      }
      workerTurns++;
      if (workerTurns >= 6) return finalResult;
      return `${padding}\n${toolCall}`;
    });
    // Large tool results too, though these are elided from later prompts.
    mockFilesProvider.writeFile.mockResolvedValue("y".repeat(4000));

    const result = await innerLoop.run({
      agentId: "test-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "keep writing lots of files",
      maxTurns: 10,
    });

    expect(result.summary).toBe("done long run");

    // (a) At least one summarization call was made with modelRole "utility".
    expect(utilityPrompts.length).toBeGreaterThanOrEqual(1);
    const utilityCalls = (mockGateway.chat as any).mock.calls.filter(
      (c: any[]) => c[1]?.modelRole === "utility",
    );
    expect(utilityCalls.length).toBeGreaterThanOrEqual(1);

    // Separate which prompts went to the main (worker) model.
    for (const c of (mockGateway.chat as any).mock.calls) {
      if (c[1]?.modelRole === "worker") workerPrompts.push(c[0]);
    }
    // (b) A later MAIN prompt carries the injected summary note.
    const someWorkerPromptHasSummary = workerPrompts.some((p) =>
      p.map((m: any) => m.content).join("\n").includes("Summary of earlier work"),
    );
    expect(someWorkerPromptHasSummary).toBe(true);
  });

  it("does NOT summarize on small runs (no utility-model call)", async () => {
    let callCount = 0;
    (mockGateway.chat as any).mockImplementation(async (_messages: any[], options: any) => {
      // Fail loudly if the cheap summarization tier ever fires on a tiny run.
      expect(options.modelRole).not.toBe("utility");
      callCount++;
      if (callCount === 1) {
        return `\`\`\`json
{ "call": { "capability": "files", "method": "writeFile", "args": { "path": "s.txt", "content": "hi" } } }
\`\`\``;
      }
      return `\`\`\`json
{ "result": { "artifacts": [], "summary": "small done" } }
\`\`\``;
    });

    const result = await innerLoop.run({
      agentId: "test-agent",
      taskId: "task-123",
      templateName: "FilesAgent",
      instruction: "small task",
      maxTurns: 5,
    });

    expect(result.summary).toBe("small done");
    const utilityCalls = (mockGateway.chat as any).mock.calls.filter(
      (c: any[]) => c[1]?.modelRole === "utility",
    );
    expect(utilityCalls.length).toBe(0);
  });
});
