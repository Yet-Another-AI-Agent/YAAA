export type TaskItemState = "pending" | "running" | "completed" | "failed";

export interface MicroTask { id: string; title: string; state: TaskItemState; }
export interface SubTask { id: string; title: string; state: TaskItemState; roles?: string[]; capabilities?: string[]; microTasks?: MicroTask[]; }

export type TaskListEvent =
  | { kind: "subtask-add"; subtask: SubTask }
  | { kind: "subtask-update"; subtaskId: string; patch: Partial<Omit<SubTask, "id">>; subtask?: SubTask }
  | { kind: "subtask-complete"; subtaskId: string; subtask?: SubTask }
  | { kind: "subtask-delete"; subtaskId: string }
  | { kind: "microtask-add"; subtaskId: string; microTask: MicroTask }
  | { kind: "microtask-update"; subtaskId: string; microTaskId: string; patch: Partial<Omit<MicroTask, "id">>; microTask?: MicroTask }
  | { kind: "microtask-complete"; subtaskId: string; microTaskId: string; microTask?: MicroTask }
  | { kind: "microtask-delete"; subtaskId: string; microTaskId: string };

export interface TaskListHandle {
  init: (subtasks: SubTask[]) => void;
  addSubtask: (subtask: SubTask) => void;
  updateSubtask: (id: string, patch: Partial<Omit<SubTask, "id">>) => void;
  completeSubtask: (id: string) => void;
  deleteSubtask: (id: string) => void;
  addMicroTask: (subtaskId: string, microTask: MicroTask) => void;
  updateMicroTask: (subtaskId: string, microTaskId: string, patch: Partial<Omit<MicroTask, "id">>) => void;
  completeMicroTask: (subtaskId: string, microTaskId: string) => void;
  deleteMicroTask: (subtaskId: string, microTaskId: string) => void;
}

export interface TaskListProps { initialSubtasks?: SubTask[]; className?: string; onEvent?: (event: TaskListEvent) => void; }
