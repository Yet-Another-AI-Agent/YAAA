import type { IBus, IStore } from "@yaaa/interfaces";
import { container } from "@yaaa/platform";
import { OuterLoop } from "@yaaa/agents";
import { Planner } from "./planner.js";
import { Synthesizer } from "./synthesizer.js";

export class Supervisor {
  private planner: Planner;
  private outerLoop: OuterLoop;
  private synthesizer: Synthesizer;
  private bus: IBus;
  private store: IStore;

  constructor() {
    this.planner = new Planner();
    this.outerLoop = new OuterLoop();
    this.synthesizer = new Synthesizer();
    this.bus = container.resolve<IBus>("IBus");
    this.store = container.resolve<IStore>("IStore");
  }

  async runTask(goal: string): Promise<{ success: boolean; summary: string; plan: any }> {
    const taskId = `task-${Date.now()}`;
    await this.store.initTaskDb(taskId);

    // 1. Generate plan
    console.log(`[Orchestrator] Generating plan for goal: "${goal}"`);
    const plan = await this.planner.plan(goal);
    
    // Log plan generated
    await this.bus.publish( `task.${taskId}.plan_updated`, plan);

    console.log("\n[Orchestrator] Task Plan Generated:");
    for (const subtask of plan.subtasks) {
      console.log(` - [${subtask.id}] ${subtask.title} (Capability: ${subtask.capability}, Depends: [${subtask.dependsOn.join(", ")}])`);
    }
    console.log("");

    // 2. Run execution
    try {
      await this.outerLoop.run(taskId, plan);
      
      // 3. Synthesize and verify
      console.log("[Orchestrator] Executed all tasks. Running final verification pass...");
      const result = await this.synthesizer.synthesize(taskId, plan);
      
      await this.bus.publish(`task.${taskId}.completed`, {
        kind: "status",
        from: "orchestrator",
        taskId,
        state: "done",
        note: `Goal achieved. Summary: ${result.summary}`
      });

      return {
        success: result.passed,
        summary: result.summary,
        plan,
      };
    } catch (err: any) {
      console.error(`[Orchestrator] Execution failed:`, err);
      
      await this.bus.publish(`task.${taskId}.failed`, {
        kind: "status",
        from: "orchestrator",
        taskId,
        state: "blocked",
        note: `Task execution failed: ${err.message}`
      });

      return {
        success: false,
        summary: `Execution failed: ${err.message}`,
        plan,
      };
    }
  }
}
