import type { IBus, IStore } from "@yaaa/interfaces";
import { container, type Container } from "@yaaa/platform";
import { type AgentRun, type Subtask, type TaskPlan, type LedgerEntry, type DependencyOutput, buildAgentBrief, getErrorFingerprint, isInsufficientFundsError } from "@yaaa/shared";
import { AGENT_REGISTRY, selectAgentTemplate } from "../registry.js";
import { InnerLoop } from "./inner-loop.js";
import { SupervisorAssessor } from "./supervisor-assessor.js";

// Gender-neutral display names for generalist agents without a roster handle.
const AGENT_DISPLAY_NAMES = ["Sage", "Quill", "Harbor", "Nova", "Rowan", "Cedar"];

// The retry decision is driven by the *shape of the failure*, not a fixed
// attempt count: when the same error fingerprint recurs this many times the
// agent is demonstrably stuck, so we stop and escalate to a different approach.
const MAX_IDENTICAL_ERRORS = 3;

// A pure safety backstop so an agent that fails a *different* way every single
// time (and so never trips the recurrence detector above) still terminates.
// It is not the primary control — the recurrence/kill-switch logic is — and it
// is operator-tunable rather than a bare literal.
function resolveMaxSubtaskAttempts(): number {
  const raw = Number(process.env.YAAA_MAX_SUBTASK_ATTEMPTS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
}

// Timebox continuations are NOT failures — an agent that checkpoints incomplete
// and hands off to a continuation is making progress, not erroring. They get
// their own generous budget, kept separate from the error-retry budget above so
// a slow-but-progressing subtask is never marked failed just for taking several
// renewed timers. Only a runaway with no end in sight trips this backstop.
function resolveMaxContinuations(): number {
  const raw = Number(process.env.YAAA_MAX_CONTINUATIONS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20;
}

// How many fix→re-verify rounds a failing verification may negotiate before the
// subtask is declared failed. A failed verifier is not the end of the line: the
// master sends the deliverable back to a worker to fix, then re-verifies.
function resolveMaxVerificationRounds(): number {
  const raw = Number(process.env.YAAA_MAX_VERIFICATION_ROUNDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2;
}

/**
 * Optional operator-configured model to use on retries, giving cross-provider
 * resilience without hardcoding a specific (and possibly unavailable) model.
 * When unset, retries reuse the agent's own configured model.
 */
function resolveBackupModel(): string | undefined {
  return process.env.YAAA_BACKUP_MODEL?.trim() || undefined;
}

function logOuter(taskId: string, message: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[YAAA:OuterLoop:${taskId}] ${message}${suffix}`);
}

function warnOuter(taskId: string, message: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.warn(`[YAAA:OuterLoop:${taskId}] ${message}${suffix}`);
}

/** Run-wide mutable state shared (by reference) across concurrent subtasks. */
interface RunContext {
  subtaskStates: Record<string, "pending" | "running" | "completed" | "failed">;
  facts: string[];
  assumptions: string[];
  /** Structured results keyed by subtask id, threaded into dependents' briefs. */
  completedOutputs: Map<string, DependencyOutput>;
  /** Synchronous read-then-increment step allocator (see run() for why it's safe). */
  allocateStep: () => number;
}

export class OuterLoop {
  private bus: IBus;
  private store: IStore;
  private innerLoop: InnerLoop;
  private supervisor: SupervisorAssessor;

  constructor(scope: Container = container) {
    this.bus = scope.resolve<IBus>("IBus");
    this.store = scope.resolve<IStore>("IStore");
    this.innerLoop = new InnerLoop(scope);
    this.supervisor = new SupervisorAssessor(scope);
  }

  private selectTemplate(subtask: Subtask): string {
    return selectAgentTemplate(subtask);
  }

  private createAgentRun(taskId: string, subtask: Subtask, step: number): AgentRun {
    const templateName = this.selectTemplate(subtask);
    const template = AGENT_REGISTRY[templateName];
    const fallbackName = AGENT_DISPLAY_NAMES[(step - 1) % AGENT_DISPLAY_NAMES.length];
    // Roster specialists surface their blueprint handle (e.g. @qa-tester-2);
    // generalists keep the gender-neutral display-name scheme (@sage-1).
    const handle = template?.handle
      ? `${template.handle}-${step}`
      : `@${fallbackName.toLowerCase()}-${step}`;
    const displayName = template?.handle
      ? template.handle.slice(1)
      : fallbackName;
    return {
      id: `${subtask.capability}-agent-${Math.random().toString(36).slice(2, 6)}`,
      handle,
      displayName,
      taskId,
      subtaskId: subtask.id,
      role: templateName,
      modelRole: template?.modelRole ?? "worker",
      status: "working",
      startedAt: new Date().toISOString(),
    };
  }

  private async recordAgentLifecycle(agent: AgentRun): Promise<void> {
    // A lifecycle event is an immutable observation.  Copy before handing it
    // to persistence/subscribers because the live assignment is updated as
    // the inner loop progresses.
    const snapshot = { ...agent };
    logOuter(snapshot.taskId, "agent lifecycle", {
      agentId: snapshot.id,
      handle: snapshot.handle,
      role: snapshot.role,
      status: snapshot.status,
      subtaskId: snapshot.subtaskId,
      modelRole: snapshot.modelRole,
    });
    await this.store.saveAgent(snapshot.taskId, snapshot);
    await this.bus.publish(`task.${snapshot.taskId}.agent.${snapshot.id}.lifecycle`, snapshot);
  }

  /**
   * Negotiate a failing verification instead of surrendering to it: send the
   * deliverable back to a worker with the verifier's findings, then re-verify,
   * bounded by {@link resolveMaxVerificationRounds}. Returns the reconciled
   * outcome. This is what turns a "verifier failed → whole run aborts" into a
   * "verifier failed → fix it → re-check" collaboration.
   */
  private async negotiateVerification(
    taskId: string,
    plan: TaskPlan,
    verifySubtask: Subtask,
    initialVerdict: { status?: string; findings?: string[]; evidence?: string[]; summary?: string; reason?: string; artifacts?: DependencyOutput["artifacts"] },
    ctx: RunContext,
  ): Promise<{ passed: boolean; summary: string; artifacts: DependencyOutput["artifacts"] }> {
    const maxRounds = resolveMaxVerificationRounds();
    const producer = plan.subtasks.find((s) => verifySubtask.dependsOn.includes(s.id));
    const producerTemplate = producer ? selectAgentTemplate(producer) : "FilesAgent";
    const verifyTemplate = selectAgentTemplate(verifySubtask);
    const producerOutputs: DependencyOutput[] = producer
      ? [ctx.completedOutputs.get(producer.id)].filter((o): o is DependencyOutput => o !== undefined)
      : [];
    let verdict = initialVerdict;

    for (let round = 1; round <= maxRounds && (verdict.status ?? "failed") === "failed"; round++) {
      const findings = (verdict.findings ?? []).map((f) => `- ${f}`).join("\n") || "- (no specific findings)";
      const evidence = (verdict.evidence ?? []).map((e) => `- ${e}`).join("\n") || "- (none)";
      await this.bus.publish(`task.${taskId}.started`, {
        kind: "status",
        from: "orchestrator",
        taskId,
        state: "working",
        note: `🔁 Verification failed for "${verifySubtask.title}" (round ${round}/${maxRounds}). Sending it back to a worker to fix, then re-verifying.`,
      });

      // 1) Fix worker — repair the producer's deliverable using the findings.
      const fixAgent = this.createAgentRun(taskId, producer ?? verifySubtask, ctx.allocateStep());
      await this.recordAgentLifecycle(fixAgent);
      const fixWorkspace = `agent-workspaces/${fixAgent.id}`;
      const fixBrief = buildAgentBrief({
        missionGoal: plan.goal,
        subtaskTitle: producer ? producer.title : verifySubtask.title,
        successCriteria: producer ? producer.successCriteria : verifySubtask.successCriteria,
        dependencyOutputs: producerOutputs,
        retryDirective: `An independent verifier FAILED the current deliverable. Fix it in place so it satisfies the success criteria — do NOT start over.\n\nVerifier findings:\n${findings}\n\nEvidence:\n${evidence}`,
        handsOnPath: `${fixWorkspace}/handsOn.md`,
        proofOfWorkPath: `${fixWorkspace}/proofOfWork.md`,
        handOffPath: `${fixWorkspace}/handOff.md`,
      });
      try {
        const fixResult = await this.innerLoop.run({ agentId: fixAgent.id, taskId, templateName: producerTemplate, instruction: fixBrief, model: producer?.model });
        fixAgent.status = "completed";
        fixAgent.summary = fixResult.summary || "";
      } catch (err: any) {
        fixAgent.status = "failed";
        fixAgent.summary = err?.message;
      }
      fixAgent.finishedAt = new Date().toISOString();
      await this.recordAgentLifecycle(fixAgent);
      ctx.facts.push(`Verification round ${round} fix for ${verifySubtask.id}: ${fixAgent.summary || "(no summary)"}`);

      // 2) Re-verify the repaired deliverable with a fresh verifier agent.
      const reVerifyAgent = this.createAgentRun(taskId, verifySubtask, ctx.allocateStep());
      await this.recordAgentLifecycle(reVerifyAgent);
      const verifyWorkspace = `agent-workspaces/${reVerifyAgent.id}`;
      const verifyBrief = buildAgentBrief({
        missionGoal: plan.goal,
        subtaskTitle: verifySubtask.title,
        successCriteria: verifySubtask.successCriteria,
        dependencyOutputs: producerOutputs,
        retryDirective: `Re-verify the deliverable after fix round ${round}. A previous verification failed with:\n${findings}\nConfirm whether those issues are now resolved.`,
        handsOnPath: `${verifyWorkspace}/handsOn.md`,
        proofOfWorkPath: `${verifyWorkspace}/proofOfWork.md`,
        handOffPath: `${verifyWorkspace}/handOff.md`,
      });
      try {
        const reVerify: any = await this.innerLoop.run({ agentId: reVerifyAgent.id, taskId, templateName: verifyTemplate, instruction: verifyBrief, model: verifySubtask.model });
        verdict = reVerify;
        reVerifyAgent.status = "completed";
        reVerifyAgent.summary = reVerify.summary ?? reVerify.reason;
      } catch (err: any) {
        reVerifyAgent.status = "failed";
        reVerifyAgent.summary = err?.message;
        verdict = { status: "failed", reason: err?.message, findings: [err?.message] };
      }
      reVerifyAgent.finishedAt = new Date().toISOString();
      await this.recordAgentLifecycle(reVerifyAgent);
    }

    const passed = (verdict.status ?? "failed") === "passed";
    return { passed, summary: verdict.summary ?? verdict.reason ?? "", artifacts: verdict.artifacts ?? [] };
  }

  /**
   * Execute a single subtask's full attempt / kill-switch lifecycle.
   *
   * Extracted from `run` so a whole batch of independent ready subtasks can be
   * mapped over and awaited concurrently via `Promise.all`. Every piece of
   * run-wide mutable state it touches is passed in by reference via `ctx` so
   * concurrent invocations share one consistent view.
   */
  private async runSubtask(taskId: string, plan: TaskPlan, subtask: Subtask, ctx: RunContext): Promise<void> {
    const { subtaskStates, facts, assumptions, completedOutputs, allocateStep } = ctx;
    logOuter(taskId, "subtask starting", {
      subtaskId: subtask.id,
      title: subtask.title,
      capability: subtask.capability,
      agentTemplate: subtask.agentTemplate,
      plannedModel: subtask.model,
      dependsOn: subtask.dependsOn,
    });
    subtaskStates[subtask.id] = "running";
    subtask.state = "running";
    await this.store.savePlan(taskId, plan);
    await this.bus.publish(`task.${taskId}.plan_updated`, plan);

    // Claim this subtask's first step number synchronously. The ledger entry
    // and the first spawned agent share it, mirroring the original serial
    // numbering where `step` was not bumped between them.
    let currentStep = allocateStep();

    const ledgerEntry: LedgerEntry = {
      timestamp: new Date().toISOString(),
      step: currentStep,
      facts: [...facts],
      assumptions: [...assumptions],
      subtaskStates: { ...subtaskStates },
      nextStepStrategy: `Spawning ${this.selectTemplate(subtask)} to execute subtask: ${subtask.title}`
    };
    await this.store.saveLedgerEntry(taskId, ledgerEntry);

    await this.bus.publish(`task.${taskId}.started`, {
      kind: "status",
      from: "orchestrator",
      taskId,
      state: "working",
      note: `Starting subtask: ${subtask.title}`
    });

    const templateName = this.selectTemplate(subtask);
    const maxAttempts = resolveMaxSubtaskAttempts();
    const maxContinuations = resolveMaxContinuations();
    const backupModel = resolveBackupModel();
    logOuter(taskId, "subtask execution policy", {
      subtaskId: subtask.id,
      templateName,
      maxAttempts,
      backupModel: backupModel ?? null,
    });

    // Anti-infinite-loop kill switch: track consecutive identical error
    // states. Three identical bounces trigger a hard interrupt — the
    // failing agent is killed, the failure chain is logged, and one fresh
    // agent is spawned with orders to try a completely different
    // approach. If that also fails, the subtask is declared failed.
    let lastErrorMessage: string | null = null;
    let lastErrorFingerprint: string | null = null;
    let identicalErrors = 0;
    let differentApproachAttempted = false;
    let attempts = 0;
    // Error retries and timebox continuations are budgeted independently: a slow
    // subtask that keeps checkpointing progress must not exhaust the error budget.
    let errorAttempts = 0;
    let continuations = 0;
    let lastIncompleteSummary: string | null = null;
    let lastIncompleteArtifacts: Array<{ path: string; mimeType: string; description: string }> = [];
    // Set by the supervisor when it decides to redirect a checkpointed worker;
    // becomes the next continuation's directive, overriding the generic "continue
    // from your handoff" text with concrete course-correction.
    let supervisorRedirect: string | null = null;

    while (subtaskStates[subtask.id] === "running") {
      attempts++;
      // First attempt uses the planner-assigned model. Retries use an
      // operator-configured backup model when present; otherwise they fall back
      // to the agent template's default role mapping.
      const selectedModel = attempts === 1 ? (subtask.model || undefined) : backupModel;
      const modelSource =
        attempts === 1
          ? selectedModel ? "planner" : "template-default"
          : selectedModel ? "backup" : "template-default-retry";
      const agent = this.createAgentRun(taskId, subtask, currentStep);
      if (selectedModel) agent.modelRole = selectedModel;
      const workspacePrefix = `agent-workspaces/${agent.id}`;
      const handsOnArtifact = {
        path: `${workspacePrefix}/handsOn.md`,
        mimeType: "text/markdown",
        description: `Orchestrator hands-on assignment for ${subtask.id}.`,
      };
      subtask.artifacts = [
        handsOnArtifact,
        ...((subtask.artifacts ?? []).filter((artifact) => artifact.path !== handsOnArtifact.path)),
      ];
      await this.store.savePlan(taskId, plan);
      logOuter(taskId, "attempt starting", {
        subtaskId: subtask.id,
        attempt: attempts,
        agentId: agent.id,
        handle: agent.handle,
        templateName,
        selectedModel: selectedModel ?? null,
        modelSource,
        effectiveModelRole: agent.modelRole,
      });
      await this.recordAgentLifecycle(agent);
      await this.bus.publish(`task.${taskId}.plan_updated`, plan);

      // Gather the structured results of this subtask's completed
      // dependencies so the agent sees real sibling output, not a flat fact list.
      const dependencyOutputs: DependencyOutput[] = subtask.dependsOn
        .map((depId) => completedOutputs.get(depId))
        .filter((out): out is DependencyOutput => out !== undefined);

      const retryDirective = supervisorRedirect
        ? `Supervisor course-correction from the team lead who reviewed the previous checkpoint:\n${supervisorRedirect}\n\nContinue from the existing artifacts; do not restart from scratch.\n\nCheckpoint artifacts:\n${lastIncompleteArtifacts.map((artifact) => `- ${artifact.path}: ${artifact.description}`).join("\n") || "- None recorded."}`
        : differentApproachAttempted
        ? `Previous agents failed ${identicalErrors} consecutive times with: "${lastErrorMessage}". Attempt a COMPLETELY DIFFERENT approach — do not repeat the failed strategy.`
        : lastIncompleteSummary
          ? `Previous agent reached its timebox and produced an incomplete handoff instead of a final deliverable. Continue from the listed artifacts; do not restart unless the evidence is insufficient.\n\nCheckpoint summary:\n${lastIncompleteSummary}\n\nCheckpoint artifacts:\n${lastIncompleteArtifacts.map((artifact) => `- ${artifact.path}: ${artifact.description}`).join("\n") || "- None recorded."}`
        : undefined;

      const instruction = buildAgentBrief({
        missionGoal: plan.goal,
        subtaskTitle: subtask.title,
        successCriteria: subtask.successCriteria,
        dependencyOutputs,
        retryDirective,
        handsOnPath: `${workspacePrefix}/handsOn.md`,
        proofOfWorkPath: `${workspacePrefix}/proofOfWork.md`,
        handOffPath: `${workspacePrefix}/handOff.md`,
      });

      try {
        const modelLabel = selectedModel
          ? ` using ${modelSource} model: ${selectedModel}`
          : ` using ${modelSource}`;
        console.log(`[OuterLoop] Executing subtask ${subtask.id} (attempt ${attempts})${modelLabel}`);
        const result = await this.innerLoop.run({
          agentId: agent.id,
          taskId,
          templateName,
          instruction,
          contextArtifacts: lastIncompleteArtifacts.map((artifact) => artifact.path),
          model: selectedModel,
        });

        const summary = result.summary || JSON.stringify(result);
        const resultArtifacts = [handsOnArtifact, ...(result.artifacts ?? [])];
        if (result.incomplete) {
          subtask.result = summary;
          subtask.artifacts = resultArtifacts;
          lastIncompleteSummary = summary;
          lastIncompleteArtifacts = resultArtifacts;
          facts.push(`Subtask ${subtask.id} checkpointed incomplete. Summary: ${summary}`);
          await this.store.savePlan(taskId, plan);
          await this.bus.publish(`task.${taskId}.plan_updated`, plan);
          agent.status = "exited";
          agent.finishedAt = new Date().toISOString();
          agent.summary = summary;
          await this.recordAgentLifecycle(agent);
          continuations++;
          logOuter(taskId, "attempt checkpointed incomplete", {
            subtaskId: subtask.id,
            attempt: attempts,
            agentId: agent.id,
            artifactCount: resultArtifacts.length,
            continuations,
            maxContinuations,
          });

          // A timebox checkpoint is progress, not failure. Instead of blindly
          // cold-spawning a continuation, the supervisor reads the worker's live
          // progress and decides: continue (more time), redirect (corrected
          // handsOn), accept (criteria already met), or fail (no viable path).
          const decision = await this.supervisor.assess(taskId, {
            missionGoal: plan.goal,
            subtaskTitle: subtask.title,
            successCriteria: subtask.successCriteria,
            checkpointSummary: summary,
            artifacts: resultArtifacts.map((a) => ({ path: a.path, description: a.description })),
            continuations,
            maxContinuations,
          });
          await this.bus.publish(`task.${taskId}.started`, {
            kind: "status",
            from: "orchestrator",
            taskId,
            state: "working",
            note: `👔 Supervisor reviewed the "${subtask.title}" checkpoint → ${decision.action}: ${decision.reason}`,
          });

          if (decision.action === "accept") {
            subtaskStates[subtask.id] = "completed";
            subtask.state = "completed";
            subtask.result = summary;
            subtask.artifacts = resultArtifacts;
            facts.push(`Subtask ${subtask.id} accepted by supervisor at checkpoint. Summary: ${summary}`);
            completedOutputs.set(subtask.id, { id: subtask.id, title: subtask.title, summary, artifacts: resultArtifacts });
            await this.store.savePlan(taskId, plan);
            await this.bus.publish(`task.${taskId}.plan_updated`, plan);
            continue;
          }

          if (decision.action === "fail" || continuations >= maxContinuations) {
            subtaskStates[subtask.id] = "failed";
            subtask.state = "failed";
            const why =
              decision.action === "fail"
                ? `Supervisor stopped it: ${decision.reason}`
                : `Exceeded ${continuations} incomplete checkpoint continuation(s)`;
            facts.push(`Subtask ${subtask.id} failed at checkpoint. ${why}`);
            await this.store.savePlan(taskId, plan);
            await this.bus.publish(`task.${taskId}.plan_updated`, plan);
            continue;
          }

          // continue or redirect → renew the timer with a continuation agent. A
          // redirect carries corrected instructions into the next brief.
          supervisorRedirect = decision.action === "redirect" ? decision.handsOn ?? null : null;
          currentStep = allocateStep();
          continue;
        }

        // A verify subtask that returns a "failed" verdict is NOT a done subtask.
        // Negotiate a bounded fix→re-verify loop before accepting the outcome,
        // instead of letting the failure fall straight through to a run abort.
        if (subtask.capability === "verify" && (result as any).status === "failed") {
          const outcome = await this.negotiateVerification(taskId, plan, subtask, result as any, ctx);
          agent.status = outcome.passed ? "completed" : "failed";
          agent.finishedAt = new Date().toISOString();
          agent.summary = outcome.summary || summary;
          await this.recordAgentLifecycle(agent);
          if (!outcome.passed) {
            subtaskStates[subtask.id] = "failed";
            subtask.state = "failed";
            subtask.result = outcome.summary || summary;
            await this.store.savePlan(taskId, plan);
            await this.bus.publish(`task.${taskId}.plan_updated`, plan);
            facts.push(`Subtask ${subtask.id} failed verification after fix rounds. ${outcome.summary}`);
            continue;
          }
          subtaskStates[subtask.id] = "completed";
          subtask.state = "completed";
          subtask.result = outcome.summary || summary;
          subtask.artifacts = resultArtifacts;
          await this.store.savePlan(taskId, plan);
          await this.bus.publish(`task.${taskId}.plan_updated`, plan);
          facts.push(`Subtask ${subtask.id} passed after ${resolveMaxVerificationRounds()}-round fix negotiation. Summary: ${outcome.summary || summary}`);
          completedOutputs.set(subtask.id, { id: subtask.id, title: subtask.title, summary: outcome.summary || summary, artifacts: resultArtifacts });
          logOuter(taskId, "verification reconciled to pass", { subtaskId: subtask.id });
          continue;
        }

        subtaskStates[subtask.id] = "completed";
        subtask.state = "completed";
        subtask.result = summary;
        subtask.artifacts = resultArtifacts;
        await this.store.savePlan(taskId, plan);
        await this.bus.publish(`task.${taskId}.plan_updated`, plan);
        facts.push(`Subtask ${subtask.id} finished. Summary: ${summary}`);
        completedOutputs.set(subtask.id, { id: subtask.id, title: subtask.title, summary, artifacts: resultArtifacts });
        agent.status = "completed";
        agent.finishedAt = new Date().toISOString();
        agent.summary = summary;
        await this.recordAgentLifecycle(agent);
        logOuter(taskId, "attempt completed", {
          subtaskId: subtask.id,
          attempt: attempts,
          agentId: agent.id,
          artifactCount: resultArtifacts.length,
          summaryChars: summary.length,
        });
      } catch (err: any) {
        // Out-of-funds is non-recoverable: abort the whole run immediately so
        // the caller can prompt the user to update their key / add credit,
        // rather than churning through every subtask with the same failure.
        // Rethrowing here rejects the enclosing `Promise.all`, tearing down the
        // whole run just as the serial version did.
        if (isInsufficientFundsError(err)) {
          throw err;
        }

        errorAttempts++;
        const fingerprint = getErrorFingerprint(err);
        identicalErrors = fingerprint === lastErrorFingerprint ? identicalErrors + 1 : 1;
        lastErrorFingerprint = fingerprint;
        lastErrorMessage = err.message;
        warnOuter(taskId, "attempt failed", {
          subtaskId: subtask.id,
          attempt: attempts,
          agentId: agent.id,
          error: err.message,
          fingerprint,
          identicalErrors,
          errorAttempts,
          maxAttempts,
        });

        agent.status = "failed";
        agent.finishedAt = new Date().toISOString();
        agent.summary = err.message;
        await this.recordAgentLifecycle(agent);
        console.error(`Subtask ${subtask.id} attempt ${attempts} failed:`, err);

        // Transient/rate-limit backoff is intentionally NOT done here: the model
        // client already retries 5xx/429 with exponential backoff that honours
        // the provider's Retry-After header, so an extra hardcoded sleep would
        // only stack redundant, arbitrary waits on top of it.

        // A recurring identical failure means the agent is genuinely stuck, so
        // escalate to one fresh agent ordered to try a completely different
        // approach. If even that keeps failing — or an agent that fails a new
        // way every time never trips this and only the safety backstop stops it
        // — the subtask is declared failed.
        const loopDetected = identicalErrors >= MAX_IDENTICAL_ERRORS;
        if (loopDetected && !differentApproachAttempted) {
          differentApproachAttempted = true;
          warnOuter(taskId, "kill switch activated, retrying with different approach", {
            subtaskId: subtask.id,
            identicalErrors,
            error: err.message,
          });
          await this.bus.publish(`task.${taskId}.started`, {
            kind: "status",
            from: "orchestrator",
            taskId,
            state: "working",
            note: `⛔ Kill switch: ${identicalErrors} identical failures on "${subtask.title}" (${err.message}). Killing the agent and spawning a replacement with a different approach.`,
          });
          currentStep = allocateStep();
          continue;
        }
        if (loopDetected || differentApproachAttempted || errorAttempts >= maxAttempts) {
          subtaskStates[subtask.id] = "failed";
          subtask.state = "failed";
          warnOuter(taskId, "subtask marked failed", {
            subtaskId: subtask.id,
            attempts,
            loopDetected,
            differentApproachAttempted,
            error: err.message,
          });
          await this.store.savePlan(taskId, plan);
          await this.bus.publish(`task.${taskId}.plan_updated`, plan);
          facts.push(`Subtask ${subtask.id} failed. Error: ${err.message}`);
        }
      }
      currentStep = allocateStep();
    }
    logOuter(taskId, "subtask finished loop", {
      subtaskId: subtask.id,
      state: subtaskStates[subtask.id],
      attempts,
    });
  }

  async run(taskId: string, plan: TaskPlan): Promise<void> {
    await this.store.savePlan(taskId, plan);

    const subtasks = [...plan.subtasks];
    const subtaskStates: Record<string, "pending" | "running" | "completed" | "failed"> = {};
    for (const st of subtasks) {
      subtaskStates[st.id] = "pending";
    }

    const facts: string[] = [];
    const assumptions: string[] = [];
    // Structured results keyed by subtask id, threaded into each dependent
    // agent's brief so siblings actually see what prior steps produced.
    const completedOutputs = new Map<string, DependencyOutput>();

    // `step` numbers ledger entries and agent ids. Now that sibling subtasks
    // run concurrently, several `runSubtask` calls draw from this counter with
    // their awaits interleaved. `allocateStep` does a synchronous
    // read-then-increment: because JS is single-threaded and there is no
    // `await` between reading `step` and bumping it, each call is guaranteed a
    // unique number — two concurrent subtasks can never silently share a step.
    let step = 1;
    const allocateStep = (): number => step++;

    // Outer plan loop
    while (subtasks.some((st) => subtaskStates[st.id] !== "completed" && subtaskStates[st.id] !== "failed")) {
      const readySubtasks = subtasks.filter(
        (st) =>
          subtaskStates[st.id] === "pending" &&
          st.dependsOn.every((depId) => subtaskStates[depId] === "completed")
      );

      if (readySubtasks.length === 0) {
        // Check for deadlock/failures
        const incomplete = subtasks.filter((st) => subtaskStates[st.id] !== "completed");
        if (incomplete.some((st) => subtaskStates[st.id] === "failed")) {
          throw new Error("Task execution failed due to subtask failure.");
        }
        throw new Error("Deadlock detected in subtask execution dependency graph.");
      }

      // Run every currently-ready subtask concurrently. This batch is mutually
      // independent by construction: a subtask only becomes "ready" once all of
      // its `dependsOn` are already "completed", so nothing here depends on a
      // sibling in the same batch. Dependents surface in a later outer
      // iteration, once their dependencies' outputs have already been recorded.
      // An insufficient-funds error from any subtask rejects this `Promise.all`
      // and propagates out of the whole run.
      await Promise.all(
        readySubtasks.map((subtask) =>
          this.runSubtask(taskId, plan, subtask, {
            subtaskStates,
            facts,
            assumptions,
            completedOutputs,
            allocateStep,
          }),
        ),
      );
    }

    const failedTasks = subtasks.filter((st) => subtaskStates[st.id] === "failed");
    if (failedTasks.length > 0) {
      throw new Error("Task execution failed due to subtask failure.");
    }

    const finalLedger: LedgerEntry = {
      timestamp: new Date().toISOString(),
      step,
      facts,
      assumptions,
      subtaskStates,
      nextStepStrategy: "Synthesis and completion."
    };
    await this.store.saveLedgerEntry(taskId, finalLedger);
  }
}
