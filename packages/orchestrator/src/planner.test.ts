import { describe, it, expect, vi, beforeEach } from "vitest";
import { container } from "@yaaa/platform";
import type { IMeshGateway } from "@yaaa/interfaces";
import { Planner } from "./planner.js";

describe("Planner", () => {
  let mockGateway: IMeshGateway;
  let planner: Planner;

  beforeEach(() => {
    container.clear();
    mockGateway = {
      chat: vi.fn(),
      chatStream: vi.fn(),
    };
    container.register("IMeshGateway", mockGateway);
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
});
