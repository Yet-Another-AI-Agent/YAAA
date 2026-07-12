import { describe, it, expect, vi, beforeEach } from "vitest";
import { container } from "@yaaa/platform";
import type { IMeshGateway, IBus } from "@yaaa/interfaces";
import { Planner, getRequestedAgentCount } from "./planner.js";

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

    (mockGateway.chat as any).mockResolvedValue({ content: mockResponse });

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
        return { content: "invalid-json-output" };
      }
      return { content: `\`\`\`json
{
  "goal": "Write report",
  "subtasks": []
}
\`\`\`` };
    });

    const plan = await planner.plan("Write report");
    expect(plan.goal).toBe("Write report");
    expect(plan.subtasks.length).toBe(0);
    expect(chatCount).toBe(2); // Retried once!
  });

  it("should propagate parsing failure if both attempts are invalid JSON", async () => {
    (mockGateway.chat as any).mockResolvedValue({ content: "completely-invalid-output" });

    await expect(planner.plan("Write report")).rejects.toThrow(
      "No JSON code block found in model output."
    );
  });

  it("publishes planner reasoning as a thought when a taskId is given", async () => {
    (mockGateway.chat as any).mockImplementation(async (_msgs: any, opts: any) => {
      opts.onReasoning?.("decomposing the goal");
      return { content: '```json\n{ "goal": "g", "subtasks": [] }\n```' };
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
      return { content: '```json\n{ "goal": "g", "subtasks": [] }\n```' };
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
      return { content: '```json\n{ "goal": "g", "subtasks": [] }\n```' };
    });

    await planner.plan("Write report");

    expect(mockBus.publish).not.toHaveBeenCalled();
  });

  it("recognizes explicit numeric and word-form agent counts", () => {
    expect(getRequestedAgentCount("spin 2 agents to code and test")).toBe(2);
    expect(getRequestedAgentCount("use two collaborating agents")).toBe(2);
    expect(getRequestedAgentCount("build and test this")).toBeNull();
  });

  it("retries a plan that would spawn more agents than explicitly requested", async () => {
    const makePlan = (count: number) => ({
      content: `\`\`\`json\n${JSON.stringify({
        goal: "Code and test",
        subtasks: Array.from({ length: count }, (_, index) => ({
          id: `subtask-${index + 1}`,
          title: index === 0 ? "Python developer" : "Python tester",
          capability: index === 0 ? "files" : "verify",
          dependsOn: index === 0 ? [] : ["subtask-1"],
          riskLevel: "low",
          successCriteria: "Role assignment completed",
        })),
      })}\n\`\`\``,
    });
    (mockGateway.chat as any)
      .mockResolvedValueOnce(makePlan(6))
      .mockResolvedValueOnce(makePlan(2));

    const plan = await planner.plan(
      "spin 2 agents and one to write Python code and another to test",
    );

    expect(plan.subtasks).toHaveLength(2);
    expect(mockGateway.chat).toHaveBeenCalledTimes(2);
    const retryMessages = (mockGateway.chat as any).mock.calls[1][0];
    expect(retryMessages.at(-1).content).toContain(
      "Each subtask spawns one agent",
    );
  });
});
