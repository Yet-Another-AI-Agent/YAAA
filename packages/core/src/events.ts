import type { TaskPlan, ArtifactRef, AgentRun, RuntimeAction, AgentMessage } from "@yaaa/shared";

/**
 * The structured event contract emitted by the core runtime.
 *
 * This is the single, typed surface that any frontend (Electron UI, CLI, tests)
 * consumes. Frontends must NOT parse stdout or bus internals — they subscribe to
 * this event stream via `RuntimeConfig.onEvent`.
 */
export type RuntimeEvent =
  | { type: "task-started"; taskId: string }
  | { type: "plan-updated"; plan: TaskPlan }
  | { type: "thought"; from: string; content: string }
  | { type: "tool-requested"; from: string; content: string; metadata?: Record<string, unknown> }
  | { type: "llm-context"; from: string; turn: number; model: string; messages: unknown[] }
  | { type: "llm-response"; from: string; turn: number; model: string; content: string }
  | { type: "action"; action: RuntimeAction }
  | { type: "agent-status"; agent: AgentRun }
  | { type: "status"; from: string; note: string }
  | { type: "queue-accepted"; messageId: string; from: string; content: string }
  | { type: "result"; from: string; summary: string; artifacts: ArtifactRef[]; incomplete?: boolean }
  | { type: "chat-message"; message: Extract<AgentMessage, { kind: "help_request" | "info_request" | "info_reply" }> }
  | { type: "complete"; result: TaskRunResult }
  | { type: "topic-updated"; taskId: string; topic: string };

export interface TaskRunResult {
  success: boolean;
  summary: string;
  plan: TaskPlan | null;
}

/**
 * Pure mapper from an internal message-bus (topic, payload) pair to a typed
 * {@link RuntimeEvent}. Returns `null` for topics that carry no
 * frontend-facing event. Kept pure (no I/O, no container access) so it can be
 * unit-tested without native dependencies.
 */
export function mapBusEvent(
  taskId: string,
  topic: string,
  msg: any,
): RuntimeEvent | null {
  const base = `task.${taskId}`;

  if (topic === `${base}.plan_updated`) {
    return { type: "plan-updated", plan: msg as TaskPlan };
  }

  if (topic === `${base}.agent_message`) {
    if (msg && msg.kind === "result") {
      return {
        type: "result",
        from: msg.from,
        summary: msg.summary,
        artifacts: msg.artifacts ?? [],
        ...(msg.incomplete ? { incomplete: true } : {}),
      };
    }
    if (msg && (msg.kind === "help_request" || msg.kind === "info_request" || msg.kind === "info_reply")) {
      return { type: "chat-message", message: msg };
    }
    return null;
  }

  if (topic === `${base}.started`) {
    return { type: "status", from: msg?.from ?? "system", note: msg?.note ?? "" };
  }

  if (topic === `${base}.completed`) {
    return {
      type: "status",
      from: msg?.from ?? "orchestrator",
      note: msg?.note ?? "",
    };
  }

  if (topic.startsWith(`${base}.agent.`) && topic.endsWith(".thought")) {
    const from =
      topic.split(".").find((p) => p.includes("agent-")) ?? msg?.from ?? "agent";
    return { type: "thought", from, content: msg?.content ?? "" };
  }

  if (topic.startsWith(`${base}.agent.`) && topic.endsWith(".tool_requested")) {
    const from =
      topic.split(".").find((p) => p.includes("agent-")) ?? msg?.from ?? "agent";
    const metadata = msg?.metadata && typeof msg.metadata === "object" ? msg.metadata : undefined;
    return {
      type: "tool-requested",
      from,
      content: msg?.content ?? "",
      ...(metadata ? { metadata } : {}),
    };
  }

  if (topic.startsWith(`${base}.agent.`) && topic.endsWith(".llm_context")) {
    const from = topic.split(".").find((p) => p.includes("agent-")) ?? msg?.from ?? "agent";
    return {
      type: "llm-context",
      from,
      turn: Number(msg?.turn ?? 0),
      model: String(msg?.model ?? "unknown"),
      messages: Array.isArray(msg?.messages) ? msg.messages : [],
    };
  }

  if (topic.startsWith(`${base}.agent.`) && topic.endsWith(".llm_response")) {
    const from = topic.split(".").find((p) => p.includes("agent-")) ?? msg?.from ?? "agent";
    return {
      type: "llm-response",
      from,
      turn: Number(msg?.turn ?? 0),
      model: String(msg?.model ?? "unknown"),
      content: String(msg?.content ?? ""),
    };
  }

  if (topic.startsWith(`${base}.agent.`) && /\.action_(requested|started|approved|denied|completed|failed)$/.test(topic)) {
    const status = topic.endsWith(".action_started") ? "started"
      : topic.endsWith(".action_approved") ? "approved"
        : topic.endsWith(".action_denied") ? "denied"
          : topic.endsWith(".action_completed") ? "completed"
            : topic.endsWith(".action_failed") ? "failed" : "requested";
    return {
      type: "action",
      action: {
        id: msg?.actionId,
        taskId,
        agentId: msg?.agentId ?? "agent",
        capability: msg?.capability ?? "unknown",
        method: msg?.method ?? "unknown",
        args: msg?.args ?? {},
        status,
        timestamp: msg?.timestamp ?? new Date().toISOString(),
        ...("result" in (msg ?? {}) ? { result: msg.result } : {}),
        ...(typeof msg?.error === "string" ? { error: msg.error } : {}),
      },
    };
  }

  if (topic.startsWith(`${base}.agent.`) && topic.endsWith(".lifecycle")) {
    return { type: "agent-status", agent: msg as AgentRun };
  }

  return null;
}
