import React, { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { MicroTask, SubTask, TaskItemState, TaskListEvent, TaskListHandle, TaskListProps } from "./interfaces/task-list.interfaces";
import "./task-list.css";

export const TaskList = forwardRef<TaskListHandle, TaskListProps>(function TaskList({ initialSubtasks = [], className = "", onEvent }, ref) {
  const [subtasks, setSubtasks] = useState(initialSubtasks);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const emit = (event: TaskListEvent) => onEventRef.current?.(event);
  const init = (next: SubTask[]) => setSubtasks(next);
  const addSubtask = (subtask: SubTask) => { setSubtasks((current) => [...current.filter((item) => item.id !== subtask.id), subtask]); emit({ kind: "subtask-add", subtask }); };
  const updateSubtask = (id: string, patch: Partial<Omit<SubTask, "id">>) => { let updated: SubTask | undefined; setSubtasks((current) => current.map((item) => { if (item.id !== id) return item; updated = { ...item, ...patch }; return updated; })); emit({ kind: "subtask-update", subtaskId: id, patch, subtask: updated }); };
  const completeSubtask = (id: string) => { let completed: SubTask | undefined; setSubtasks((current) => current.map((item) => { if (item.id !== id) return item; completed = { ...item, state: "completed" }; return completed; })); emit({ kind: "subtask-complete", subtaskId: id, subtask: completed }); };
  const deleteSubtask = (id: string) => { setSubtasks((current) => current.filter((item) => item.id !== id)); emit({ kind: "subtask-delete", subtaskId: id }); };
  const updateMicroTasks = (subtaskId: string, updater: (microTasks: MicroTask[]) => MicroTask[]) => setSubtasks((current) => current.map((item) => item.id === subtaskId ? { ...item, microTasks: updater(item.microTasks ?? []) } : item));
  const addMicroTask = (subtaskId: string, microTask: MicroTask) => { updateMicroTasks(subtaskId, (current) => [...current.filter((item) => item.id !== microTask.id), microTask]); emit({ kind: "microtask-add", subtaskId, microTask }); };
  const updateMicroTask = (subtaskId: string, microTaskId: string, patch: Partial<Omit<MicroTask, "id">>) => { let updated: MicroTask | undefined; updateMicroTasks(subtaskId, (current) => current.map((item) => { if (item.id !== microTaskId) return item; updated = { ...item, ...patch }; return updated; })); emit({ kind: "microtask-update", subtaskId, microTaskId, patch, microTask: updated }); };
  const completeMicroTask = (subtaskId: string, microTaskId: string) => { let completed: MicroTask | undefined; updateMicroTasks(subtaskId, (current) => current.map((item) => { if (item.id !== microTaskId) return item; completed = { ...item, state: "completed" }; return completed; })); emit({ kind: "microtask-complete", subtaskId, microTaskId, microTask: completed }); };
  const deleteMicroTask = (subtaskId: string, microTaskId: string) => { updateMicroTasks(subtaskId, (current) => current.filter((item) => item.id !== microTaskId)); emit({ kind: "microtask-delete", subtaskId, microTaskId }); };
  useImperativeHandle(ref, () => ({ init, addSubtask, updateSubtask, completeSubtask, deleteSubtask, addMicroTask, updateMicroTask, completeMicroTask, deleteMicroTask }), []);
  return <section className={`v2-task-list ${className}`} aria-label="Subtasks and micro tasks"><div className="v2-task-list-heading"><span>Tasks</span><small>{subtasks.filter((item) => item.state === "completed").length}/{subtasks.length}</small></div>{subtasks.length === 0 ? <div className="v2-task-list-empty">No subtasks yet.</div> : <div className="v2-task-list-scroll">{subtasks.map((subtask) => <SubTaskRow key={subtask.id} subtask={subtask} />)}</div>}</section>;
});

function getStateLabel(state: TaskItemState) { return state === "pending" ? "Not started" : state === "running" ? "In progress" : state[0].toUpperCase() + state.slice(1); }
function SubTaskRow({ subtask }: { subtask: SubTask }) {
  const microTasks = subtask.microTasks ?? [];
  const completed = microTasks.filter((item) => item.state === "completed").length;
  const effectiveState = microTasks.length > 0 && completed === microTasks.length ? "completed" : subtask.state;
  const percent = microTasks.length > 0 ? Math.round((completed / microTasks.length) * 100) : effectiveState === "completed" ? 100 : 0;
  const stateLabel = getStateLabel(effectiveState);
  return <article className={`v2-task-list-item is-${effectiveState}`}><div className="v2-task-list-dot-column"><span className={`v2-task-list-status-dot is-${effectiveState}`} aria-label={`${stateLabel} subtask`} />{microTasks.length > 0 && <span className="v2-task-list-active-line" />}</div><div className="v2-task-list-body"><div className="v2-task-list-title-row"><div className="v2-task-list-title"><span className="v2-task-list-id">[{subtask.id}]</span>{subtask.title}</div></div><div className="v2-task-list-meta">{(subtask.roles ?? []).map((role) => <span key={role}>{role}</span>)}{(subtask.capabilities ?? []).map((capability) => <span key={capability}>{capability}</span>)}<span className={`v2-task-list-state is-${effectiveState}`}>{stateLabel}</span>{microTasks.length > 0 && <span className="v2-task-list-state">{completed}/{microTasks.length} micro tasks ({percent}%)</span>}</div><div className="v2-task-list-progress"><span style={{ width: `${percent}%` }} /></div>{microTasks.length > 0 && <div className="v2-task-list-micro-list">{microTasks.map((microTask) => <div className={`v2-task-list-micro-item is-${microTask.state}`} key={microTask.id}><span className="v2-task-list-micro-icon">{microTask.state === "completed" ? "✓" : microTask.state === "running" ? "⚡" : microTask.state === "failed" ? "!" : "○"}</span><span><strong>{microTask.id}:</strong> {microTask.title}</span><span className={`v2-task-list-micro-state is-${microTask.state}`}>{getStateLabel(microTask.state)}</span></div>)}</div>}</div></article>;
}
