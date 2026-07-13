import type { IMeshGateway, ChatMessage } from "@yaaa/interfaces";
import { container, type Container } from "@yaaa/platform";

/** What the master observes about a worker that just checkpointed incomplete. */
export interface SupervisorContext {
  missionGoal: string;
  subtaskTitle: string;
  successCriteria: string;
  /** The worker's own checkpoint summary (status, work done, remaining work). */
  checkpointSummary: string;
  artifacts: Array<{ path: string; description?: string }>;
  /** How many continuations this subtask has already burned. */
  continuations: number;
  maxContinuations: number;
}

export type SupervisorAction = "continue" | "redirect" | "accept" | "fail";

/**
 * The master's decision after reading a worker's progress:
 * - continue: on track, just needs more time — renew with a fresh timer.
 * - redirect: off track — renew but hand it the corrected `handsOn`.
 * - accept: the deliverable already meets the success criteria — mark it done.
 * - fail: no viable path — stop burning continuations and fail the subtask.
 */
export interface SupervisorDecision {
  action: SupervisorAction;
  /** New assignment text, required (and only used) when action === "redirect". */
  handsOn?: string;
  reason: string;
}

function logSupervisor(taskId: string, message: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[YAAA:Supervisor:${taskId}] ${message}${suffix}`);
}

/**
 * Master ("team lead") that assesses a worker's live progress at a timebox
 * checkpoint and decides what to do, instead of the old behaviour of blindly
 * cold-spawning a fresh continuation agent every time. Uses the cheap `utility`
 * model role — this is a routing judgement, not the primary work.
 */
export class SupervisorAssessor {
  private gateway: IMeshGateway | null;

  constructor(scope: Container = container) {
    // The gateway is optional: if a bare scope (e.g. a focused test) has no model
    // gateway, the supervisor degrades to "continue" rather than blocking the run.
    try {
      this.gateway = scope.resolve<IMeshGateway>("IMeshGateway");
    } catch {
      this.gateway = null;
    }
  }

  async assess(taskId: string, ctx: SupervisorContext): Promise<SupervisorDecision> {
    if (!this.gateway) {
      return { action: "continue", reason: "No supervisor model configured; granting more time by default." };
    }
    const systemPrompt = `You are a supervising team lead monitoring one worker agent that reached its time budget and handed off an incomplete checkpoint. Read its progress against the goal and success criteria, then choose exactly ONE action:
- "continue": the worker is making real progress toward the criteria and just needs more time. Prefer this while progress is evident.
- "redirect": the worker is off track, stuck, or misreading the task. Provide a corrected, concrete assignment in "handsOn" (what to do next, referencing the existing artifacts so it does not restart from scratch).
- "accept": the produced artifacts already satisfy the success criteria; no more work is needed.
- "fail": there is no viable path to success (e.g. an impossible/contradictory requirement, or repeated wasted continuations); stop here.
Be decisive and cost-aware: do not "continue" forever if there is no progress. Consider how many continuations have already been spent.

Return ONLY a JSON object: {"action":"continue"|"redirect"|"accept"|"fail","handsOn":"<only for redirect>","reason":"<one concise sentence>"}`;

    const userPrompt = `Mission goal: "${ctx.missionGoal}"
Subtask: "${ctx.subtaskTitle}"
Success criteria: "${ctx.successCriteria}"
Continuations used: ${ctx.continuations} of ${ctx.maxContinuations}

Worker checkpoint:
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
    // A redirect with no concrete instructions is useless — treat it as continue.
    if (action === "redirect" && !handsOn) {
      return { action: "continue", reason: String(raw.reason || "Redirect lacked instructions; continuing.") };
    }
    return { action, handsOn, reason: String(raw.reason || "No reason provided.") };
  }
}
