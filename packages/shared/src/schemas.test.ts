import { describe, it, expect } from "vitest";
import {
  ArtifactRefSchema,
  SubtaskSchema,
  TaskPlanSchema,
  ToolCallSchema,
  AgentMessageSchema,
  ConversationMessageSchema,
  ConversationSchema,
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
      roles: ["FilesAgent"],
      capabilities: ["files"],
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
          roles: ["FilesAgent"],
          capabilities: ["files"],
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

  it("validates public conversations and durable conversation messages", () => {
    const conversation = {
      id: "chat-1",
      taskId: "mission-1",
      kind: "public",
      title: "Mission chat",
      participantIds: ["orchestrator"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(ConversationSchema.safeParse(conversation).success).toBe(true);
    expect(ConversationSchema.safeParse({ ...conversation, kind: "agent_thread" }).success).toBe(false);
    expect(ConversationMessageSchema.safeParse({
      id: "message-1",
      taskId: "mission-1",
      conversationId: "chat-1",
      authorId: "user-1",
      authorKind: "user",
      content: "Please help @sage-1",
      mentions: [{ handle: "@sage-1", recipientId: "agent-1", recipientKind: "agent" }],
      createdAt: "2026-01-01T00:00:01.000Z",
    }).success).toBe(true);
  });

  it("requires composite roles and capabilities in planner output", () => {
    const planWithModelLingo = {
      goal: "Test plan with LLM verification stage kind variance",
      subtasks: [
        {
          id: "st-1",
          title: "Write deliverable",
          roles: ["FilesAgent"],
          capabilities: ["files"],
          dependsOn: [],
          riskLevel: "low",
          successCriteria: "file created",
        },
      ],
      verification: {
        required: true,
        strategy: "Independent verification",
        stages: [
          {
            id: "stage-1",
            kind: "browser", // normalized to "visual"
            targetSubtaskIds: ["st-1"],
            capability: "web", // normalized to "browser"
            method: "Inspect web layout",
            available: true,
          },
          {
            id: "stage-2",
            kind: "files", // normalized to "artifact"
            targetSubtaskIds: ["st-1"],
            capability: "file", // normalized to "files"
            method: "Inspect file contents",
            available: true,
          },
        ],
        toolLimitations: [],
        decisionPolicy: "Must pass",
      },
    };

    const parsed = TaskPlanSchema.safeParse(planWithModelLingo);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.subtasks[0].capabilities).toEqual(["files"]);
      expect(parsed.data.verification?.stages[0].kind).toBe("visual");
      expect(parsed.data.verification?.stages[0].capability).toBe("browser");
      expect(parsed.data.verification?.stages[1].kind).toBe("artifact");
      expect(parsed.data.verification?.stages[1].capability).toBe("files");
    }
  });
});
