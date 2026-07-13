import { describe, it, expect, vi, beforeEach } from "vitest";
import { container } from "@yaaa/platform";
import type { IStore, IMeshGateway } from "@yaaa/interfaces";
import type { TaskPlan } from "@yaaa/shared";
import { Synthesizer } from "./synthesizer.js";

describe("Synthesizer", () => {
  let mockGateway: IMeshGateway;
  let mockStore: IStore;
  let synthesizer: Synthesizer;

  beforeEach(() => {
    container.clear();

    mockGateway = {
      chat: vi.fn(),
      chatStream: vi.fn(),
    };

    mockStore = {
      initTaskDb: vi.fn(),
      saveMessage: vi.fn(),
      getMessages: vi.fn().mockResolvedValue([]),
      savePlan: vi.fn(),
      getPlan: vi.fn(),
      saveLedgerEntry: vi.fn(),
      getLedgerEntries: vi.fn().mockResolvedValue([]),
      saveAuditLog: vi.fn(),
      getAuditLogs: vi.fn(),
      saveAgent: vi.fn(),
      getAgents: vi.fn(),
    };

    container.register("IMeshGateway", mockGateway);
    container.register("IStore", mockStore);

    synthesizer = new Synthesizer();
  });

  it("should successfully synthesize and verify a completed task plan", async () => {
    const plan: TaskPlan = {
      goal: "Test plan",
      subtasks: [],
    };

    (mockGateway.chat as any).mockResolvedValue({ content: `\`\`\`json
{
  "passed": true,
  "summary": "Completed verified summary description."
}
\`\`\`` });

    const result = await synthesizer.synthesize("task-123", plan);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe("Completed verified summary description.");
  });

  it("should return passed: false if synthesizer model output parsing fails", async () => {
    const plan: TaskPlan = {
      goal: "Test plan",
      subtasks: [],
    };

    (mockGateway.chat as any).mockResolvedValue({ content: "completely-invalid-json-output" });

    const result = await synthesizer.synthesize("task-123", plan);
    expect(result.passed).toBe(false);
    expect(result.summary).toContain("Verification failed to compile");
  });
});
