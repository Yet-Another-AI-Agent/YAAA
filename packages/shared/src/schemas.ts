import { z } from "zod";

export const ArtifactRefSchema = z.object({
  path: z.string(),
  mimeType: z.string(),
  description: z.string(),
});

export const SubtaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  capability: z.enum(["docs", "browser", "shell", "files", "integration", "verify"]),
  dependsOn: z.array(z.string()),
  riskLevel: z.enum(["low", "medium", "high"]),
  successCriteria: z.string(),
  state: z.enum(["pending", "running", "completed", "failed"]).default("pending"),
  assignedTo: z.string().optional(),
  result: z.string().optional(),
});

export const TaskPlanSchema = z.object({
  goal: z.string(),
  subtasks: z.array(SubtaskSchema),
});

export const ToolCallSchema = z.object({
  id: z.string(),
  capability: z.string(),
  method: z.string(),
  args: z.record(z.any()),
});

export const AgentMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("status"),
    from: z.string(),
    taskId: z.string(),
    state: z.enum(["working", "blocked", "done"]),
    note: z.string().optional(),
  }),
  z.object({
    kind: z.literal("result"),
    from: z.string(),
    taskId: z.string(),
    artifacts: z.array(ArtifactRefSchema),
    summary: z.string(),
  }),
  z.object({
    kind: z.literal("info_request"),
    from: z.string(),
    to: z.string(),
    question: z.string(),
  }),
  z.object({
    kind: z.literal("info_reply"),
    from: z.string(),
    to: z.string(),
    answer: z.string(),
  }),
  z.object({
    kind: z.literal("help_request"),
    from: z.string(),
    to: z.literal("orchestrator"),
    problem: z.string(),
  }),
  z.object({
    kind: z.literal("approval_request"),
    from: z.string(),
    to: z.literal("orchestrator"),
    action: ToolCallSchema,
  }),
  z.object({
    kind: z.literal("thought"),
    from: z.string(),
    content: z.string(),
  }),
]);
