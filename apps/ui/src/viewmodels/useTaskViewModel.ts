import { useState, useEffect, useRef } from "react";
import { TaskModel, type UISubtask, type UIArtifact } from "../models/TaskModel";
import { useLogState } from "./useLogState";
import { useApprovalState } from "./useApprovalState";

export function useTaskViewModel() {
  const [goal, setGoal] = useState("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [subtasks, setSubtasks] = useState<UISubtask[]>([]);
  const [artifacts, setArtifacts] = useState<UIArtifact[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [success, setSuccess] = useState<boolean | null>(null);

  // Delegate Logging Responsibility
  const { logs, addLog, clearLogs } = useLogState();

  // Delegate Approval Responsibility
  const { pendingApproval, setPendingApproval, resolveApproval } = useApprovalState(taskId, addLog);

  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }
    };
  }, []);

  const startTask = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!goal.trim() || running) return;

    // Reset previous states
    setTaskId(null);
    setSubtasks([]);
    clearLogs();
    setPendingApproval(null);
    setArtifacts([]);
    setSummary(null);
    setSuccess(null);
    setRunning(true);

    addLog("system", `Submitting task to supervisor: "${goal}"`);

    try {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }

      // 1. Call Model to trigger task
      const newTaskId = await TaskModel.startTask(goal);
      setTaskId(newTaskId);
      addLog("system", `Task initialized. ID: ${newTaskId}. Listening to event stream...`);

      // 2. Subscribe to Model events and delegate actions
      unsubscribeRef.current = TaskModel.subscribeEvents(
        (eventData) => {
          const { topic, data } = eventData;
          
          if (topic.includes("plan_updated")) {
            if (data && data.subtasks) {
              setSubtasks(data.subtasks);
              const producedArtifacts: UIArtifact[] = [];
              data.subtasks.forEach((st: any) => {
                if (st.state === "completed" && st.artifacts) {
                  producedArtifacts.push(...st.artifacts);
                }
              });
              setArtifacts(producedArtifacts);
            }
          }

          else if (topic.endsWith(".thought")) {
            const agentName = topic.split(".").find((p) => p.includes("agent-")) || "agent";
            addLog("agent", `[${agentName}] ${data.content}`);
          }

          else if (topic.endsWith(".tool_requested")) {
            const agentName = topic.split(".").find((p) => p.includes("agent-")) || "agent";
            addLog("agent", `[${agentName}] 🛠️ Requesting tool execution: ${data.content}`);
          }

          else if (topic.includes("started") || topic.includes("completed") || topic.includes("failed")) {
            if (data && data.note) {
              addLog("orchestrator", data.note);
            }
          }
        },
        (approvalData) => {
          const { agentId, toolCall } = approvalData;
          addLog("system", `⚠️ Action paused. Approval required for ${toolCall.capability}.${toolCall.method}`);
          setPendingApproval({ agentId, toolCall });
        },
        (resultData) => {
          setSuccess(resultData.success);
          setSummary(resultData.summary);
          setRunning(false);
          addLog("system", `Task completed. Status: ${resultData.success ? "SUCCESS" : "FAILED"}`);
          
          if (unsubscribeRef.current) {
            unsubscribeRef.current();
            unsubscribeRef.current = null;
          }
        }
      );

    } catch (err: any) {
      addLog("system", `Error: ${err.message}`);
      setRunning(false);
    }
  };

  return {
    goal,
    setGoal,
    taskId,
    running,
    subtasks,
    logs,
    pendingApproval,
    artifacts,
    summary,
    success,
    startTask,
    resolveApproval,
  };
}
export type TaskViewModel = ReturnType<typeof useTaskViewModel>;
