import crypto from "node:crypto";
import type { IBus, IStore } from "@yaaa/interfaces";
import { container, type Container } from "@yaaa/platform";
import { OuterLoop } from "@yaaa/agents";
import type { TaskPlan } from "@yaaa/shared";
import { Planner, type PlanContext } from "./planner.js";
import { Synthesizer } from "./synthesizer.js";

function isInternalArtifact(path: string): boolean {
  return /(?:^|\/)(?:handsOn|handOff|proofOfWork|incompleteWork)\.md$/i.test(path);
}

function userFacingSummary(summary: string): string {
  const clean = summary
    .replace(/```yaaa-viewer[\s\S]*?```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean.length > 900 ? `${clean.slice(0, 897).trimEnd()}…` : clean;
}

export class Supervisor {
  private planner: Planner;
  private outerLoop: OuterLoop;
  private synthesizer: Synthesizer;
  private bus: IBus;
  private store: IStore;

  constructor(scope: Container = container) {
    this.planner = new Planner(scope);
    this.outerLoop = new OuterLoop(scope);
    this.synthesizer = new Synthesizer(scope);
    this.bus = scope.resolve<IBus>("IBus");
    this.store = scope.resolve<IStore>("IStore");
  }

  /** Generate a durable plan without permitting agent execution. */
  async createPlan(goal: string, taskId?: string, context?: PlanContext): Promise<TaskPlan> {
    const activeTaskId = taskId || crypto.randomUUID();
    await this.store.initTaskDb(activeTaskId);

    console.log(`[Orchestrator] Generating strategy for goal: "${goal}"`);
    const plan = await this.planner.plan(goal, activeTaskId, context);
    await this.store.savePlan(activeTaskId, plan);
    await this.bus.publish( `task.${activeTaskId}.plan_updated`, plan);

    console.log("\n[Orchestrator] Task Strategy Generated:");
    for (const subtask of plan.subtasks) {
      console.log(` - [${subtask.id}] ${subtask.title} (Capability: ${subtask.capability}, Depends: [${subtask.dependsOn.join(", ")}])`);
    }
    console.log("");

    return plan;
  }

  /** Execute a plan only after the caller has approved it. */
  async runPlan(plan: TaskPlan, taskId?: string): Promise<{ success: boolean; summary: string; plan: TaskPlan }> {
    const activeTaskId = taskId || crypto.randomUUID();
    await this.store.initTaskDb(activeTaskId);

    try {
      await this.outerLoop.run(activeTaskId, plan);
      
      // 3. Synthesize and verify
      console.log("[Orchestrator] Executed all tasks. Running final verification pass...");
      const result = await this.synthesizer.synthesize(activeTaskId, plan);
      
      const messages = await this.store.getMessages(activeTaskId);
      const resultMessages = messages.filter((m) => m.kind === "result");
      const allArtifacts = resultMessages.flatMap((m: any) => m.artifacts || []);

      const deliverablePaths = [...new Set(
        allArtifacts
          .map((art: any) => String(art.path ?? ""))
          .filter((path) => path && !isInternalArtifact(path)),
      )];
      const conciseSummary = userFacingSummary(result.summary);
      const summaryWithFiles = deliverablePaths.length
        ? `${conciseSummary}\n\nFiles: ${deliverablePaths.join(", ")}`
        : conciseSummary;

      let viewerBlocks = "";
      const seen = new Set<string>();
      for (const art of allArtifacts) {
        if (!art.path || seen.has(art.path)) continue;
        seen.add(art.path);
        const type = inferViewerKind(art.path);
        if (type) {
          const spec = {
            type,
            source: { path: art.path },
            display: "auto",
            title: art.path.split("/").pop() || art.path,
          };
          viewerBlocks += `\n\n\`\`\`yaaa-viewer\n${JSON.stringify(spec)}\n\`\`\``;
        }
      }

      await this.bus.publish(`task.${activeTaskId}.completed`, {
        kind: "status",
        from: "orchestrator",
        taskId: activeTaskId,
        state: "done",
        note: `Goal achieved. Summary: ${summaryWithFiles}${viewerBlocks}`
      });

      return {
        success: result.passed,
        summary: `${summaryWithFiles}${viewerBlocks}`,
        plan,
      };
    } catch (err: any) {
      console.error(`[Orchestrator] Execution failed:`, err);
      
      await this.bus.publish(`task.${activeTaskId}.failed`, {
        kind: "status",
        from: "orchestrator",
        taskId: activeTaskId,
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

  /** Backwards-compatible one-shot lifecycle for non-interactive clients. */
  async runTask(goal: string, taskId?: string): Promise<{ success: boolean; summary: string; plan: TaskPlan }> {
    const plan = await this.createPlan(goal, taskId);
    return this.runPlan(plan, taskId);
  }
}

/** Infer the viewer kind based on file extension. */
function inferViewerKind(filePath: string): string | null {
  if (/\.(md|markdown)$/i.test(filePath)) return "markdown";
  if (/\.pdf$/i.test(filePath)) return "pdf";
  if (/\.pptx$/i.test(filePath)) return "pptx";
  if (/\.(xlsx|xls|xlsm|csv|tsv)$/i.test(filePath)) return "spreadsheet";
  if (/\.(txt|py|js|jsx|ts|tsx|json|ya?ml|toml|html?|css|scss|sh|bash|c|cc|cpp|h|hpp|java|go|rs|rb|php|sql|xml|env|ini|cfg|log)$/i.test(filePath)) return "code";
  return null;
}
