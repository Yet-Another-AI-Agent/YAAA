import { useState, useEffect, useRef } from "react";
import { TaskModel, type UIAgent, type UISubtask, type UIArtifact, type UITask } from "../models/TaskModel";
import { useLogState } from "./useLogState";
import { useApprovalState } from "./useApprovalState";
import { formatAgentLifecycleNotice } from "../utils/agentWorkspace";

export interface UIQueuedMessage {
  id: string;
  content: string;
  time: string;
}

export function useTaskViewModel() {
  const [goal, setGoal] = useState("");
  // The mission text actually submitted for the active channel. Kept separate
  // from `goal` so the composer can be cleared on send while the task view
  // still shows the prompt that started the mission.
  const [submittedPrompt, setSubmittedPrompt] = useState("");
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
  const [queuedMessages, setQueuedMessages] = useState<UIQueuedMessage[]>([]);
  // Casual conversation state is no longer used since chats are unified.
  const chatMessages: any[] = [];

  // Controls the shared API-key modal. "funds" is set automatically when a run
  // stops for lack of balance; "manual" is opened from the Settings button.
  const [apiKeyPrompt, setApiKeyPrompt] = useState<null | "funds" | "manual">(
    null,
  );

  // Delegate Logging Responsibility
  const { logs, addLog, clearLogs, clearThoughts } = useLogState();

  // Delegate Approval Responsibility
  const { pendingApproval, setPendingApproval, resolveApproval } = useApprovalState(taskId, addLog);

  const unsubscribeRef = useRef<(() => void) | null>(null);
  const agentsRef = useRef<UIAgent[]>([]);
  const awaitingConfirmationRef = useRef(false);
  const restorePlanReviewAfterFollowupRef = useRef(false);
  const planProposalLoggedRef = useRef<Set<string>>(new Set());
  const queuedMessagesRef = useRef<UIQueuedMessage[]>([]);
  const pickedUpMessageIdsRef = useRef<Set<string>>(new Set());
  const pickedUpMessageContentsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    awaitingConfirmationRef.current = awaitingConfirmation;
  }, [awaitingConfirmation]);

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

  /**
   * Subscribe to the active task's event stream and route events into local
   * state. Shared by startTask (new mission) and continueMission (follow-up on
   * an existing mission), since a completed mission tears its subscription down.
   */
  const attachTaskEventStream = (
    streamTaskId: string | null = taskId,
    options: { replayRecent?: boolean } = {},
  ) => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
    }
    const handleEvent = (eventData: { topic: string; data: any }) => {
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
              if (st.artifacts) {
                producedArtifacts.push(...st.artifacts);
              }
            });
            setArtifacts(producedArtifacts);

            const hasStarted = data.subtasks.some((st: any) => st.state === "running" || st.state === "completed");
            if (!hasStarted) {
              setRunning(false);
              setAwaitingConfirmation(true);
              const planTaskId = topic.match(/^task\.([^.]+)\./)?.[1] ?? streamTaskId ?? "active";
              if (!planProposalLoggedRef.current.has(planTaskId)) {
                planProposalLoggedRef.current.add(planTaskId);
                addLog(
                  "orchestrator",
                  "[plan-proposal] Implementation strategy ready for review.",
                  "response",
                );
              }
            }
          }
        }

        else if (topic.endsWith(".result")) {
          if (data && data.artifacts) {
            setArtifacts((prev) => {
              const existingPaths = new Set(prev.map((a) => a.path));
              const newArtifacts = data.artifacts.filter((a: any) => !existingPaths.has(a.path));
              return [...prev, ...newArtifacts];
            });
          }
          if (data?.incomplete && data.summary) {
            addLog("system", `⏸️ Checkpoint saved — work is incomplete and will continue from this evidence.\n\n${data.summary}`);
          }
        }

        else if (topic.endsWith(".thought")) {
          // Reasoning tokens — rendered as collapsible "thinking", not chat.
          addLog("agent", data.content, "thinking");
        }

        else if (topic.endsWith(".tool_requested")) {
          const agentName = topic.split(".").find((p) => p.includes("agent-")) || "agent";
          addLog("agent", `🛠️ ${agentName}: ${data.content}`, "activity", data.metadata);
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
            const queuedPickup = String(data.note).match(/^📬 Processing queued user message:\s*(.*)$/s);
            if (queuedPickup) {
              const content = queuedPickup[1].trim();
              const queued = queuedMessagesRef.current.find((message) => message.content === content);
              if (queued && !pickedUpMessageIdsRef.current.has(queued.id)) {
                pickedUpMessageIdsRef.current.add(queued.id);
                pickedUpMessageContentsRef.current.add(content);
                queuedMessagesRef.current = queuedMessagesRef.current.filter((message) => message.id !== queued.id);
                setQueuedMessages(queuedMessagesRef.current);
                addLog("user", queued.content, "response");
              } else if (!queued && !pickedUpMessageContentsRef.current.has(content)) {
                // Reopened missions may receive the pickup event without the
                // local optimistic queue state. Still render the user turn.
                addLog("user", content, "response");
              }
              addLog("orchestrator", data.note, "response");
            } else if (!String(data.note).startsWith("Queued —")) {
              // The sticky queue strip owns the queued acknowledgement; do not
              // duplicate it as another chat bubble.
              addLog("orchestrator", data.note, "response");
            }
          }
        }
      };
    unsubscribeRef.current = TaskModel.subscribeEvents(
      handleEvent,
      (approvalData) => {
        const { agentId, toolCall } = approvalData;
        addLog("system", `⚠️ Action paused. Approval required for ${toolCall.capability}.${toolCall.method}`);
        setPendingApproval({ agentId, toolCall });
      },
      (resultData) => {
        const restorePlanReview =
          restorePlanReviewAfterFollowupRef.current &&
          resultData.success &&
          !resultData.summary;
        restorePlanReviewAfterFollowupRef.current = false;
        setSuccess(resultData.success);
        setSummary(resultData.summary);
        setRunning(false);
        setAwaitingConfirmation(restorePlanReview);
        // A queued follow-up is only a transient optimistic UI state. If the
        // backend has finished (or returned to conversation), there is no
        // remaining mailbox item that should keep the strip on screen.
        queuedMessagesRef.current = [];
        setQueuedMessages([]);
        // Surface the final answer as an assistant chat message. On failure
        // the recovery banner carries the error instead, so skip it here.
        if (resultData.success && resultData.summary) {
          clearThoughts();
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
    if (options.replayRecent && streamTaskId) {
      TaskModel.getRecentTaskEvents(streamTaskId)
        .then((events) => {
          for (const event of events || []) handleEvent(event);
        })
        .catch(() => {});
    }
  };

  const startTask = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!goal.trim() || running || awaitingConfirmation) return;

    const submitted = goal;

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
    queuedMessagesRef.current = [];
    pickedUpMessageIdsRef.current.clear();
    pickedUpMessageContentsRef.current.clear();
    setQueuedMessages([]);
    setAwaitingConfirmation(false);
    restorePlanReviewAfterFollowupRef.current = false;
    planProposalLoggedRef.current.clear();

    // Render immediately by setting states and adding user message to logs
    setSubmittedPrompt(submitted);
    setRunning(true);
    setGoal("");
    addLog("user", submitted, "response");

    try {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }

      // 1. Call Model to trigger task
      const newTaskId = await TaskModel.startTask(submitted);
      setTaskId(newTaskId);
      addLog("system", `Task initialized. ID: ${newTaskId}. Listening to event stream...`);
      loadTasks(); // Update list immediately once startTask runs and task gets created

      // 2. Subscribe to Model events and delegate actions
      attachTaskEventStream(newTaskId, { replayRecent: true });

    } catch (err: any) {
      addLog("system", `Error: ${err.message}`);
      setRunning(false);
      setAwaitingConfirmation(false);
    }
  };
  const continueMission = async (message?: string, taskIdOverride?: string) => {
    const text = (message ?? goal).trim();
    const targetTaskId = taskIdOverride ?? taskId;
    if (!targetTaskId || !text) return;
    if (awaitingConfirmationRef.current) {
      let planReviewIntent: "approve" | "reject" | "feedback" = "feedback";
      try {
        planReviewIntent = await TaskModel.classifyPlanReviewIntent(text);
      } catch {
        // Keep the conservative default: uncertain text is plan feedback.
      }
      if (planReviewIntent === "approve") {
        if (targetTaskId !== taskId) setTaskId(targetTaskId);
        restorePlanReviewAfterFollowupRef.current = false;
        setGoal("");
        setSubmittedPrompt(text);
        setAwaitingConfirmation(false);
        setRunning(true);
        addLog("user", "Accepted the implementation plan.", "response");
        addLog("system", "Mission confirmed. YAAA is starting the approved plan.");
        try {
          attachTaskEventStream(targetTaskId);
          await TaskModel.recordPlanReview(targetTaskId, "Accepted the implementation plan.", "user");
          await TaskModel.confirmTask(targetTaskId);
          loadTasks();
        } catch (err: any) {
          addLog("system", `Unable to start approved mission: ${err.message}`);
          setRunning(false);
          setAwaitingConfirmation(true);
        }
        return;
      }
      if (planReviewIntent === "reject") {
        const rejection = `Rejected the implementation plan:\n${text}`;
        addLog("user", rejection, "response");
        addLog("orchestrator", "Understood — I won't start this plan. Send a revised mission or more detail and I'll re-plan.", "response");
        await TaskModel.recordPlanReview(targetTaskId, rejection, "user");
        await TaskModel.recordPlanReview(targetTaskId, "Understood — I won't start this plan. Send a revised mission or more detail and I'll re-plan.", "orchestrator");
        setRunning(false);
        setAwaitingConfirmation(true);
        return;
      }
    }
    const preservePlanReview = awaitingConfirmationRef.current;
    restorePlanReviewAfterFollowupRef.current = preservePlanReview;

    // A task selected after an app restart exists in persistent storage but is
    // not yet the view model's active task. Reactivate that exact mission so
    // the backend continues against its stored conversation and plan history.
    if (targetTaskId !== taskId) {
      setTaskId(targetTaskId);
      clearLogs();
      setArtifacts([]);
    }

    // Clarification-form submissions belong to planning/replanning. They must
    // not be held behind the worker mailbox when the orchestrator is still
    // gathering requirements and no workers have started yet.
    const isQuestionAnswer = /^Answers\s+to\s+your\s+questions\s*:/i.test(text.trim());
    const isActiveMissionFollowUp = running && targetTaskId === taskId && !preservePlanReview && !isQuestionAnswer;

    // A follow-up can be a simple status question while a plan is awaiting
    // review. Keep that plan visible until we know the backend is actually
    // replacing it with a new one.
    if (!preservePlanReview && !isActiveMissionFollowUp) {
      setSubtasks([]);
      setAgents([]);
      agentsRef.current = [];
    }
    setPendingApproval(null);
    setSubmittedPrompt(text);
    setGoal("");
    setSuccess(null);
    setSummary(null);
    setRunning(true);
    setAwaitingConfirmation(preservePlanReview);

    if (isActiveMissionFollowUp) {
      const queuedMessage = {
        id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        content: text,
        time: new Date().toLocaleTimeString(),
      };
      queuedMessagesRef.current = [...queuedMessagesRef.current, queuedMessage];
      setQueuedMessages(queuedMessagesRef.current);
    } else {
      // A new/reopened mission can render its user turn immediately. Active
      // runs wait until the orchestrator pickup event so queued work is not
      // shown twice or out of order.
      addLog("user", text, "response");
      addLog("system", "YAAA is reviewing your follow-up and continuing this mission in the same channel.");
    }

    try {
      attachTaskEventStream(targetTaskId);
      const result = await TaskModel.continueTask(targetTaskId, text);
      loadTasks();
      if (result?.status === "conversation") {
        queuedMessagesRef.current = queuedMessagesRef.current.filter((message) => message.content !== text);
        setQueuedMessages(queuedMessagesRef.current);
        setRunning(false);
        setAwaitingConfirmation(preservePlanReview);
      }
    } catch (err: any) {
      addLog("system", `Error: ${err.message}`);
      setRunning(false);
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

  const confirmPlan = async (comments?: string, taskIdOverride?: string) => {
    const targetTaskId = taskIdOverride ?? taskId;
    if (!targetTaskId || running || (!awaitingConfirmation && !taskIdOverride)) return;
    if (targetTaskId !== taskId) {
      setTaskId(targetTaskId);
      attachTaskEventStream();
    }
    setAwaitingConfirmation(false);
    setRunning(true);
    const trimmedComments = comments?.trim();

    if (trimmedComments) {
      // User has comments → silently replan incorporating the feedback
      addLog("user", `Accepted plan with comments:\n${trimmedComments}`, "response");
      addLog("system", "⟳ Incorporating your feedback and regenerating the plan automatically…");
      try {
        await TaskModel.recordPlanReview(
          targetTaskId,
          `Accepted the implementation plan with comments:\n${trimmedComments}`,
          "user",
        );
        await TaskModel.rePlanWithFeedback(targetTaskId, trimmedComments);
        loadTasks();
      } catch (err: any) {
        addLog("system", `Unable to replan: ${err.message}`);
        setRunning(false);
        setAwaitingConfirmation(true);
      }
    } else {
      // No comments → proceed with the current plan as-is
      const decisionMessage = "Accepted the implementation plan.";
      addLog("user", decisionMessage, "response");
      addLog("system", "Mission confirmed. YAAA is starting the approved plan.");
      try {
        await TaskModel.recordPlanReview(targetTaskId, decisionMessage, "user");
        await TaskModel.confirmTask(targetTaskId);
        loadTasks();
      } catch (err: any) {
        addLog("system", `Unable to start approved mission: ${err.message}`);
        setRunning(false);
        setAwaitingConfirmation(true);
      }
    }
  };

  /**
   * Reject the proposed plan with a required reason. There is no backend
   * re-plan primitive yet, so this records the rejection reason as YAAA
   * feedback and keeps the plan in review so the user can revise and resubmit.
   */
  const rejectPlan = async (reason: string, taskIdOverride?: string) => {
    const targetTaskId = taskIdOverride ?? taskId;
    if (!targetTaskId || (!awaitingConfirmation && !taskIdOverride)) return;
    const trimmed = (reason || "").trim();
    if (!trimmed) return;
    if (targetTaskId !== taskId) setTaskId(targetTaskId);
    setAwaitingConfirmation(true);
    const rejection = `Rejected the implementation plan:\n${trimmed}`;
    const reply = "Understood — I won't start this plan. Send a revised mission or more detail and I'll re-plan.";
    addLog("user", rejection, "response");
    addLog("orchestrator", reply, "response");
    await TaskModel.recordPlanReview(targetTaskId, rejection, "user");
    await TaskModel.recordPlanReview(targetTaskId, reply, "orchestrator");
  };

  return {
    goal,
    setGoal,
    submittedPrompt,
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
    queuedMessages,
    chatMessages,
    startTask,
    continueMission,
    confirmPlan,
    rejectPlan,
    resolveApproval,
    deleteTask,
    tasks,
    loadTasks,
    apiKeyPrompt,
    setApiKeyPrompt,
  };
}
export type TaskViewModel = ReturnType<typeof useTaskViewModel>;
