import { z } from "zod";
import { Capability } from "./types.js";

export const ArtifactRefSchema = z.object({
  path: z.string(),
  mimeType: z.string(),
  description: z.string(),
});

export const ConversationSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  kind: z.enum(["public", "agent_thread"]),
  title: z.string().min(1),
  participantIds: z.array(z.string().min(1)),
  agentId: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().optional(),
}).superRefine((conversation, context) => {
  if (conversation.kind === "agent_thread" && !conversation.agentId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Agent threads require an agentId." });
  }
  if (conversation.kind === "public" && conversation.agentId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Public conversations cannot target one agent." });
  }
});

export const MentionSchema = z.object({
  handle: z.string().regex(/^@[a-z0-9][a-z0-9_-]*$/i),
  recipientId: z.string().min(1),
  recipientKind: z.enum(["orchestrator", "agent"]),
});

export const ConversationMessageSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  conversationId: z.string().min(1),
  authorId: z.string().min(1),
  authorKind: z.enum(["user", "orchestrator", "agent", "system"]),
  content: z.string().min(1),
  mentions: z.array(MentionSchema),
  createdAt: z.string().datetime(),
});

export const SubtaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().min(1).optional(),
  roles: z.array(z.string().min(1)).min(1),
  capabilities: z.array(z.nativeEnum(Capability)).min(1),
  dependsOn: z.array(z.string()),
  riskLevel: z.enum(["low", "medium", "high"]),
  successCriteria: z.string(),
  routingReason: z.string().min(1).optional(),
  model: z.string().optional(),
  modelReason: z.string().min(1).optional(),
  skills: z.array(z.string().min(1)).default([]),
  artifacts: z.array(ArtifactRefSchema).optional(),
  relevantArtifactPaths: z.array(z.string()).optional(),
  state: z.enum(["pending", "running", "completed", "failed"]).default("pending"),
  assignedTo: z.string().optional(),
  result: z.string().optional(),
});

export const TaskPlanSchema = z.object({
  goal: z.string(),
  subtasks: z.array(SubtaskSchema),
  executionContract: z.object({
    contextPolicy: z.object({
      maxInputTokens: z.number().int().positive(),
      maxDependencyChars: z.number().int().positive(),
      maxHistoryTurns: z.number().int().positive(),
      maxFileExcerptLines: z.number().int().positive(),
      includeFullSkillDocs: z.boolean(),
      allowOnDemandReads: z.boolean(),
      allowedTools: z.array(z.string()).default([]),
    }).optional(),
    requiredArtifacts: z.array(z.string()).default([]),
    targetWorkspace: z.string().default(""),
    expectedNextActions: z.array(z.string()).default([]),
    dependencyGraph: z.array(z.object({
      subtaskId: z.string(),
      dependsOn: z.array(z.string()).default([]),
    })).default([]),
    preflight: z.object({
      runOncePerAssignment: z.boolean(),
      targetPaths: z.array(z.string()).default([]),
    }),
    completionSignals: z.array(z.string()).min(1),
    noProgress: z.object({
      correctionAfter: z.number().int().positive(),
      stopAfter: z.number().int().positive(),
    }),
    actionQueue: z.object({
      useWhen: z.array(z.string()).default([]),
      maxActions: z.number().int().positive(),
      maxDepth: z.number().int().nonnegative(),
      stopOnError: z.boolean(),
    }),
    verificationSurface: z.enum(["files", "electron", "browser", "shell", "none"]),
  }).optional(),
  planningEstimate: z.object({
    message: z.string().min(1),
    considerations: z.array(z.string()).optional().default([]),
    expectedDurationMs: z.number().int().positive(),
  }).optional(),
  planningAnalysis: z.object({
    implementationGoal: z.string(),
    decompositionRationale: z.string(),
    modelPolicy: z.string(),
    stepReviews: z.array(z.object({
      subtaskId: z.string(),
      independentExecution: z.boolean(),
      dependencyReason: z.string(),
      selectedRole: z.string(),
      roleExpectation: z.string(),
      selectedModel: z.string(),
      modelReason: z.string(),
    })),
  }).optional(),
  methodology: z.string().optional(),
  executionGraph: z.array(z.object({
    stage: z.number().int().nonnegative(),
    mode: z.enum(["sequential", "parallel"]),
    subtaskIds: z.array(z.string()),
    rationale: z.string().optional(),
  })).optional(),
  corrections: z.array(z.object({
    id: z.string(),
    timestamp: z.string(),
    subtaskId: z.string(),
    agentId: z.string().optional(),
    action: z.string(),
    reason: z.string(),
    nextAgentTemplate: z.string().optional(),
    nextModel: z.string().optional(),
  })).optional(),
  verification: z.object({
    required: z.boolean(),
    strategy: z.string(),
    stages: z.array(z.object({
      id: z.string(),
      kind: z.preprocess((val) => {
        if (typeof val === "string") {
          const lower = val.toLowerCase().trim();
          if (lower === "browser" || lower === "visual" || lower === "gui" || lower === "ui") return "visual";
          if (lower === "files" || lower === "file" || lower === "code" || lower === "artifact") return "artifact";
          if (lower === "test" || lower === "shell" || lower === "automated" || lower === "cmd") return "automated";
          if (lower === "docs" || lower === "research" || lower === "doc") return "research";
          return lower;
        }
        return val;
      }, z.enum(["artifact", "automated", "visual", "research"])),
      targetSubtaskIds: z.array(z.string()),
      capability: z.preprocess((val) => {
        if (typeof val === "string") {
          const lower = val.toLowerCase().trim();
          if (lower === "file") return "files";
          if (lower === "web") return "browser";
          if (lower === "terminal" || lower === "bash" || lower === "cmd") return "shell";
          return lower;
        }
        return val;
      }, z.nativeEnum(Capability)),
      method: z.string(),
      available: z.boolean(),
      limitation: z.string().optional(),
      fallback: z.string().optional(),
    })),
    toolLimitations: z.array(z.string()),
    decisionPolicy: z.string(),
  }).optional(),
  verificationFindings: z.array(z.object({
    id: z.string(),
    timestamp: z.string(),
    subtaskId: z.string(),
    agentId: z.string().optional(),
    status: z.enum(["open", "resolved", "accepted"]),
    summary: z.string(),
    findings: z.array(z.string()),
    evidence: z.array(z.string()),
    limitations: z.array(z.string()),
    resolution: z.string().optional(),
  })).optional(),
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

export const ORCHESTRATOR_MD_HEADERS = {
  TITLE: "# Task Orchestration Ledger",
  PLAN: "## Strategy",
  EXECUTION: "## Execution Ledger",
  STEP: "### Step",
  STRATEGY: "* **Strategy**:",
  FACTS: "* **Facts Learned**:",
  ASSUMPTIONS: "* **Assumptions Made**:",
};
