import type { IMeshGateway, ChatMessage } from "@yaaa/interfaces";
import { container, type Container } from "@yaaa/platform";

export interface MessageRoutingContext {
  missionGoal: string;
  userMessage: string;
  activeAgents: Array<{ id: string; handle?: string; role?: string; assignment?: string }>;
}

export interface MessageRoutingDecision {
  /** Agent ids that should receive the message. An empty list means no worker needs it. */
  recipientIds: string[];
  /** A direct answer for an agent question, or an optional user-facing answer. */
  reply?: string;
  /** A focused instruction for selected workers, never the whole transcript. */
  instruction?: string;
  reason: string;
}

/** What the master observes about a worker result or checkpoint. */
export interface SupervisorContext {
  missionGoal: string;
  subtaskTitle: string;
  successCriteria: string;
  /** The worker's own summary/checkpoint (status, work done, remaining work). */
  checkpointSummary: string;
  artifacts: Array<{ path: string; description?: string }>;
  /** How many continuations this subtask has already burned. */
  continuations: number;
  maxContinuations: number;
}

export type SupervisorAction = "continue" | "redirect" | "accept" | "fail";

/**
 * The master's decision after reading a worker's progress/result:
 * - continue: on track, just needs more time — renew with a fresh timer.
 * - redirect: off track — renew but hand it the corrected `handsOn`.
 * - accept: the deliverable already meets the success criteria — mark it done.
 * - fail: no viable path — stop burning continuations and fail the subtask.
 */
export interface SupervisorDecision {
  action: SupervisorAction;
  /** New assignment text, required (and only used) when action === "redirect". */
  handsOn?: string;
  /** Optional adaptive role for the next continuation agent. */
  nextAgentTemplate?: string;
  /** Optional adaptive model id for the next continuation agent. */
  nextModel?: string;
  /** Optional follow-up subtasks discovered during verification or execution. */
  newSubtasks?: Array<{
    id: string;
    title: string;
    roles: string[];
    capabilities: string[];
    dependsOn: string[];
    riskLevel: string;
    successCriteria: string;
    state: string;
  }>;
  /** Micro-steps discovered while inspecting the current subtask. */
  newSubSubtasks?: Array<{
    parentSubtaskId?: string;
    id?: string;
    title: string;
    result?: string;
  }>;
  /** Existing artifact paths that are the primary user-facing deliverables. */
  relevantArtifactPaths?: string[];
  reason: string;
}

function logSupervisor(taskId: string, message: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[YAAA:Supervisor:${taskId}] ${message}${suffix}`);
}

export class SupervisorAssessor {
  private gateway: IMeshGateway | null;

  constructor(scope: Container = container) {
    try {
      this.gateway = scope.resolve<IMeshGateway>("IMeshGateway");
    } catch {
      this.gateway = null;
    }
  }

  /**
   * Decide what a message means before it reaches a worker. This is deliberately
   * a small routing call: it receives agent metadata, not files or the growing
   * worker transcript, so a user follow-up cannot inflate every active context.
   */
  async routeMessage(taskId: string, ctx: MessageRoutingContext): Promise<MessageRoutingDecision> {
    const active = ctx.activeAgents;
    const mentioned = active.filter((agent) => {
      const handle = (agent.handle ?? agent.id).replace(/^@/, "").toLowerCase();
      return ctx.userMessage.toLowerCase().includes(`@${handle}`) || ctx.userMessage.toLowerCase().includes(handle);
    });
    if (!this.gateway) {
      const recipients = mentioned.length > 0 ? mentioned : active;
      return {
        recipientIds: recipients.map((agent) => agent.id),
        instruction: ctx.userMessage,
        reason: mentioned.length > 0 ? "Explicit agent mention." : "No supervisor model; preserving the legacy active-worker route.",
      };
    }

    const agentLines = active.length
      ? active.map((agent) => `- ${agent.id} (${agent.handle ?? agent.role ?? "worker"}): ${agent.assignment ?? "active"}`).join("\n")
      : "- No active workers";
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `You are YAAA's orchestrator. Route the new message after thinking about the mission and active assignments. Do not send acknowledgements. Select only workers whose assignment is materially affected. If the message is a question from a worker, answer it directly in reply; do not leave reply empty and do not invent a generic fallback. You cannot mutate a live worker's permissions or tool list in this routing call: never claim that a tool, permission, model, or capability was added or updated. If a required capability is missing, state that fact and recommend a bounded reassignment or stop. Return ONLY JSON: {"recipientIds":["known-id"],"reply":"concise LLM-generated answer when the sender is a worker","instruction":"optional focused instruction","reason":"concise reason"}. Never invent ids.`,
      },
      {
        role: "user",
        content: `Mission: ${ctx.missionGoal}\n\nActive workers:\n${agentLines}\n\nNew message:\n${ctx.userMessage}`,
      },
    ];
    try {
      const result = await this.gateway.chat(messages, { modelRole: "utility", temperature: 0.1, jsonMode: true });
      const match = result.content.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No routing JSON returned");
      const raw = JSON.parse(match[0]);
      const known = new Set(active.map((agent) => agent.id));
      const recipientIds = Array.isArray(raw.recipientIds)
        ? raw.recipientIds.filter((id: unknown): id is string => typeof id === "string" && known.has(id))
        : [];
      return {
        recipientIds,
        reply: typeof raw.reply === "string" ? raw.reply.trim() || undefined : undefined,
        instruction: typeof raw.instruction === "string" ? raw.instruction.trim() || undefined : undefined,
        reason: typeof raw.reason === "string" ? raw.reason : "Supervisor routed the message.",
      };
    } catch (error) {
      logSupervisor(taskId, "message routing failed; using bounded fallback", { error: error instanceof Error ? error.message : String(error) });
      const recipients = mentioned.length > 0 ? mentioned : active;
      return {
        recipientIds: recipients.map((agent) => agent.id),
        instruction: ctx.userMessage,
        reason: "Routing model unavailable; forwarded only the new message to active workers.",
      };
    }
  }

  async assess(taskId: string, ctx: SupervisorContext): Promise<SupervisorDecision> {
    if (!this.gateway) {
      return { action: "continue", reason: "No supervisor model configured; granting more time by default." };
    }
    const systemPrompt = `You are a supervising team lead monitoring one worker agent after an execution attempt. Read its output against the current goal, success criteria, artifacts, and prior continuation count, then choose exactly ONE action:
- "continue": the worker output is acceptable for this todo OR it is making real progress and just needs more time.
- "redirect": the worker is off track, stuck, or misreading the task. Provide a corrected assignment in "handsOn".
- "accept": the produced artifacts already satisfy the success criteria; no more work is needed for this step.
- Course correction and replanning are allowed on "continue", "redirect", or "accept": use "newSubtasks" for new top-level work and "newSubSubtasks" for newly discovered micro-steps under the current subtask. Do not wait until the whole mission ends to report them.
- "fail": there is no viable path to success; stop here.
- If the worker asks for an assignment brief, missing context, or a file path/range that is already present in the supplied mission, subtask, criteria, or artifacts, treat that as a worker refusal/context failure: choose "fail" with a concise reason. Do not choose "redirect" and do not recommend another worker for the same contract.
Be decisive and cost-aware.

When the action is "accept", also identify the smallest set of existing artifact paths that should be shown as the completed mission deliverable. Put them in "relevantArtifactPaths". Choose only paths from the artifact list, prefer the final requested output over helper scripts, notes, source assets, and handoff documents, and return [] when no concrete deliverable is clear.

Return ONLY a JSON object: {"action":"continue"|"redirect"|"accept"|"fail","handsOn":"<only for redirect>","nextAgentTemplate":"<optional>","nextModel":"<optional>","newSubtasks":[{"id":"subtask-X","title":"...","capability":"files"|"browser"|"shell"|"verify","dependsOn":["..."],"riskLevel":"medium","successCriteria":"...","state":"pending"}],"newSubSubtasks":[{"parentSubtaskId":"<current subtask id, optional>","id":"<optional>","title":"...","result":"<optional>"}],"relevantArtifactPaths":["<existing artifact path>"],"reason":"<one concise sentence>"}`;

    const userPrompt = `Mission goal: "${ctx.missionGoal}"
Subtask: "${ctx.subtaskTitle}"
Success criteria: "${ctx.successCriteria}"
Continuations used: ${ctx.continuations} of ${ctx.maxContinuations}

Worker output/checkpoint:
${ctx.checkpointSummary || "(no checkpoint summary provided)"}

Artifacts produced so far:
${ctx.artifacts.length ? ctx.artifacts.map((a) => `- ${a.path}${a.description ? `: ${a.description}` : ""}`).join("\n") : "- None recorded."}

Return the decision JSON.`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    try {
      const res = await this.gateway.chat(messages, { modelRole: "utility", temperature: 0.1 });
      const decision = this.parse(res.content);
      logSupervisor(taskId, "assessment", {
        subtask: ctx.subtaskTitle,
        action: decision.action,
        reason: decision.reason,
        continuations: ctx.continuations,
      });
      return decision;
    } catch (err: any) {
      // If the supervisor itself fails, keep the worker alive (continue) rather
      // than killing a subtask over a routing-model hiccup. The continuation
      // budget still bounds any runaway.
      logSupervisor(taskId, "assessment failed; defaulting to continue", { error: err?.message ?? String(err) });
      return { action: "continue", reason: "Supervisor assessment unavailable; granting more time by default." };
    }
  }

  private parse(output: string): SupervisorDecision {
    const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/) || output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in supervisor output.");
    const raw = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    const action = raw.action as SupervisorAction;
    if (!["continue", "redirect", "accept", "fail"].includes(action)) {
      throw new Error(`Invalid supervisor action: ${String(raw.action)}`);
    }
    const handsOn = typeof raw.handsOn === "string" ? raw.handsOn.trim() : undefined;
    const nextAgentTemplate = typeof raw.nextAgentTemplate === "string" ? raw.nextAgentTemplate.trim() : undefined;
    const nextModel = typeof raw.nextModel === "string" ? raw.nextModel.trim() : undefined;
    const relevantArtifactPaths = Array.isArray(raw.relevantArtifactPaths)
      ? raw.relevantArtifactPaths
        .filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item: string) => item.trim())
      : undefined;
    const newSubtasks = Array.isArray(raw.newSubtasks)
      ? raw.newSubtasks.filter((item: any) => item && typeof item.id === "string" && typeof item.title === "string").map((item: any) => ({
        id: item.id.trim(), title: item.title.trim(), roles: Array.isArray(item.roles) ? item.roles.filter((role: unknown): role is string => typeof role === "string") : ["FilesAgent"], capabilities: Array.isArray(item.capabilities) ? item.capabilities.filter((capability: unknown): capability is string => typeof capability === "string") : ["files"],
        dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.filter((id: unknown): id is string => typeof id === "string") : [],
        riskLevel: typeof item.riskLevel === "string" ? item.riskLevel : "medium", successCriteria: typeof item.successCriteria === "string" ? item.successCriteria : "Complete the follow-up deliverable", state: "pending",
      }))
      : undefined;
    const newSubSubtasks = Array.isArray(raw.newSubSubtasks)
      ? raw.newSubSubtasks.filter((item: any) => item && typeof item.title === "string").map((item: any) => ({
        parentSubtaskId: typeof item.parentSubtaskId === "string" ? item.parentSubtaskId.trim() : undefined,
        id: typeof item.id === "string" ? item.id.trim() : undefined,
        title: item.title.trim(), result: typeof item.result === "string" ? item.result.trim() : undefined,
      }))
      : undefined;
    // A redirect with no concrete instructions is useless — treat it as continue.
    if (action === "redirect" && !handsOn) {
      return { action: "continue", nextAgentTemplate, nextModel, newSubtasks, newSubSubtasks, relevantArtifactPaths, reason: String(raw.reason || "Redirect lacked instructions; continuing.") };
    }
    return { action, handsOn, nextAgentTemplate, nextModel, newSubtasks, newSubSubtasks, relevantArtifactPaths, reason: String(raw.reason || "No reason provided.") };
  }
}
