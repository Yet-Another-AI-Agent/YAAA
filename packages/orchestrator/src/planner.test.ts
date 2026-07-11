import { describe, it, expect, vi, beforeEach } from "vitest";
import { container } from "@yaaa/platform";
import type { IMeshGateway, IBus } from "@yaaa/interfaces";
import { Planner } from "./planner.js";

describe("Planner", () => {
  let mockGateway: IMeshGateway;
  let mockBus: IBus;
  let planner: Planner;

  beforeEach(() => {
    container.clear();
    mockGateway = {
      chat: vi.fn(),
      chatStream: vi.fn(),
    };
    mockBus = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockReturnValue(() => {}),
    };
    container.register("IMeshGateway", mockGateway);
    container.register("IBus", mockBus);
    planner = new Planner();
  });

  it("should successfully generate and validate a TaskPlan", async () => {
    const mockResponse = `\`\`\`json
{
  "goal": "Write report",
  "subtasks": [
    {
      "id": "task-1",
      "title": "Gather facts",
      "capability": "files",
      "dependsOn": [],
      "riskLevel": "low",
      "successCriteria": "facts.txt exists"
    }
  ]
}
\`\`\``;

    (mockGateway.chat as any).mockResolvedValue(mockResponse);

    const plan = await planner.plan("Write report");
    expect(plan.goal).toBe("Write report");
    expect(plan.subtasks.length).toBe(1);
    expect(plan.subtasks[0].id).toBe("task-1");
  });

  it("should run the auto-repair loop once if the first planning attempt fails validation", async () => {
    let chatCount = 0;
    (mockGateway.chat as any).mockImplementation(async () => {
      chatCount++;
      if (chatCount === 1) {
        return "invalid-json-output";
      }
      return `\`\`\`json
{
  "goal": "Write report",
  "subtasks": []
}
\`\`\``;
    });

    const plan = await planner.plan("Write report");
    expect(plan.goal).toBe("Write report");
    expect(plan.subtasks.length).toBe(0);
    expect(chatCount).toBe(2); // Retried once!
  });

  it("should propagate parsing failure if both attempts are invalid JSON", async () => {
    (mockGateway.chat as any).mockResolvedValue("completely-invalid-output");

    await expect(planner.plan("Write report")).rejects.toThrow(
      "No JSON code block found in model output."
    );
  });

  it("publishes planner reasoning as a thought when a taskId is given", async () => {
    (mockGateway.chat as any).mockImplementation(async (_msgs: any, opts: any) => {
      opts.onReasoning?.("decomposing the goal");
      return '```json\n{ "goal": "g", "subtasks": [] }\n```';
    });

    await planner.plan("Write report", "task-123");

    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-123.agent.planner.thought",
      expect.objectContaining({ kind: "thought", from: "planner", content: "decomposing the goal" })
    );
  });

  it("threads the user profile and prior-mission summary into the planning prompt", async () => {
    let sentMessages: any[] = [];
    (mockGateway.chat as any).mockImplementation(async (msgs: any[]) => {
      sentMessages = msgs;
      return '```json\n{ "goal": "g", "subtasks": [] }\n```';
    });

    await planner.plan("Write report", "task-1", {
      userProfile: { name: "Krishnaraj", profession: "Engineer" },
      priorSummary: "Earlier we scaffolded the repo.",
    });

    const userMsg = sentMessages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("Krishnaraj");
    expect(userMsg).toContain("Engineer");
    expect(userMsg).toContain("Earlier we scaffolded the repo.");
    expect(userMsg).toContain('Create a task plan for this goal: "Write report"');
  });

  it("does not publish reasoning when no taskId is given", async () => {
    (mockGateway.chat as any).mockImplementation(async (_msgs: any, opts: any) => {
      opts.onReasoning?.("thinking without a task");
      return '```json\n{ "goal": "g", "subtasks": [] }\n```';
    });

    await planner.plan("Write report");

    expect(mockBus.publish).not.toHaveBeenCalled();
  });
});
