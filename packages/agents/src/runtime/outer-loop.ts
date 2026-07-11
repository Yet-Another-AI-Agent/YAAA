import type { IBus, IStore } from "@yaaa/interfaces";
import { container, type Container } from "@yaaa/platform";
import { type AgentRun, type Subtask, type TaskPlan, type LedgerEntry, type DependencyOutput, buildAgentBrief, isInsufficientFundsError } from "@yaaa/shared";
import { AGENT_REGISTRY, selectAgentTemplate } from "../registry.js";
import { InnerLoop } from "./inner-loop.js";

// Gender-neutral display names for generalist agents without a roster handle.
const AGENT_DISPLAY_NAMES = ["Sage", "Quill", "Harbor", "Nova", "Rowan", "Cedar"];

// Anti-infinite-loop kill switch thresholds (blueprint Part VI.3): three
// consecutive identical error states trigger a hard interrupt, and no
// subtask may consume more than five agent attempts in total.
const MAX_IDENTICAL_ERRORS = 3;
const MAX_SUBTASK_ATTEMPTS = 5;

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

  constructor(scope: Container = container) {
    this.bus = scope.resolve<IBus>("IBus");
    this.store = scope.resolve<IStore>("IStore");
    this.innerLoop = new InnerLoop(scope);
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
    await this.store.saveAgent(snapshot.taskId, snapshot);
    await this.bus.publish(`task.${snapshot.taskId}.agent.${snapshot.id}.lifecycle`, snapshot);
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
    subtaskStates[subtask.id] = "running";

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

    // Anti-infinite-loop kill switch: track consecutive identical error
    // states. Three identical bounces trigger a hard interrupt — the
    // failing agent is killed, the failure chain is logged, and one fresh
    // agent is spawned with orders to try a completely different
    // approach. If that also fails, the subtask is declared failed.
    let lastErrorMessage: string | null = null;
    let identicalErrors = 0;
    let differentApproachAttempted = false;
    let attempts = 0;

    while (subtaskStates[subtask.id] === "running") {
      attempts++;
      const agent = this.createAgentRun(taskId, subtask, currentStep);
      await this.recordAgentLifecycle(agent);

      // Gather the structured results of this subtask's completed
      // dependencies so the agent sees real sibling output, not a flat fact list.
      const dependencyOutputs: DependencyOutput[] = subtask.dependsOn
        .map((depId) => completedOutputs.get(depId))
        .filter((out): out is DependencyOutput => out !== undefined);

      const retryDirective = differentApproachAttempted
        ? `Previous agents failed ${identicalErrors} consecutive times with: "${lastErrorMessage}". Attempt a COMPLETELY DIFFERENT approach — do not repeat the failed strategy.`
        : undefined;

      const instruction = buildAgentBrief({
        missionGoal: plan.goal,
        subtaskTitle: subtask.title,
        successCriteria: subtask.successCriteria,
        dependencyOutputs,
        retryDirective,
      });

      try {
        const result = await this.innerLoop.run({
          agentId: agent.id,
          taskId,
          templateName,
          instruction,
        });

        subtaskStates[subtask.id] = "completed";
        const summary = result.summary || JSON.stringify(result);
        facts.push(`Subtask ${subtask.id} finished. Summary: ${summary}`);
        completedOutputs.set(subtask.id, { id: subtask.id, title: subtask.title, summary });
        agent.status = "completed";
        agent.finishedAt = new Date().toISOString();
        agent.summary = summary;
        await this.recordAgentLifecycle(agent);
      } catch (err: any) {
        // Out-of-funds is non-recoverable: abort the whole run immediately so
        // the caller can prompt the user to update their key / add credit,
        // rather than churning through every subtask with the same failure.
        // Rethrowing here rejects the enclosing `Promise.all`, tearing down the
        // whole run just as the serial version did.
        if (isInsufficientFundsError(err)) {
          throw err;
        }

        identicalErrors = err.message === lastErrorMessage ? identicalErrors + 1 : 1;
        lastErrorMessage = err.message;

        agent.status = "failed";
        agent.finishedAt = new Date().toISOString();
        agent.summary = err.message;
        await this.recordAgentLifecycle(agent);
        console.error(`Subtask ${subtask.id} attempt ${attempts} failed:`, err);

        const loopDetected = identicalErrors >= MAX_IDENTICAL_ERRORS;
        if (loopDetected && !differentApproachAttempted) {
          differentApproachAttempted = true;
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
        if (loopDetected || attempts >= MAX_SUBTASK_ATTEMPTS) {
          subtaskStates[subtask.id] = "failed";
          facts.push(`Subtask ${subtask.id} failed. Error: ${err.message}`);
        }
      }
      currentStep = allocateStep();
    }
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
