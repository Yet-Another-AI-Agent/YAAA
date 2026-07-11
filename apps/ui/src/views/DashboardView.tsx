import { useRef, useEffect, useState, useMemo } from "react";
import logoImg from "../assets/logo.jpg";
import type { TaskViewModel } from "../viewmodels/useTaskViewModel";
import { TaskModel } from "../models/TaskModel";
import { AnnotationOverlay } from "../components/AnnotationOverlay";
import { ArchitectureViewer, getMediaKind } from "../components/ArchitectureViewer";
import { ApiKeyModal } from "../components/ApiKeyModal";
import { MissionInput } from "../components/MissionInput";
import { ThinkingPanel } from "../components/ThinkingPanel";
import {
  getAgentActivity,
  getVisibleLogContent,
  isActiveAgent,
  isAgentLifecycleLog,
} from "../utils/agentWorkspace";
import { renderMarkdown } from "../utils/simpleMarkdown";
import { buildArtifactExplorer } from "../utils/artifactExplorer";
import {
  ORCHESTRATOR_DISPLAY,
  agentIdentity,
  displaySender,
  humanizeChannelName,
  isOrchestratorSender,
} from "../utils/displayNames";
import * as shared from "@yaaa/shared";
const { ORCHESTRATOR_MD_HEADERS } = shared;

interface DashboardViewProps {
  viewModel: TaskViewModel;
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return "Good Morning";
  if (hour >= 12 && hour < 17) return "Good Afternoon";
  if (hour >= 17 && hour < 21) return "Good Evening";
  return "Good Night";
}

const SUGGESTION_CHIPS = [
  "Analyze codebase and write a report",
  "Run my test suite and fix failures",
  "Draft a project summary doc",
  "Search the web for latest AI news",
];

interface ParsedOrchestrator {
  taskId: string;
  prompt: string;
  status: string;
  updatedAt: string;
  planGoal: string;
  subtasks: Array<{
    id: string;
    title: string;
    capability: string;
    state: string;
    successCriteria: string;
    dependencies: string[];
  }>;
  steps: Array<{
    step: string;
    timestamp: string;
    strategy: string;
    facts: string[];
    assumptions: string[];
  }>;
}

function parseOrchestratorMd(content: string | null): ParsedOrchestrator {
  const result: ParsedOrchestrator = {
    taskId: "",
    prompt: "",
    status: "",
    updatedAt: "",
    planGoal: "",
    subtasks: [],
    steps: [],
  };

  if (!content) return result;

  const lines = content.split("\n");
  let currentSection = "";
  let currentSubtask: any = null;
  let currentStep: any = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith("* **Task ID**:")) {
      result.taskId = line.replace("* **Task ID**:", "").trim();
      continue;
    }
    if (line.startsWith("* **Prompt**:")) {
      result.prompt = line.replace("* **Prompt**:", "").trim().replace(/^"|"$/g, "");
      continue;
    }
    if (line.startsWith("* **Status**:")) {
      result.status = line.replace("* **Status**:", "").trim();
      continue;
    }
    if (line.startsWith("* **Updated At**:")) {
      result.updatedAt = line.replace("* **Updated At**:", "").trim();
      continue;
    }

    if (line.startsWith(ORCHESTRATOR_MD_HEADERS.PLAN)) {
      currentSection = "plan";
      continue;
    }
    if (line.startsWith(ORCHESTRATOR_MD_HEADERS.EXECUTION)) {
      currentSection = "ledger";
      continue;
    }

    if (currentSection === "plan") {
      if (line.startsWith("Goal:")) {
        result.planGoal = line.replace("Goal:", "").trim();
      } else if (line.startsWith("- **[")) {
        const match = line.match(/- \*\*\[([^\]]+)\]\*\* (.*)/);
        if (match) {
          currentSubtask = {
            id: match[1],
            title: match[2].trim(),
            capability: "",
            state: "pending",
            successCriteria: "",
            dependencies: [],
          };
          result.subtasks.push(currentSubtask);
        }
      } else if (currentSubtask) {
        if (line.startsWith("- Capability:")) {
          currentSubtask.capability = line.replace("- Capability:", "").trim().replace(/`/g, "");
        } else if (line.startsWith("- Status:")) {
          currentSubtask.state = line.replace("- Status:", "").trim().replace(/`/g, "");
        } else if (line.startsWith("- Success Criteria:")) {
          currentSubtask.successCriteria = line.replace("- Success Criteria:", "").trim().replace(/\*/g, "");
        } else if (line.startsWith("- Dependencies:")) {
          const depsStr = line.replace("- Dependencies:", "").trim();
          const depsMatch = depsStr.match(/\[(.*?)\]/);
          if (depsMatch) {
            currentSubtask.dependencies = depsMatch[1].split(",").map(d => d.trim()).filter(Boolean);
          }
        }
      }
    }

    if (currentSection === "ledger") {
      if (line.startsWith(ORCHESTRATOR_MD_HEADERS.STEP)) {
        const stepNumPart = line.replace(ORCHESTRATOR_MD_HEADERS.STEP, "").trim();
        const match = stepNumPart.match(/^(\d+)\s*\((.*?)\)/);
        if (match) {
          currentStep = {
            step: match[1],
            timestamp: match[2].trim(),
            strategy: "",
            facts: [],
            assumptions: [],
          };
          result.steps.push(currentStep);
        }
      } else if (currentStep) {
        if (line.startsWith(ORCHESTRATOR_MD_HEADERS.STRATEGY)) {
          currentStep.strategy = line.replace(ORCHESTRATOR_MD_HEADERS.STRATEGY, "").trim();
        } else if (line.startsWith("- ") && !line.includes("**")) {
          let foundFacts = false;
          for (let j = i - 1; j >= 0; j--) {
            const prevLine = lines[j].trim();
            if (prevLine.startsWith(ORCHESTRATOR_MD_HEADERS.FACTS)) {
              foundFacts = true;
              break;
            }
            if (prevLine.startsWith(ORCHESTRATOR_MD_HEADERS.ASSUMPTIONS) || prevLine.startsWith(ORCHESTRATOR_MD_HEADERS.STEP)) {
              break;
            }
          }
          if (foundFacts) {
            currentStep.facts.push(line.replace(/^-/, "").trim());
          } else {
            currentStep.assumptions.push(line.replace(/^-/, "").trim());
          }
        }
      }
    }
  }

  return result;
}

function getAvatarColor(sender: string): string {
  if (sender === "User") return "#36c5f0"; // Slack blue
  // YAAA / orchestrator / supervisor all share the purple persona color.
  if (isOrchestratorSender(sender) || sender === ORCHESTRATOR_DISPLAY) return "#4a154b";
  if (sender.toLowerCase().includes("planner")) return "#e01e5a"; // Slack pink
  if (sender.toLowerCase().includes("worker")) return "#2eb67d"; // Slack green
  if (sender.toLowerCase().includes("verifier")) return "#ecb22e"; // Slack yellow
  return "#707070";
}

const CAPABILITY_LABELS: Record<string, string> = {
  docs: "Docs",
  browser: "Web Browser",
  shell: "Shell / Terminal",
  files: "File System",
  integration: "External Integration",
  verify: "Verification",
};

function formatCapabilityLabel(capability: string): string {
  return CAPABILITY_LABELS[capability] || capability;
}

/**
 * Fallback channel name while the LLM topic is still generating. Raw UUIDs
 * (or fragments of them) are strictly forbidden from rendering, so this is a
 * pure prompt slug — never suffixed with the task id.
 */
function formatChannelName(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(" ")
    .substring(0, 40)
    .trim();
  return words || "new mission";
}

/**
 * Files the in-app viewer can render: markdown/plaintext, images, graphTD
 * diagrams, and common source/config text files. Binary office docs
 * (PPT/PDF/Excel) still need a dedicated renderer and are excluded.
 */
function isPreviewableArtifact(artPath: string): boolean {
  return /\.(md|markdown|txt|mmd|mermaid|png|jpe?g|gif|webp|svg|py|js|jsx|ts|tsx|json|ya?ml|toml|html?|css|scss|sh|bash|c|cc|cpp|h|hpp|java|go|rs|rb|php|sql|xml|csv|env|ini|cfg|log)$/i.test(
    artPath,
  );
}

export function DashboardView({ viewModel }: DashboardViewProps) {
  const {
    goal,
    setGoal,
    submittedPrompt,
    taskId,
    setTaskId,
    running,
    awaitingConfirmation,
    agents = [],
    subtasks,
    logs,
    pendingApproval,
    artifacts,
    summary,
    success,
    channelTopic,
    chatMessages = [],
    startTask,
    continueMission,
    confirmPlan,
    rejectPlan,
    resolveApproval,
    deleteTask,
    tasks,
    apiKeyPrompt,
    setApiKeyPrompt,
  } = viewModel;

  const consoleEndRef = useRef<HTMLDivElement>(null);
  const [greeting] = useState(getGreeting());
  const [showTaskView, setShowTaskView] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [chatTab, setChatTab] = useState<"chat" | "agent-space">("chat");

  // Past task selected states
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // Channel id currently showing its inline "confirm delete?" affordance.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Global Delete Workspace button showing its inline confirm affordance.
  const [confirmWorkspaceDelete, setConfirmWorkspaceDelete] = useState(false);
  const [orchestratorMd, setOrchestratorMd] = useState<string | null>(null);
  const [historyMessages, setHistoryMessages] = useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const activeHistoryRequestRef = useRef<string | null>(null);

  // Split-screen artifact preview (Markdown/plaintext only for now).
  const [artifactPreview, setArtifactPreview] = useState<{
    path: string;
    content: string;
    kind?: "text" | "image" | "diagram";
    dataUrl?: string;
  } | null>(null);
  const [artifactPreviewLoading, setArtifactPreviewLoading] = useState(false);
  const [artifactPreviewError, setArtifactPreviewError] = useState<string | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const activeArtifactRequestRef = useRef(0);

  // Plan review modal: view the proposed orchestrator.md, comment on it, then
  // Accept (addressing comments) or Reject (with a required reason).
  const [planReviewOpen, setPlanReviewOpen] = useState(false);
  const [planReviewMd, setPlanReviewMd] = useState<string | null>(null);
  const [planReviewLoading, setPlanReviewLoading] = useState(false);
  const [planComment, setPlanComment] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  // Sub-agent thread currently expanded into the full-screen thread view.
  const [openThreadAgentId, setOpenThreadAgentId] = useState<string | null>(null);

  // User's name from onboarding profile
  const [userName, setUserName] = useState("");

  // Registered MCP servers for the Active Integrations panel.
  const [mcpIntegrations, setMcpIntegrations] = useState<
    Array<{ definition: { id: string; displayName: string }; state: { trust: string; enabled: boolean } }>
  >([]);

  useEffect(() => {
    const activeId = selectedTaskId || taskId || undefined;
    TaskModel.listMcpIntegrations(activeId)
      .then((list) => setMcpIntegrations(list || []))
      .catch(() => setMcpIntegrations([]));
  }, [selectedTaskId, taskId]);

  // Fetch user's name from onboarding profile on mount
  useEffect(() => {
    TaskModel.getOnboardingProfile()
      .then((p) => setUserName(p.name))
      .catch((err) => console.error("Failed to fetch profile:", err));
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    if (consoleEndRef.current && typeof consoleEndRef.current.scrollIntoView === "function") {
      consoleEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, historyMessages, loadingHistory]);

  // Switch to task view once a task starts
  useEffect(() => {
    if (running || taskId) {
      setSelectedTaskId(null);
      setShowTaskView(true);
      setSidebarOpen(false); // Collapsed on start
    }
  }, [running, taskId]);

  // Invalidate preview reads when the visible mission changes. Without this,
  // a slower response from the previous mission can overwrite the new view.
  useEffect(() => {
    activeArtifactRequestRef.current += 1;
    setArtifactPreview(null);
    setArtifactPreviewError(null);
    setArtifactPreviewLoading(false);
  }, [selectedTaskId, taskId]);

  // Fetch orchestrator.md when a task is selected
  useEffect(() => {
    let active = true;
    if (selectedTaskId) {
      (async () => {
        try {
          const content = await TaskModel.readTaskOrchestrator(selectedTaskId);
          if (active) {
            setOrchestratorMd(content);
          }
        } catch (err) {
          console.error("Failed to load orchestrator:", err);
          if (active) {
            setOrchestratorMd(null);
          }
        }
      })();
    } else {
      setOrchestratorMd(null);
    }
    return () => {
      active = false;
    };
  }, [selectedTaskId]);

  // Load the proposed plan (orchestrator.md) for the live task whenever the
  // review modal is opened.
  useEffect(() => {
    let active = true;
    if (planReviewOpen && taskId) {
      setPlanReviewLoading(true);
      setPlanReviewMd(null);
      TaskModel.readTaskOrchestrator(taskId)
        .then((content) => {
          if (active) setPlanReviewMd(content);
        })
        .catch((err) => {
          console.error("Failed to load plan:", err);
          if (active) setPlanReviewMd(null);
        })
        .finally(() => {
          if (active) setPlanReviewLoading(false);
        });
    }
    return () => {
      active = false;
    };
  }, [planReviewOpen, taskId]);

  // Resolve any raw sender key (agent id OR roster handle) back to its agent,
  // so a chat bubble keyed by "@sage-1" and a team card keyed by "agent-research"
  // render as the same person. Names are always seeded on the canonical id.
  const resolveAgent = useMemo(() => {
    const byKey: Record<string, (typeof agents)[number]> = {};
    for (const a of agents) {
      if (a?.id) byKey[a.id] = a;
      if (a?.handle) byKey[a.handle] = a;
    }
    return (raw: string) => byKey[raw];
  }, [agents]);

  const labelForSender = (raw: string): string => {
    if (isOrchestratorSender(raw)) return ORCHESTRATOR_DISPLAY;
    if (raw === "User" || raw === "System" || raw === "Agent") return raw;
    const a = resolveAgent(raw);
    if (a) return agentIdentity(a.id, a.role).display;
    return displaySender(raw);
  };

  const handleChipClick = (chip: string) => {
    setGoal(chip);
  };

  /**
   * Route the channel composer: a live, open mission continues in-channel (no
   * new chat); the home view and archived channels start a fresh mission.
   */
  const handleChannelSend = () => {
    if (taskId && !selectedTaskId) {
      continueMission(goal);
    } else {
      startTask();
    }
  };

  const handleSelectTask = (id: string) => {
    if (id === taskId) {
      setSelectedTaskId(null);
      setShowTaskView(true);
      setSidebarOpen(false); // Collapse sidebar
    } else {
      setSelectedTaskId(id);
      setShowTaskView(false);
      setSidebarOpen(false); // Collapse sidebar

      setLoadingHistory(true);
      activeHistoryRequestRef.current = id;
      TaskModel.getTaskHistory(id)
        .then((msgs) => {
          if (activeHistoryRequestRef.current === id) {
            setHistoryMessages(msgs || []);
          }
        })
        .catch((err) => {
          console.error("Failed to load task history:", err);
          if (activeHistoryRequestRef.current === id) {
            setHistoryMessages([]);
          }
        })
        .finally(() => {
          if (activeHistoryRequestRef.current === id) {
            setLoadingHistory(false);
          }
        });
    }
  };

  const handleDeleteTaskRequest = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteId(id);
  };

  const handleCancelDeleteTask = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteId(null);
  };

  const handleConfirmDeleteTask = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteId(null);
    if (id === selectedTaskId) {
      setSelectedTaskId(null);
      setShowTaskView(false);
    }
    deleteTask(id);
  };

  const handlePreviewArtifact = async (artPath: string) => {
    const activeTaskId = selectedTaskId || taskId;
    if (!activeTaskId) return;
    const requestId = activeArtifactRequestRef.current + 1;
    activeArtifactRequestRef.current = requestId;
    const kind = getMediaKind(artPath);
    setArtifactPreviewError(null);
    setArtifactPreviewLoading(true);
    setArtifactPreview({ path: artPath, content: "", kind });
    try {
      if (kind === "image") {
        const binary = await TaskModel.readArtifactBinary(activeTaskId, artPath);
        if (activeArtifactRequestRef.current !== requestId) return;
        if (!binary) {
          setArtifactPreviewError("Could not read this file.");
        } else {
          setArtifactPreview({ path: artPath, content: "", kind, dataUrl: binary.dataUrl });
        }
      } else {
        const content = await TaskModel.readArtifact(activeTaskId, artPath);
        if (activeArtifactRequestRef.current !== requestId) return;
        if (content === null) {
          setArtifactPreviewError("Could not read this file.");
        } else {
          setArtifactPreview({ path: artPath, content, kind });
        }
      }
    } catch (err: any) {
      if (activeArtifactRequestRef.current !== requestId) return;
      setArtifactPreviewError(err?.message || "Could not read this file.");
    } finally {
      if (activeArtifactRequestRef.current === requestId) {
        setArtifactPreviewLoading(false);
      }
    }
  };

  const handleClosePreview = () => {
    activeArtifactRequestRef.current += 1;
    setArtifactPreview(null);
    setArtifactPreviewError(null);
    setAnnotating(false);
  };

  const handleNewMission = () => {
    setSelectedTaskId(null);
    setShowTaskView(false);
    setGoal("");
    setTaskId(null);
  };

  const handleOpenPlanReview = () => {
    setPlanComment("");
    setRejectReason("");
    setRejecting(false);
    setPlanReviewOpen(true);
  };

  const handleClosePlanReview = () => {
    setPlanReviewOpen(false);
    setRejecting(false);
  };

  const handleAcceptPlan = () => {
    const comment = planComment;
    setPlanReviewOpen(false);
    setRejecting(false);
    setPlanComment("");
    setRejectReason("");
    confirmPlan(comment);
  };

  const handleSubmitReject = () => {
    if (!rejectReason.trim()) return;
    const reason = rejectReason;
    setPlanReviewOpen(false);
    setRejecting(false);
    setRejectReason("");
    setPlanComment("");
    rejectPlan(reason);
  };

  const formatDate = (dateStr: string): string => {
    if (!dateStr) return "";
    try {
      const d = new Date(dateStr);
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };

  // Pre-process display messages, subtasks, and artifacts
  const selectedTask = selectedTaskId ? tasks.find(t => t.id === selectedTaskId) : null;
  // Casual conversation with @orchestrator renders as the #general channel —
  // no task, no UUID, no plan machinery.
  const inConversationView = !selectedTaskId && !showTaskView && chatMessages.length > 0;
  // channelTopic (live event) is the fastest path; the tasks list (refreshed
  // independently via loadTasks) is the fallback if that event arrives after
  // the mission's event subscription has already been torn down.
  const liveTask = taskId ? tasks.find(t => t.id === taskId) : null;
  const currentChannelName = selectedTask
    ? humanizeChannelName(selectedTask.topic || formatChannelName(selectedTask.prompt))
    : (taskId
        ? humanizeChannelName(channelTopic || liveTask?.topic || formatChannelName(submittedPrompt || goal))
        : "general");

  const memoizedData = useMemo(() => {
    let displayMessages: any[] = [];
    let systemLogEntries: any[] = [];
    const parsedOrchestrator = parseOrchestratorMd(orchestratorMd);

    if (inConversationView) {
      // #general — casual chat with @orchestrator; plain bubbles only.
      displayMessages = chatMessages.map((m) => ({ ...m, kind: "message", artifacts: [] }));
    } else if (selectedTaskId) {
      // Prepend user's prompt as the first message
      if (selectedTask) {
        displayMessages.push({
          id: "user-prompt",
          sender: "User",
          time: formatDate(selectedTask.created_at),
          content: selectedTask.prompt,
          kind: "thought"
        });
      } else if (orchestratorMd) {
        displayMessages.push({
          id: "user-prompt",
          sender: "User",
          time: formatDate(parsedOrchestrator.updatedAt),
          content: parsedOrchestrator.prompt || "Start task",
          kind: "thought"
        });
      }

      // Add historical messages
      historyMessages.forEach((msg, idx) => {
        let sender = msg.from || "Agent";
        let content = "";
        let artifactsList = msg.artifacts || [];
        if (msg.kind === "thought") {
          content = msg.content;
        } else if (msg.kind === "result") {
          content = msg.summary;
        } else if (msg.kind === "status") {
          content = msg.note || `State update: ${msg.state}`;
        } else if (msg.kind === "approval_request") {
          content = `Requested approval for tool execution: ${msg.action?.capability}.${msg.action?.method}`;
        } else if (msg.kind === "info_request") {
          content = msg.question;
        } else if (msg.kind === "info_reply") {
          content = msg.answer;
        } else {
          content = typeof msg.data === "string" ? msg.data : JSON.stringify(msg);
        }

        displayMessages.push({
          id: msg.id || `hist-${idx}`,
          sender,
          time: msg.timestamp ? formatDate(msg.timestamp) : "",
          content,
          kind: msg.kind === "thought" ? "thinking" : msg.kind,
          artifacts: artifactsList,
        });
      });
    } else if (showTaskView) {
      // Prepend active task goal
      displayMessages.push({
        id: "user-prompt",
        sender: "User",
        time: new Date().toLocaleTimeString(),
        content: submittedPrompt || goal,
        kind: "thought"
      });

      // Add live logs. Plain system status logs (task IDs, "submitting to
      // supervisor", etc.) are backend noise, not conversation — collect them
      // separately for a single collapsed block instead of individual chat
      // bubbles. Lifecycle notices keep their existing toast rendering, and
      // orchestrator/agent logs remain real bubbles.
      logs.forEach((log) => {
        if (log.source === "system" && !isAgentLifecycleLog(log)) {
          systemLogEntries.push(log);
          return;
        }

        let sender = log.source === "system" ? "System" : (log.source === "orchestrator" ? "Supervisor" : "Agent");
        if (log.kind === "response") sender = "Orchestrator";
        let content = getVisibleLogContent(log.content);
        const agentMatch = log.content.match(/^\[([^\]]+)\] (.*)/);
        if (agentMatch) {
          sender = agentMatch[1];
          content = agentMatch[2];
        }
        displayMessages.push({
          id: log.id,
          sender,
          time: log.time,
          content,
          kind: isAgentLifecycleLog(log) ? "lifecycle" : log.kind,
          artifacts: [],
        });
      });
    }

    const displaySubtasks = selectedTaskId ? parsedOrchestrator.subtasks : subtasks;
    
    const displayArtifacts = selectedTaskId 
      ? historyMessages.reduce((acc: any[], m) => {
          if (m.kind === "result" && m.artifacts) {
            acc.push(...m.artifacts);
          }
          return acc;
        }, [])
      : artifacts;

    const currentStatus = selectedTaskId 
      ? (selectedTask?.status || parsedOrchestrator.status) 
      : (awaitingConfirmation ? "awaiting_confirmation" : (running ? "running" : (success ? "success" : (success === false ? "failed" : "pending"))));

    return {
      displayMessages,
      systemLogEntries,
      displaySubtasks,
      displayArtifacts,
      currentStatus
    };
  }, [
    selectedTaskId,
    selectedTask,
    orchestratorMd,
    historyMessages,
    showTaskView,
    goal,
    submittedPrompt,
    logs,
    subtasks,
    artifacts,
    running,
    awaitingConfirmation,
    success,
    inConversationView,
    chatMessages
  ]);

  const { displayMessages, systemLogEntries, displaySubtasks, displayArtifacts, currentStatus } = memoizedData;
  const artifactGroups = useMemo(() => buildArtifactExplorer(displayArtifacts), [displayArtifacts]);
  const activeAgentCount = agents.filter(isActiveAgent).length;
  // Real capabilities this plan actually uses, replacing what used to be a
  // hardcoded fake Slack/GitHub/Web-Search "connected" list.
  const activeCapabilities = Array.from(new Set(displaySubtasks.map((st) => st.capability).filter(Boolean)));

  // Each spawned agent runs in its own sub-thread. In the main channel we show
  // a compact card (YAAA's handoff + a "Show thread" affordance); the full
  // agent conversation and proof of work live behind the thread overlay.
  const missionThreads = useMemo(() => {
    return agents.map((agent) => {
      const subtask = displaySubtasks.find((s: any) => s.id === agent.subtaskId);
      const activity = getAgentActivity(agent, logs);
      const handoffParts: string[] = [];
      if (subtask?.title) handoffParts.push(subtask.title);
      if ((subtask as any)?.successCriteria) {
        handoffParts.push(`Success criteria: ${(subtask as any).successCriteria}`);
      }
      const handoff = handoffParts.join("\n\n") || agent.summary || "Assignment briefing pending.";
      return { agent, subtask, activity, handoff };
    });
  }, [agents, displaySubtasks, logs]);

  const openThread = openThreadAgentId
    ? missionThreads.find((t) => t.agent.id === openThreadAgentId) || null
    : null;

  // Collapse runs of consecutive "thinking" messages into a single dropdown
  // panel; everything else renders as an individual chat bubble.
  const renderGroups = useMemo(() => {
    const groups: Array<
      | { type: "thinking"; id: string; items: any[] }
      | { type: "message"; id: string; msg: any }
    > = [];
    for (const msg of displayMessages) {
      if (msg.kind === "thinking") {
        const last = groups[groups.length - 1];
        if (last && last.type === "thinking") {
          last.items.push(msg);
        } else {
          groups.push({ type: "thinking", id: msg.id, items: [msg] });
        }
      } else {
        groups.push({ type: "message", id: msg.id, msg });
      }
    }
    return groups;
  }, [displayMessages]);

  return (
    <div className="dash-root fade-in-dashboard">
      {/* ─── SIDEBAR LIST ─── */}
      <div className={`dash-sidebar ${sidebarOpen ? "" : "collapsed"}`}>
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <img src={logoImg} alt="logo" className="sidebar-logo" />
            <span>Missions</span>
          </div>
          <button className="new-mission-btn" onClick={handleNewMission} title="New Mission">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            <span>New</span>
          </button>
        </div>

        <div className="sidebar-list">
          <div className="sidebar-section-title">Channels</div>
          <div className="slack-channel-list">
            {(tasks || []).length === 0 ? (
              <div className="sidebar-empty">No channels</div>
            ) : (
              (tasks || []).map((t) => {
                const isActive = (showTaskView && t.id === taskId) || (selectedTaskId === t.id);
                const isWaiting = t.id === taskId && running && pendingApproval;
                const status = isWaiting ? "waiting" : (t.id === taskId && awaitingConfirmation ? "awaiting_confirmation" : (t.id === taskId && running ? "running" : t.status));
                const channelName = humanizeChannelName(t.topic || formatChannelName(t.prompt));
                return (
                  <div key={t.id} className={`slack-channel-item-row ${isActive ? "active" : ""}`}>
                    <button
                      className={`slack-channel-item ${isActive ? "active" : ""}`}
                      onClick={() => handleSelectTask(t.id)}
                      title={t.prompt}
                    >
                      <span className="slack-hash">#</span>
                      <span className="slack-channel-name">{channelName}</span>
                      <span style={{ display: "none" }}>{t.prompt}</span>
                      <span className={`slack-status-dot ${status}`} />
                    </button>
                    {confirmDeleteId === t.id ? (
                      <div className="slack-channel-delete-confirm">
                        <button
                          className="slack-channel-delete-confirm-btn"
                          onClick={(e) => handleConfirmDeleteTask(t.id, e)}
                          title="Confirm delete"
                          aria-label="Confirm delete"
                        >
                          Delete
                        </button>
                        <button
                          className="slack-channel-delete-cancel-btn"
                          onClick={handleCancelDeleteTask}
                          title="Cancel"
                          aria-label="Cancel delete"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        className="slack-channel-delete-btn"
                        onClick={(e) => handleDeleteTaskRequest(t.id, e)}
                        title="Delete chat"
                        aria-label="Delete chat"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6" />
                          <path d="M14 11v6" />
                          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                        </svg>
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* ─── MAIN CONTENT CONTAINER ─── */}
      <div className="dash-main-container">
        {/* Topbar */}
        <div className="dash-topbar">
          <div className="dash-topbar-left">
            <button className="hamburger-btn" onClick={() => setSidebarOpen(!sidebarOpen)} title="Toggle Sidebar">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="12" x2="21" y2="12"/>
                <line x1="3" y1="6" x2="21" y2="6"/>
                <line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            </button>
          </div>

          <div className="dash-topbar-right">
            {/* Session Management: permanently accessible Delete Workspace control.
                Recursively deletes the active workspace directory, cancels its
                agents, and purges chat/context state. */}
            {confirmWorkspaceDelete ? (
              <div className="workspace-delete-confirm" role="alertdialog" aria-label="Confirm workspace deletion">
                <span className="workspace-delete-confirm-text">Delete workspace, kill agents, and purge history?</span>
                <button
                  className="slack-channel-delete-confirm-btn"
                  title="Confirm delete workspace"
                  onClick={async () => {
                    const activeWorkspaceId = selectedTaskId || taskId;
                    setConfirmWorkspaceDelete(false);
                    if (!activeWorkspaceId) return;
                    setSelectedTaskId(null);
                    setShowTaskView(false);
                    await deleteTask(activeWorkspaceId);
                  }}
                >
                  Delete
                </button>
                <button
                  className="slack-channel-delete-cancel-btn"
                  title="Cancel delete workspace"
                  onClick={() => setConfirmWorkspaceDelete(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="icon-btn workspace-delete-btn"
                title="Delete Workspace"
                aria-label="Delete Workspace"
                disabled={!(selectedTaskId || taskId)}
                onClick={() => setConfirmWorkspaceDelete(true)}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            )}
            <button
              className="icon-btn"
              title="API key settings"
              aria-label="API key settings"
              onClick={() => setApiKeyPrompt("manual")}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
            <div className="avatar-btn" title={userName || "User"} aria-label="User profile">
              K
            </div>
          </div>
        </div>

        {(!selectedTaskId && !showTaskView && !inConversationView) ? (
          /* ─── HOME VIEW ─── */
          <div className="dash-home">
            <div className="dash-hero">
              <div className="dash-brand-row">
                <img src={logoImg} alt="YAAA logo" className="dash-brand-logo" />
                <span className="dash-brand-label">YAAA <span className="dash-brand-sep">·</span> Yet Another AI Agent</span>
              </div>
              <h1 className="dash-greeting">{greeting}, {userName || "there"}.</h1>
            </div>

            {/* Mission Orchestrator Input */}
            <div className="mission-orchestrator">
              <div className="mission-label">MISSION ORCHESTRATOR</div>
              <MissionInput
                value={goal}
                onChange={setGoal}
                onSubmit={() => startTask()}
                running={running || awaitingConfirmation}
                placeholder="What's the mission today?"
              />
              <div className="mission-chips">
                {SUGGESTION_CHIPS.map((chip) => (
                  <button key={chip} className="chip" onClick={() => handleChipClick(chip)}>
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          /* ─── SLACK WORKSPACE CHAT VIEW ─── */
          <div className="slack-chat-view-container">
            {/* Small left nav rail */}
            <div className="chat-rail">
              <button
                className={`chat-rail-item ${chatTab === "chat" ? "active" : ""}`}
                onClick={() => setChatTab("chat")}
                title="Chat"
              >
                <span className="chat-rail-icon" aria-hidden="true">💬</span>
                <span className="chat-rail-label">Chat</span>
              </button>
              <button
                className={`chat-rail-item ${chatTab === "agent-space" ? "active" : ""}`}
                onClick={() => setChatTab("agent-space")}
                title="Agent Space"
              >
                <span className="chat-rail-icon" aria-hidden="true">🧠</span>
                <span className="chat-rail-label">Agent Space</span>
              </button>
            </div>

            {chatTab === "chat" ? (
            /* Middle slack-chat-pane */
            <div className="slack-chat-pane">
              <div className="slack-channel-header">
                <div className="slack-channel-header-title">
                  <span className="slack-hash">#</span>
                  <span>{currentChannelName}</span>
                </div>
              </div>

              <div className="slack-chat-messages">
                {/* Loading state for past task */}
                {selectedTaskId && loadingHistory && (
                  <div className="panel-empty">
                    <div className="thinking-dots">
                      <span /><span /><span />
                    </div>
                    <span style={{ marginLeft: "1rem" }}>Reading channel history...</span>
                  </div>
                )}

                {/* System status noise, collapsed and minimized by default */}
                {!loadingHistory && systemLogEntries.length > 0 && (
                  <details className="slack-system-log-block">
                    <summary>System Logs (Click to expand) · {systemLogEntries.length}</summary>
                    <div className="raw-logs">
                      {systemLogEntries.map((log) => (
                        <div className="slack-system-log-row" key={log.id}>
                          <span className="slack-system-log-time">{log.time}</span>
                          <span className="slack-system-log-text">{log.content}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {/* Main conversation message bubbles */}
                {!loadingHistory && displayMessages.length === 0 && (
                  <div className="panel-empty">
                    No logs or thoughts in this channel yet.
                  </div>
                )}

                {!loadingHistory && renderGroups.map((group, gi) => {
                  if (group.type === "thinking") {
                    const isLastGroup = gi === renderGroups.length - 1;
                    return (
                      <ThinkingPanel
                        key={group.id}
                        items={group.items.map((m) => ({ id: m.id, content: m.content, time: m.time }))}
                        live={running && !selectedTaskId && isLastGroup}
                      />
                    );
                  }
                  const msg = group.msg;
                  // Agent-spawn lifecycle notices are represented by the thread
                  // cards below, so suppress them from the inline stream once a
                  // thread exists for that work.
                  if (msg.kind === "lifecycle" && missionThreads.length > 0 && !selectedTaskId) {
                    return null;
                  }
                  const senderLabel = labelForSender(msg.sender);
                  return msg.kind === "lifecycle" ? (
                    <div className="slack-system-notice" role="status" key={msg.id}>
                      <span className="slack-system-notice-line" aria-hidden="true" />
                      <span>{msg.content}</span>
                      <span className="slack-system-notice-time">{msg.time}</span>
                    </div>
                  ) : (
                  <div className="slack-message" key={msg.id}>
                    <div
                      className="slack-message-avatar"
                      style={{ backgroundColor: getAvatarColor(senderLabel) }}
                    >
                      {senderLabel.charAt(0).toUpperCase()}
                    </div>
                    <div className="slack-message-content">
                      <div className="slack-message-header">
                        <span className="slack-message-sender">{senderLabel}</span>
                        <span className="slack-message-time">{msg.time}</span>
                      </div>
                      <div className={`slack-message-bubble ${senderLabel === 'User' ? 'slack-message-sender-user' : ''} ${msg.kind === 'response' ? 'slack-message-response' : ''} ${msg.kind === 'activity' ? 'slack-message-activity' : ''}`}>
                        <div className="slack-message-text">{msg.content}</div>

                        {msg.artifacts && msg.artifacts.length > 0 && (
                          <div className="slack-message-artifacts">
                            {msg.artifacts.map((art: any, aIdx: number) => (
                              <div key={aIdx} className="slack-message-artifact-card">
                                <span style={{ fontSize: '1.1rem' }}>📄</span>
                                <div className="artifact-details">
                                  <span className="artifact-filename">{art.path.split("/").pop()}</span>
                                  <span className="artifact-description">{art.description}</span>
                                </div>
                                {isPreviewableArtifact(art.path) ? (
                                  <button
                                    type="button"
                                    className="slack-artifact-download"
                                    onClick={() => handlePreviewArtifact(art.path)}
                                  >
                                    Open
                                  </button>
                                ) : (
                                  <span
                                    className="slack-artifact-download disabled"
                                    style={{ opacity: 0.5, cursor: 'not-allowed' }}
                                    title="Preview not supported for this file type yet"
                                  >
                                    Open
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  );
                })}

                {/* Mission threads — one collapsed card per spawned sub-agent.
                    YAAA's handoff shows inline; the full agent thread and proof
                    of work open in a dedicated thread view. */}
                {showTaskView && !selectedTaskId && missionThreads.length > 0 && (
                  <div className="mission-threads" aria-label="Agent threads">
                    <div className="mission-threads-title">Agent threads</div>
                    {missionThreads.map(({ agent, activity, handoff }) => {
                      const identity = labelForSender(agent.id);
                      return (
                        <div className="mission-thread-card" key={agent.id}>
                          <div
                            className="slack-message-avatar mission-thread-avatar"
                            style={{ backgroundColor: getAvatarColor(identity) }}
                          >
                            {identity.charAt(0).toUpperCase()}
                          </div>
                          <div className="mission-thread-body">
                            <div className="mission-thread-header">
                              <span className="mission-thread-name">{identity}</span>
                              <span className={`detail-status-pill ${agent.status}`}>{agent.status}</span>
                            </div>
                            <div className="mission-thread-handoff">
                              <span className="mission-thread-handoff-label">{ORCHESTRATOR_DISPLAY} handoff</span>
                              <div className="mission-thread-handoff-text">{handoff}</div>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="mission-thread-show-btn"
                            onClick={() => setOpenThreadAgentId(agent.id)}
                          >
                            Show thread{activity.length > 0 ? ` · ${activity.length}` : ""} →
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Approval Banner inside chat list */}
                {showTaskView && pendingApproval && (
                  <div className="approval-banner" style={{ marginTop: '1.25rem' }}>
                    <div className="approval-title">⚠️ Security Confirmation Required</div>
                    <div className="approval-body">
                      <p>Agent <strong>{labelForSender(pendingApproval.agentId)}</strong> requests permission to run:</p>
                      <div className="approval-details">
                        <strong>Capability:</strong> {pendingApproval.toolCall.capability}<br />
                        <strong>Method:</strong> {pendingApproval.toolCall.method}<br />
                        <strong>Args:</strong>
                        <pre>{JSON.stringify(pendingApproval.toolCall.args, null, 2)}</pre>
                      </div>
                    </div>
                    <div className="approval-actions">
                      <button className="btn-reject" onClick={() => resolveApproval(false)}>Reject</button>
                      <button className="btn-approve" onClick={() => resolveApproval(true)}>Approve & Execute</button>
                    </div>
                  </div>
                )}

                {showTaskView && awaitingConfirmation && !selectedTaskId && (
                  <div className="approval-banner" style={{ marginTop: '1.25rem' }}>
                    <div className="approval-title">Plan ready for review</div>
                    <div className="approval-body">
                      {ORCHESTRATOR_DISPLAY} has proposed a plan. Open it to read the full brief,
                      leave comments, then accept or reject before any agent starts.
                    </div>
                    <div className="approval-actions">
                      <button className="btn-approve" onClick={handleOpenPlanReview}>Review plan</button>
                    </div>
                  </div>
                )}

                {/* Failure banner (success answers render as a chat reply). */}
                {showTaskView && success === false && (
                  <div className="result-banner failed" style={{ marginTop: '1.25rem' }}>
                    <span>❌</span>
                    <div className="result-banner-body">
                      <p>{summary || "Mission failed."}</p>
                      <div className="result-banner-recovery">
                        <span className="result-banner-hint">
                          If the run stopped because your Mesh API key expired or the account ran out
                          of balance, update your key or add funds to continue.
                        </span>
                        <button
                          type="button"
                          className="btn btn-secondary result-banner-btn"
                          onClick={() => setApiKeyPrompt("manual")}
                        >
                          Update API key
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <div ref={consoleEndRef} />
              </div>

              {/* Chat Input / Status Info */}
              <div className="slack-chat-input-container">
                <div className="slack-chat-input-box">
                  <span>
                    {selectedTaskId && "🔒 Archived channel — send a message to start a new mission."}
                    {inConversationView && "💬 Chatting with YAAA — describe a mission to assemble the team."}
                    {!selectedTaskId && !inConversationView && awaitingConfirmation && "🗺️ Plan ready. Review Todo and Progress, then confirm to start agents."}
                    {!selectedTaskId && !inConversationView && running && "⚡ Mission in progress... Agent is running and printing thoughts."}
                    {!selectedTaskId && !inConversationView && !running && success === true && "✅ Mission completed. Send a follow-up to continue in this channel."}
                    {!selectedTaskId && !inConversationView && !running && success === false && "❌ Mission failed."}
                    {!selectedTaskId && !inConversationView && !running && success === null && "⚡ Channel initialized. Ready to execute."}
                  </span>
                </div>
                <MissionInput
                  value={goal}
                  onChange={setGoal}
                  onSubmit={handleChannelSend}
                  running={running || awaitingConfirmation}
                  placeholder="Message this channel…"
                />
              </div>
            </div>
            ) : (
            /* Agent Space: structured lifecycle state plus collapsible execution log. */
            <div className="agent-space-pane">
              <div className="agent-space-header">
                <div className="agent-space-header-title">
                  <span className="agent-space-header-icon" aria-hidden="true">🧠</span>
                  <span>Agent Space</span>
                </div>
                <span className="agent-space-preview-tag">{activeAgentCount} active agent{activeAgentCount === 1 ? "" : "s"}</span>
              </div>
              <div className="agent-space-body">
                <div className="agent-space-heading">Named agents, execution state, and activity</div>
                {agents.length === 0 ? (
                  <div className="agent-space-note">
                    Confirm the plan to create the specialist agents assigned to this mission.
                  </div>
                ) : agents.map((agent) => {
                  const agentActivity = getAgentActivity(agent, logs);
                  const identity = agentIdentity(agent.id, agent.role);
                  return (
                  <details className="agent-space-block" key={agent.id}>
                    <summary className="agent-space-block-label">
                      <span>{identity.display} · {identity.mention}</span>
                      <span className={`detail-status-pill ${agent.status}`}>{agent.status}</span>
                    </summary>
                    <div className="agent-space-block-text">Model role: {agent.modelRole}</div>
                    <div className="agent-space-block-text">Assigned to: {agent.subtaskId}</div>
                    {agent.summary && <div className="agent-space-block-text">{agent.summary}</div>}
                    <div className="agent-space-activity-heading">Activity ({agentActivity.length})</div>
                    {agentActivity.length === 0 ? (
                      <div className="agent-space-block-text">No execution activity reported yet.</div>
                    ) : agentActivity.map((log) => (
                      <div className="agent-space-action-row" key={log.id}>
                        <span className="agent-space-action-icon" aria-hidden="true">💭</span>
                        <span className="agent-space-action-text">{log.content}</span>
                      </div>
                    ))}
                  </details>
                  );
                })}
                <details className="agent-space-block" data-testid="execution-activity">
                  <summary className="agent-space-block-label">Execution activity</summary>
                  {logs.length === 0 ? (
                    <div className="agent-space-block-text">No agent activity yet.</div>
                  ) : logs.map((log, index) => (
                    <div className="agent-space-action-row" key={`${log.time}-${index}`}>
                      <span className="agent-space-action-icon" aria-hidden="true">{log.source === "agent" ? "💭" : "🔧"}</span>
                      <span className="agent-space-action-text">{log.content}</span>
                    </div>
                  ))}
                </details>
              </div>
            </div>
            )}

            {/* Right slack-details-sidebar */}
            <div className="slack-details-sidebar">
              <div className="slack-details-header">
                Mission Details
              </div>
              <div className="slack-details-content">
                <div className="slack-details-section" aria-label="Mission team">
                  <div className="slack-section-title">Mission team</div>
                  {agents.length === 0 ? (
                    <div className="slack-section-empty">Agents will join after the plan is confirmed.</div>
                  ) : (
                    <div className="mission-team-list">
                      {agents.map((agent) => {
                        const identity = agentIdentity(agent.id, agent.role);
                        return (
                        <div className="mission-team-member" key={agent.id}>
                          <span className={`mission-team-status ${agent.status}`} aria-label={agent.status} />
                          <div className="mission-team-identity">
                            <span className="mission-team-handle">{identity.firstName} · {identity.mention}</span>
                            <span className="mission-team-role">{identity.roleLabel}</span>
                          </div>
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* ── 1. Artifacts (REAL) ── */}
                <div className="slack-details-section">
                  <div className="slack-section-title">Artifacts</div>
                  {displayArtifacts.length === 0 ? (
                    <div className="slack-section-empty">
                      No artifacts generated yet.
                    </div>
                  ) : (
                    <div className="artifact-list" role="tree" aria-label="Mission artifacts">
                      {artifactGroups.map((group) => (
                        <section className="artifact-group" key={group.id} role="group" aria-label={group.label}>
                          <div className="artifact-group-title">
                            <span>{group.label}</span>
                            <span className="artifact-group-count">{group.entries.length}</span>
                          </div>
                          {group.entries.map((art) => (
                            <div
                              key={art.normalizedPath}
                              className="artifact-item"
                              role="treeitem"
                              aria-label={`${group.label}: ${art.name}`}
                              data-artifact-kind={art.groupId}
                              aria-level={Math.max(1, art.depth + 1)}
                            >
                              <div className="artifact-tree-branch" aria-hidden="true" />
                              <div className="artifact-item-copy">
                                {art.directorySegments.length > 0 && (
                                  <div className="artifact-path">{art.directorySegments.join(" / ")}</div>
                                )}
                                <div className="artifact-name-row">
                                  <span className="artifact-name">{art.name}</span>
                                  <span className={`artifact-type-badge ${art.mediaKind || art.handoffKind || art.groupId}`}>
                                    {art.typeLabel}
                                  </span>
                                </div>
                                <div className="artifact-desc">{art.description}</div>
                              </div>
                              <div className="artifact-actions">
                                {isPreviewableArtifact(art.path) ? (
                                  <button
                                    type="button"
                                    className="artifact-link"
                                    onClick={() => handlePreviewArtifact(art.path)}
                                  >
                                    Open
                                  </button>
                                ) : (
                                  <span
                                    className="artifact-link disabled"
                                    title="Preview not supported for this file type yet"
                                  >
                                    Open
                                  </span>
                                )}
                              </div>
                            </div>
                          ))}
                        </section>
                      ))}
                    </div>
                  )}
                </div>

                {/* ── 2. Working folder (HARDCODED placeholder) ── */}
                <div className="slack-details-section">
                  <div className="slack-section-title">Working folder</div>
                  {/* Raw task UUIDs are forbidden on screen — identify the
                      folder by its channel name instead of its id. */}
                  <div className="working-folder-path">
                    ~/.yaaa/tasks/#{currentChannelName}
                  </div>
                  <div className="working-folder-list">
                    <div className="working-folder-row">
                      <span className="working-folder-icon" aria-hidden="true">📁</span>
                      <span className="working-folder-name">working/</span>
                    </div>
                    <div className="working-folder-row">
                      <span className="working-folder-icon" aria-hidden="true">📄</span>
                      <span className="working-folder-name">orchestrator.md</span>
                    </div>
                    <div className="working-folder-row">
                      <span className="working-folder-icon" aria-hidden="true">📄</span>
                      <span className="working-folder-name">messages.jsonl</span>
                    </div>
                  </div>
                </div>

                {/* ── 3. Todo and Progress (REAL: status + execution plan) ── */}
                <div className="slack-details-section">
                  <div className="slack-section-title">Todo and Progress</div>
                  <span className={`detail-status-pill ${currentStatus}`} style={{ marginBottom: '0.75rem', display: 'inline-block' }}>
                    {currentStatus ? currentStatus.toUpperCase() : "PENDING"}
                  </span>
                  {displaySubtasks.length === 0 ? (
                    <div className="slack-section-empty">
                      {selectedTaskId
                        ? "No subtasks recorded."
                        : (running
                          ? "Generating plan..."
                          : (awaitingConfirmation ? "This plan has no subtasks to review." : "Send a mission to generate a plan."))}
                    </div>
                  ) : (
                    <div className="subtask-list">
                      {displaySubtasks.map((st) => (
                        <div key={st.id} className={`subtask-item ${st.state}`}>
                          <div className="subtask-dot-col">
                            <span className={`status-badge ${st.state}`} />
                          </div>
                          <div className="subtask-body">
                            <div className="subtask-title" style={{ fontSize: '0.85rem' }}>
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', marginRight: '0.35rem' }}>
                                [{st.id}]
                              </span>
                              {st.title}
                            </div>
                            <div className="subtask-meta">
                              {st.capability && <span className="capability-tag">{st.capability}</span>}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ── 4. Contexts (HARDCODED placeholder) ── */}
                <div className="slack-details-section">
                  <div className="slack-section-title">Contexts</div>
                  <div className="context-chips">
                    <span className="context-chip">Project: yaaa</span>
                    <span className="context-chip">Language: TypeScript</span>
                    <span className="context-chip">Runtime: Electron</span>
                  </div>
                </div>

                {/* ── 5. Active Integrations: the plan's real capabilities, not a fake fixed list ── */}
                <div className="slack-details-section">
                  <div className="slack-section-title">Active Integrations</div>
                  {activeCapabilities.length === 0 && mcpIntegrations.length === 0 ? (
                    <div className="slack-section-empty">No capabilities assigned yet.</div>
                  ) : (
                    <div className="integration-list">
                      {activeCapabilities.map((capability) => (
                        <div className="integration-row" key={capability}>
                          <span className="integration-name">{formatCapabilityLabel(capability)}</span>
                          <span className="integration-status connected">in plan</span>
                        </div>
                      ))}
                      {mcpIntegrations.map((integration) => (
                        <div className="integration-row" key={`mcp-${integration.definition.id}`}>
                          <span className="integration-name">{integration.definition.displayName}</span>
                          <span
                            className={`integration-status ${integration.state.enabled ? "connected" : ""}`}
                          >
                            {integration.state.enabled
                              ? "MCP · connected"
                              : integration.state.trust === "trusted"
                                ? "MCP · trusted"
                                : "MCP · needs consent"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {apiKeyPrompt && (
        <ApiKeyModal
          overlay
          title={apiKeyPrompt === "funds" ? "API account out of funds" : "Update Mesh API Key"}
          description={
            apiKeyPrompt === "funds"
              ? "Your last mission stopped because the Mesh API account has no remaining balance."
              : "Update the Mesh API key used to run missions. It is stored locally in config.json."
          }
          notice={
            apiKeyPrompt === "funds" ? (
              <>
                To continue, add credit to your Mesh account in your provider's
                billing dashboard, or enter a different API key below. The key is
                stored locally in <code>config.json</code>.
              </>
            ) : (
              <>
                If a mission stopped because the key expired or the account ran out
                of balance, paste a new key below — or add credit in your provider's
                billing dashboard, then re-run the mission. The key is stored locally
                in <code>config.json</code>.
              </>
            )
          }
          submitLabel="Save key"
          onSaved={() => setApiKeyPrompt(null)}
          onClose={() => setApiKeyPrompt(null)}
        />
      )}

      {artifactPreview && (
        <div className="artifact-preview-overlay" onClick={handleClosePreview}>
          <div className="artifact-preview-panel" onClick={(e) => e.stopPropagation()}>
            <div className="artifact-preview-header">
              <span className="artifact-preview-title">{artifactPreview.path.split("/").pop()}</span>
              {!artifactPreviewLoading && !artifactPreviewError && (
                <button
                  type="button"
                  className="artifact-preview-annotate"
                  onClick={() => setAnnotating((v) => !v)}
                >
                  {annotating ? "Stop annotating" : "Annotate"}
                </button>
              )}
              <button
                type="button"
                className="artifact-preview-close"
                onClick={handleClosePreview}
                aria-label="Close preview"
              >
                ✕
              </button>
            </div>
            <div className="artifact-preview-body">
              {artifactPreviewLoading ? (
                <div className="panel-empty">
                  <div className="thinking-dots">
                    <span /><span /><span />
                  </div>
                </div>
              ) : artifactPreviewError ? (
                <div className="panel-empty">{artifactPreviewError}</div>
              ) : (
                <div className="annotation-preview-wrap">
                  {artifactPreview.kind === "image" && artifactPreview.dataUrl ? (
                    <img
                      className="artifact-image-preview"
                      src={artifactPreview.dataUrl}
                      alt={artifactPreview.path.split("/").pop()}
                    />
                  ) : artifactPreview.kind === "diagram" ? (
                    <ArchitectureViewer source={artifactPreview.content} />
                  ) : /\.(md|markdown|txt)$/i.test(artifactPreview.path) ? (
                    <div className="markdown-preview">{renderMarkdown(artifactPreview.content)}</div>
                  ) : (
                    <pre className="code-preview">{artifactPreview.content}</pre>
                  )}
                  {annotating && (selectedTaskId || taskId) && (
                    <AnnotationOverlay
                      taskId={(selectedTaskId || taskId) as string}
                      artifactPath={artifactPreview.path}
                      onClose={() => setAnnotating(false)}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── PLAN REVIEW MODAL (view MD, comment, accept/reject) ─── */}
      {planReviewOpen && (
        <div className="artifact-preview-overlay" onClick={handleClosePlanReview}>
          <div className="artifact-preview-panel plan-review-panel" onClick={(e) => e.stopPropagation()}>
            <div className="artifact-preview-header">
              <span className="artifact-preview-title">Review plan · {currentChannelName}</span>
              <button
                type="button"
                className="artifact-preview-close"
                onClick={handleClosePlanReview}
                aria-label="Close plan review"
              >
                ✕
              </button>
            </div>
            <div className="artifact-preview-body">
              {planReviewLoading ? (
                <div className="panel-empty">
                  <div className="thinking-dots"><span /><span /><span /></div>
                </div>
              ) : planReviewMd ? (
                <div className="markdown-preview">{renderMarkdown(planReviewMd)}</div>
              ) : (
                <div className="markdown-preview">
                  {renderMarkdown(
                    `## Proposed plan\n\n${
                      displaySubtasks.length
                        ? displaySubtasks
                            .map((s, i) => `${i + 1}. **${s.title}** _(capability: ${s.capability || "n/a"})_`)
                            .join("\n")
                        : "_No subtasks were proposed._"
                    }`,
                  )}
                </div>
              )}
            </div>
            <div className="plan-review-footer">
              {rejecting ? (
                <>
                  <label className="plan-review-label" htmlFor="plan-reject-reason">
                    Why are you rejecting this plan?
                  </label>
                  <textarea
                    id="plan-reject-reason"
                    className="plan-review-textarea"
                    placeholder="Tell YAAA what's wrong so it can re-plan…"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                  />
                  <div className="plan-review-actions">
                    <button type="button" className="btn-reject" onClick={() => setRejecting(false)}>
                      Back
                    </button>
                    <button
                      type="button"
                      className="btn-approve"
                      disabled={!rejectReason.trim()}
                      onClick={handleSubmitReject}
                    >
                      Submit rejection
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <label className="plan-review-label" htmlFor="plan-comment">
                    Comments (optional)
                  </label>
                  <textarea
                    id="plan-comment"
                    className="plan-review-textarea"
                    placeholder="Leave comments for YAAA to address before starting…"
                    value={planComment}
                    onChange={(e) => setPlanComment(e.target.value)}
                  />
                  <div className="plan-review-actions">
                    <button type="button" className="btn-reject" onClick={() => setRejecting(true)}>
                      Reject
                    </button>
                    <button type="button" className="btn-approve" onClick={handleAcceptPlan}>
                      {planComment.trim() ? "Accept (addressing comments)" : "Accept plan"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── AGENT THREAD OVERLAY (opened from a "Show thread" card) ─── */}
      {openThread && (
        <div className="artifact-preview-overlay" onClick={() => setOpenThreadAgentId(null)}>
          <div className="artifact-preview-panel thread-panel" onClick={(e) => e.stopPropagation()}>
            <div className="artifact-preview-header">
              <button
                type="button"
                className="thread-back-btn"
                onClick={() => setOpenThreadAgentId(null)}
              >
                ← Back
              </button>
              <span className="artifact-preview-title">
                {labelForSender(openThread.agent.id)} · thread
              </span>
              <button
                type="button"
                className="artifact-preview-close"
                onClick={() => setOpenThreadAgentId(null)}
                aria-label="Close thread"
              >
                ✕
              </button>
            </div>
            <div className="artifact-preview-body">
              <div className="thread-section">
                <div className="thread-section-title">
                  {ORCHESTRATOR_DISPLAY} → {labelForSender(openThread.agent.id)} · Handoff document
                </div>
                <div className="thread-handoff-doc">{openThread.handoff}</div>
              </div>
              <div className="thread-section">
                <div className="thread-section-title">Thread activity ({openThread.activity.length})</div>
                {openThread.activity.length === 0 ? (
                  <div className="agent-space-block-text">No activity reported yet.</div>
                ) : (
                  openThread.activity.map((log) => (
                    <div className="agent-space-action-row" key={log.id}>
                      <span className="agent-space-action-icon" aria-hidden="true">💭</span>
                      <span className="agent-space-action-text">{log.content}</span>
                    </div>
                  ))
                )}
              </div>
              <div className="thread-section">
                <div className="thread-section-title">Proof of work</div>
                <div className="agent-space-block-text">
                  Status: {openThread.agent.status}
                  {openThread.agent.summary ? ` — ${openThread.agent.summary}` : ""}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
