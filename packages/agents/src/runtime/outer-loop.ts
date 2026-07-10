import type { IBus, IStore } from "@yaaa/interfaces";
import { container } from "@yaaa/platform";
import { type AgentRun, type Subtask, type TaskPlan, type LedgerEntry, isInsufficientFundsError } from "@yaaa/shared";
import { AGENT_REGISTRY, selectAgentTemplate } from "../registry.js";
import { InnerLoop } from "./inner-loop.js";

// Gender-neutral display names for generalist agents without a roster handle.
const AGENT_DISPLAY_NAMES = ["Sage", "Quill", "Harbor", "Nova", "Rowan", "Cedar"];

// Anti-infinite-loop kill switch thresholds (blueprint Part VI.3): three
// consecutive identical error states trigger a hard interrupt, and no
// subtask may consume more than five agent attempts in total.
const MAX_IDENTICAL_ERRORS = 3;
const MAX_SUBTASK_ATTEMPTS = 5;

export class OuterLoop {
  private bus: IBus;
  private store: IStore;
  private innerLoop: InnerLoop;

  constructor() {
    this.bus = container.resolve<IBus>("IBus");
    this.store = container.resolve<IStore>("IStore");
    this.innerLoop = new InnerLoop();
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

  async run(taskId: string, plan: TaskPlan): Promise<void> {
    await this.store.savePlan(taskId, plan);
    
    const subtasks = [...plan.subtasks];
    const subtaskStates: Record<string, "pending" | "running" | "completed" | "failed"> = {};
    for (const st of subtasks) {
      subtaskStates[st.id] = "pending";
    }

    const facts: string[] = [];
    const assumptions: string[] = [];
    let step = 1;

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

      // Execute ready subtasks (we can run sequentially for M1 simplicity)
      for (const subtask of readySubtasks) {
        subtaskStates[subtask.id] = "running";

        const ledgerEntry: LedgerEntry = {
          timestamp: new Date().toISOString(),
          step,
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
          const agent = this.createAgentRun(taskId, subtask, step);
          await this.recordAgentLifecycle(agent);

          const baseInstruction = `${subtask.title}. Goal: ${subtask.successCriteria}`;
          const instruction = differentApproachAttempted
            ? `Previous agents failed ${identicalErrors} consecutive times with: "${lastErrorMessage}". Attempt a COMPLETELY DIFFERENT approach — do not repeat the failed strategy. ${baseInstruction}`
            : baseInstruction;

          try {
            const result = await this.innerLoop.run({
              agentId: agent.id,
              taskId,
              templateName,
              instruction,
              contextArtifacts: facts.map((f) => `Fact: ${f}`),
            });

            subtaskStates[subtask.id] = "completed";
            facts.push(`Subtask ${subtask.id} finished. Summary: ${result.summary || JSON.stringify(result)}`);
            agent.status = "completed";
            agent.finishedAt = new Date().toISOString();
            agent.summary = result.summary || JSON.stringify(result);
            await this.recordAgentLifecycle(agent);
          } catch (err: any) {
            // Out-of-funds is non-recoverable: abort the whole run immediately so
            // the caller can prompt the user to update their key / add credit,
            // rather than churning through every subtask with the same failure.
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
              step++;
              continue;
            }
            if (loopDetected || attempts >= MAX_SUBTASK_ATTEMPTS) {
              subtaskStates[subtask.id] = "failed";
              facts.push(`Subtask ${subtask.id} failed. Error: ${err.message}`);
            }
          }
          step++;
        }
      }
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
