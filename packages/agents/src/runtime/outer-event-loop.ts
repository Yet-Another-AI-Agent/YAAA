import crypto from "node:crypto";
import type { IBus, IStore } from "@yaaa/interfaces";
import { container, type Container, pauseController } from "@yaaa/platform";
import type {
  OuterLoopLifecycleState,
  OuterLoopStateTransition,
  Subtask,
  TaskPlan,
  WALRecord,
} from "@yaaa/shared";
import { DBEngine } from "@yaaa/providers";
import { CustomInnerLoop, type CustomWorkerOptions } from "./custom-inner-loop.js";

export interface OuterEventLoopConfig {
  maxParallelAgents?: number;
}

export class OuterEventLoop {
  private bus: IBus;
  private store: IStore;
  private dbEngine: DBEngine;
  private innerLoop: CustomInnerLoop;
  private currentState: OuterLoopLifecycleState = "CHAT_SPACE_ACTIVE";
  private activeSubtasks = new Map<string, Promise<any>>();

  constructor(scope: Container = container, config: OuterEventLoopConfig = {}) {
    this.bus = scope.resolve<IBus>("IBus");
    this.store = scope.resolve<IStore>("IStore");
    this.dbEngine = scope.resolve<DBEngine>("DBEngine");
    this.innerLoop = new CustomInnerLoop(scope);
  }

  getCurrentState(): OuterLoopLifecycleState {
    return this.currentState;
  }

  /**
   * Transitions the Outer Loop lifecycle state and handles state actions.
   */
  async transitionState(taskId: string, newState: OuterLoopLifecycleState, reason: string): Promise<void> {
    const oldState = this.currentState;
    if (oldState === newState) return;

    this.currentState = newState;
    const transition: OuterLoopStateTransition = {
      from: oldState,
      to: newState,
      reason,
      timestamp: new Date().toISOString(),
    };

    const outerDb = this.dbEngine.getOuterLoopDb(taskId);
    const seq = this.dbEngine.getLastWALSequence(outerDb, taskId) + 1;

    // Log WAL record for state transition
    this.dbEngine.writeWALRecord(outerDb, {
      id: crypto.randomUUID(),
      entityId: taskId,
      sequence: seq,
      type: "STATE_TRANSITION",
      payload: transition as any,
      timestamp: new Date().toISOString(),
    });

    // Handle State Actions
    if (newState === "BACKGROUND_ISOLATED") {
      // Isolate UI notifications, continue execution in background
      await this.bus.publish(`task.${taskId}.started`, {
        kind: "status",
        from: "orchestrator",
        taskId,
        state: "working",
        note: `Outer Loop isolated into background mode: ${reason}. Subtask execution continuing.`,
      });
    } else if (newState === "GOING_HOME_SUSPENDED") {
      // Pause all subtasks gracefully and flush WAL
      pauseController.pause(taskId);
      this.dbEngine.walCheckpoint(outerDb, "TRUNCATE");
      await this.bus.publish(`task.${taskId}.started`, {
        kind: "status",
        from: "orchestrator",
        taskId,
        state: "working",
        note: `Outer Loop suspended: ${reason}. State safely checkpointed.`,
      });
    } else if (newState === "CHAT_SPACE_ACTIVE" || newState === "RECOVERING") {
      // Resume pause controller if paused
      pauseController.resume(taskId);
      await this.recoverState(taskId);
    }
  }

  /**
   * Recovers state from Outer Loop WAL DB after process restart or chat space re-entry.
   */
  async recoverState(taskId: string): Promise<TaskPlan | null> {
    const outerDb = this.dbEngine.getOuterLoopDb(taskId);
    const records = this.dbEngine.getWALRecords(outerDb, taskId);

    const plan = await this.store.getPlan(taskId);
    await this.bus.publish(`task.${taskId}.started`, {
      kind: "status",
      from: "orchestrator",
      taskId,
      state: "working",
      note: `Outer Loop recovered state from ${records.length} WAL log entries. Chat Space active.`,
    });

    return plan;
  }

  /**
   * Runs a complete Task Plan through the Outer Event Loop.
   */
  async runPlan(taskId: string, plan: TaskPlan): Promise<{ completed: boolean; summary: string }> {
    const outerDb = this.dbEngine.getOuterLoopDb(taskId);
    let seq = this.dbEngine.getLastWALSequence(outerDb, taskId);

    seq++;
    this.dbEngine.writeWALRecord(outerDb, {
      id: crypto.randomUUID(),
      entityId: taskId,
      sequence: seq,
      type: "PLAN_START",
      payload: { subtaskCount: plan.subtasks.length },
      timestamp: new Date().toISOString(),
    });

    await this.store.savePlan(taskId, plan);

    for (const subtask of plan.subtasks) {
      // Check if paused or going home
      await pauseController.waitIfPaused(taskId);

      subtask.state = "running";
      await this.store.savePlan(taskId, plan);

      const agentId = `agent-${subtask.id}-${Date.now()}`;
      const workerOptions: CustomWorkerOptions = {
        agentId,
        taskId,
        templateName: subtask.roles[0] || "PrincipalSweAgent",
        instruction: `${subtask.title}: ${subtask.successCriteria}`,
        model: subtask.model,
      };

      try {
        const workerPromise = this.innerLoop.run(workerOptions);
        this.activeSubtasks.set(subtask.id, workerPromise);

        const result = await workerPromise;
        this.activeSubtasks.delete(subtask.id);

        subtask.state = result.completed ? "completed" : "failed";
        subtask.result = result.summary;
        subtask.artifacts = result.artifacts;

        seq++;
        this.dbEngine.writeWALRecord(outerDb, {
          id: crypto.randomUUID(),
          entityId: taskId,
          sequence: seq,
          type: "SUBTASK_COMPLETED",
          payload: { subtaskId: subtask.id, status: subtask.state, summary: result.summary },
          timestamp: new Date().toISOString(),
        });

        await this.store.savePlan(taskId, plan);
      } catch (err) {
        this.activeSubtasks.delete(subtask.id);
        subtask.state = "failed";
        subtask.result = `Error: ${err instanceof Error ? err.message : String(err)}`;

        seq++;
        this.dbEngine.writeWALRecord(outerDb, {
          id: crypto.randomUUID(),
          entityId: taskId,
          sequence: seq,
          type: "SUBTASK_FAILED",
          payload: { subtaskId: subtask.id, error: subtask.result },
          timestamp: new Date().toISOString(),
        });

        await this.store.savePlan(taskId, plan);
      }
    }

    const allCompleted = plan.subtasks.every((s) => s.state === "completed");
    const summary = allCompleted
      ? `Outer Event Loop successfully completed all ${plan.subtasks.length} subtasks.`
      : `Outer Event Loop completed with failures in subtasks.`;

    seq++;
    this.dbEngine.writeWALRecord(outerDb, {
      id: crypto.randomUUID(),
      entityId: taskId,
      sequence: seq,
      type: "PLAN_FINISHED",
      payload: { completed: allCompleted, summary },
      timestamp: new Date().toISOString(),
    });

    this.dbEngine.walCheckpoint(outerDb, "TRUNCATE");

    return { completed: allCompleted, summary };
  }
}
