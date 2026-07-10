import { useState, useEffect, useRef } from "react";
import { TaskModel, type UIAgent, type UISubtask, type UIArtifact, type UITask } from "../models/TaskModel";
import { useLogState } from "./useLogState";
import { useApprovalState } from "./useApprovalState";
import { formatAgentLifecycleNotice } from "../utils/agentWorkspace";

export function useTaskViewModel() {
  const [goal, setGoal] = useState("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [agents, setAgents] = useState<UIAgent[]>([]);
  const [subtasks, setSubtasks] = useState<UISubtask[]>([]);
  const [artifacts, setArtifacts] = useState<UIArtifact[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [success, setSuccess] = useState<boolean | null>(null);
  const [tasks, setTasks] = useState<UITask[]>([]);
  const [channelTopic, setChannelTopic] = useState<string | null>(null);
  // Casual conversation with @orchestrator (the "#general" channel). These
  // exchanges never create a task, a UUID channel, or a plan.
  const [chatMessages, setChatMessages] = useState<
    Array<{ id: string; sender: string; content: string; time: string }>
  >([]);

  // Controls the shared API-key modal. "funds" is set automatically when a run
  // stops for lack of balance; "manual" is opened from the Settings button.
  const [apiKeyPrompt, setApiKeyPrompt] = useState<null | "funds" | "manual">(
    null,
  );

  // Delegate Logging Responsibility
  const { logs, addLog, clearLogs } = useLogState();

  // Delegate Approval Responsibility
  const { pendingApproval, setPendingApproval, resolveApproval } = useApprovalState(taskId, addLog);

  const unsubscribeRef = useRef<(() => void) | null>(null);
  const agentsRef = useRef<UIAgent[]>([]);

  const loadTasks = async () => {
    try {
      const list = await TaskModel.listTasks();
      setTasks(list || []);
    } catch (err) {
      console.error("Failed to load tasks:", err);
    }
  };

  useEffect(() => {
    loadTasks();
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }
    };
  }, []);

  const startTask = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!goal.trim() || running || awaitingConfirmation) return;

    // Conversational NLP gate: greetings/small talk get an orchestrator chat
    // reply and stop here — no task folder, no UUID channel, no plan.
    const submitted = goal;
    try {
      const route = await TaskModel.routeUserMessage(submitted);
      if (route.kind === "conversation") {
        const now = new Date().toLocaleTimeString();
        setChatMessages((prev) => [
          ...prev,
          { id: `chat-user-${prev.length}`, sender: "User", content: submitted, time: now },
          { id: `chat-orch-${prev.length}`, sender: "@orchestrator", content: route.reply, time: now },
        ]);
        setGoal("");
        return;
      }
    } catch {
      // Classifier unavailable — fall through and treat the message as work.
    }

    // Reset previous states
    setTaskId(null);
    setSubtasks([]);
    setAgents([]);
    agentsRef.current = [];
    clearLogs();
    setPendingApproval(null);
    setArtifacts([]);
    setSummary(null);
    setSuccess(null);
    setChannelTopic(null);
    setRunning(true);
    setAwaitingConfirmation(false);

    addLog("system", `Submitting task to supervisor: "${goal}"`);

    try {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }

      // 1. Call Model to trigger task
      const newTaskId = await TaskModel.startTask(goal);
      setTaskId(newTaskId);
      addLog("system", `Task initialized. ID: ${newTaskId}. Listening to event stream...`);
      loadTasks(); // Update list immediately once startTask runs and task gets created

      // 2. Subscribe to Model events and delegate actions
      unsubscribeRef.current = TaskModel.subscribeEvents(
        (eventData) => {
          const { topic, data } = eventData;
          
          if (topic.endsWith("agent_status")) {
            const index = agentsRef.current.findIndex((agent) => agent.id === data.id);
            const previous = index < 0 ? undefined : agentsRef.current[index];
            const nextAgents = index < 0
              ? [...agentsRef.current, data]
              : agentsRef.current.map((agent) => agent.id === data.id ? data : agent);
            agentsRef.current = nextAgents;
            setAgents(nextAgents);

            const lifecycleNotice = formatAgentLifecycleNotice(previous, data);
            if (lifecycleNotice) {
              addLog("system", `[agent-lifecycle] ${lifecycleNotice}`);
            }
          }

          else if (topic.includes("plan_updated")) {
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
            setRunning(false);
            setAwaitingConfirmation(true);
            addLog("orchestrator", "Plan ready for your review. Confirm the mission to begin agent work.");
          }

          else if (topic.endsWith(".thought")) {
            // Reasoning tokens — rendered as collapsible "thinking", not chat.
            addLog("agent", data.content, "thinking");
          }

          else if (topic.endsWith(".tool_requested")) {
            const agentName = topic.split(".").find((p) => p.includes("agent-")) || "agent";
            addLog("agent", `🛠️ ${agentName}: ${data.content}`, "activity");
          }

          else if (topic.includes("topic_updated")) {
            if (data && data.topic) {
              setChannelTopic(data.topic);
              loadTasks(); // Reload so the sidebar channel list picks up the new name
            }
          }

          else if (topic.includes("task-started")) {
            if (data && data.taskId) {
              addLog("system", `Backend Task UUID: ${data.taskId}`);
              loadTasks(); // Reload to capture any backend changes
            }
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
          setAwaitingConfirmation(false);
          // Surface the final answer as an assistant chat message. On failure
          // the recovery banner carries the error instead, so skip it here.
          if (resultData.success && resultData.summary) {
            addLog("orchestrator", resultData.summary, "response");
          }
          if (resultData.reason === "insufficient_funds") {
            addLog("system", "⚠️ API account is out of funds — update your key or add credit.");
            setApiKeyPrompt("funds");
          }
          loadTasks(); // Reload list to show final status

          if (unsubscribeRef.current) {
            unsubscribeRef.current();
            unsubscribeRef.current = null;
          }
        }
      );

    } catch (err: any) {
      addLog("system", `Error: ${err.message}`);
      setRunning(false);
      setAwaitingConfirmation(false);
    }
  };

  /**
   * Permanently purge a mission channel. If it's the one currently open,
   * detach from its event stream and reset local state — deleting it does
   * not stop in-flight agent work (no abort primitive exists yet), it only
   * stops the UI from listening to and persisting further updates from it.
   */
  const deleteTask = async (idToDelete: string) => {
    await TaskModel.deleteTask(idToDelete);
    if (idToDelete === taskId) {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      setTaskId(null);
      setRunning(false);
      setAwaitingConfirmation(false);
      setAgents([]);
      agentsRef.current = [];
      setSubtasks([]);
      setArtifacts([]);
      setSummary(null);
      setSuccess(null);
      setChannelTopic(null);
      setPendingApproval(null);
      clearLogs();
    }
    await loadTasks();
  };

  const confirmPlan = async () => {
    if (!taskId || running || !awaitingConfirmation) return;
    setAwaitingConfirmation(false);
    setRunning(true);
    addLog("system", "Mission confirmed. Orchestrator is starting the approved plan.");
    try {
      await TaskModel.confirmTask(taskId);
      loadTasks();
    } catch (err: any) {
      addLog("system", `Unable to start approved mission: ${err.message}`);
      setRunning(false);
      setAwaitingConfirmation(true);
    }
  };

  return {
    goal,
    setGoal,
    taskId,
    setTaskId,
    running,
    awaitingConfirmation,
    agents,
    subtasks,
    logs,
    pendingApproval,
    artifacts,
    summary,
    success,
    channelTopic,
    chatMessages,
    startTask,
    confirmPlan,
    resolveApproval,
    deleteTask,
    tasks,
    loadTasks,
    apiKeyPrompt,
    setApiKeyPrompt,
  };
}
export type TaskViewModel = ReturnType<typeof useTaskViewModel>;
