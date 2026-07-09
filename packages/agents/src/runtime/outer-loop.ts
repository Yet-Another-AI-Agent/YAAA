import type { IBus, IStore } from "@yaaa/interfaces";
import { container } from "@yaaa/platform";
import { type TaskPlan, type LedgerEntry, type Subtask, isInsufficientFundsError } from "@yaaa/shared";
import { InnerLoop } from "./inner-loop.js";

export class OuterLoop {
  private bus: IBus;
  private store: IStore;
  private innerLoop: InnerLoop;

  constructor() {
    this.bus = container.resolve<IBus>("IBus");
    this.store = container.resolve<IStore>("IStore");
    this.innerLoop = new InnerLoop();
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

        // Spawn Worker
        const agentId = `${subtask.capability}-agent-${Math.random().toString(36).substr(2, 4)}`;
        
        try {
          // Choose appropriate template
          const templateName = subtask.capability === "verify" ? "VerifierAgent" : "FilesAgent";
          
          const result = await this.innerLoop.run({
            agentId,
            taskId,
            templateName,
            instruction: `${subtask.title}. Goal: ${subtask.successCriteria}`,
            contextArtifacts: facts.map((f) => `Fact: ${f}`),
          });

          // Mark subtask as complete
          subtaskStates[subtask.id] = "completed";
          facts.push(`Subtask ${subtask.id} finished. Summary: ${result.summary || JSON.stringify(result)}`);
          
        } catch (err: any) {
          // Out-of-funds is non-recoverable: abort the whole run immediately so
          // the caller can prompt the user to update their key / add credit,
          // rather than churning through every subtask with the same failure.
          if (isInsufficientFundsError(err)) {
            throw err;
          }
          subtaskStates[subtask.id] = "failed";
          facts.push(`Subtask ${subtask.id} failed. Error: ${err.message}`);

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
