import type { IBus, IStore } from "@yaaa/interfaces";
import { container } from "@yaaa/platform";
import { type AgentRun, type Subtask, type TaskPlan, type LedgerEntry, isInsufficientFundsError } from "@yaaa/shared";
import { InnerLoop } from "./inner-loop.js";

const AGENT_DISPLAY_NAMES = ["Sage", "Quill", "Harbor", "Nova", "Rowan", "Cedar"];

export class OuterLoop {
  private bus: IBus;
  private store: IStore;
  private innerLoop: InnerLoop;

  constructor() {
    this.bus = container.resolve<IBus>("IBus");
    this.store = container.resolve<IStore>("IStore");
    this.innerLoop = new InnerLoop();
  }

  private selectTemplate(subtask: Subtask): "FilesAgent" | "VerifierAgent" {
    return subtask.capability === "verify" ? "VerifierAgent" : "FilesAgent";
  }

  private createAgentRun(taskId: string, subtask: Subtask, step: number): AgentRun {
    const displayName = AGENT_DISPLAY_NAMES[(step - 1) % AGENT_DISPLAY_NAMES.length];
    const templateName = this.selectTemplate(subtask);
    return {
      id: `${subtask.capability}-agent-${Math.random().toString(36).slice(2, 6)}`,
      handle: `@${displayName.toLowerCase()}-${step}`,
      displayName,
      taskId,
      subtaskId: subtask.id,
      role: templateName,
      modelRole: templateName === "VerifierAgent" ? "verifier" : "worker",
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
          nextStepStrategy: `Spawning FilesAgent to execute subtask: ${subtask.title}`
        };
        await this.store.saveLedgerEntry(taskId, ledgerEntry);

        await this.bus.publish(`task.${taskId}.started`, {
          kind: "status",
          from: "orchestrator",
          taskId,
          state: "working",
          note: `Starting subtask: ${subtask.title}`
        });

        const agent = this.createAgentRun(taskId, subtask, step);
        const templateName = this.selectTemplate(subtask);
        await this.recordAgentLifecycle(agent);

        try {
          const result = await this.innerLoop.run({
            agentId: agent.id,
            taskId,
            templateName,
            instruction: `${subtask.title}. Goal: ${subtask.successCriteria}`,
            contextArtifacts: facts.map((f) => `Fact: ${f}`),
          });

          // Mark subtask as complete
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
          subtaskStates[subtask.id] = "failed";
          facts.push(`Subtask ${subtask.id} failed. Error: ${err.message}`);

          agent.status = "failed";
          agent.finishedAt = new Date().toISOString();
          agent.summary = err.message;
          await this.recordAgentLifecycle(agent);

          // Re-evaluate strategy or retry
          console.error(`Subtask ${subtask.id} failed:`, err);
        }

        step++;
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
