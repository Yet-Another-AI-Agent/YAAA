import { describe, it, expect } from "vitest";
import {
  ArtifactRefSchema,
  SubtaskSchema,
  TaskPlanSchema,
  ToolCallSchema,
  AgentMessageSchema,
} from "./schemas.js";

describe("Shared schemas validation", () => {
  it("should validate ArtifactRef schema", () => {
    const valid = { path: "a.txt", mimeType: "text/plain", description: "desc" };
    expect(ArtifactRefSchema.safeParse(valid).success).toBe(true);

    const invalid = { path: 123, mimeType: "text/plain" };
    expect(ArtifactRefSchema.safeParse(invalid).success).toBe(false);
  });

  it("should validate Subtask schema", () => {
    const valid = {
      id: "st-1",
      title: "Write facts",
      capability: "files",
      dependsOn: [],
      riskLevel: "low",
      successCriteria: "done",
    };
    expect(SubtaskSchema.safeParse(valid).success).toBe(true);

    const invalid = {
      id: "st-1",
      capability: "invalid-capability", // wrong capability enum
    };
    expect(SubtaskSchema.safeParse(invalid).success).toBe(false);
  });

  it("should validate TaskPlan schema", () => {
    const valid = {
      goal: "Generate report",
      subtasks: [
        {
          id: "st-1",
          title: "Write facts",
          capability: "files",
          dependsOn: [],
          riskLevel: "low",
          successCriteria: "done",
        },
      ],
    };
    expect(TaskPlanSchema.safeParse(valid).success).toBe(true);
  });

  it("should validate ToolCall schema", () => {
    const valid = {
      id: "call-1",
      capability: "files",
      method: "writeFile",
      args: { path: "a.txt", content: "hello" },
    };
    expect(ToolCallSchema.safeParse(valid).success).toBe(true);
  });

  it("should validate AgentMessage schema discriminated union", () => {
    const validThought = {
      kind: "thought",
      from: "agent-1",
      content: "thinking...",
    };
    expect(AgentMessageSchema.safeParse(validThought).success).toBe(true);

    const validResult = {
      kind: "result",
      from: "agent-1",
      taskId: "task-1",
      artifacts: [{ path: "a.txt", mimeType: "text/plain", description: "desc" }],
      summary: "Completed task.",
    };
    expect(AgentMessageSchema.safeParse(validResult).success).toBe(true);

    const invalidMsg = {
      kind: "unknown_kind",
      from: "agent-1",
    };
    expect(AgentMessageSchema.safeParse(invalidMsg).success).toBe(false);
  });
});
