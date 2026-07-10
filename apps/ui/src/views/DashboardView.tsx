import { useRef, useEffect, useState, useMemo } from "react";
import logoImg from "../assets/logo.jpg";
import type { TaskViewModel } from "../viewmodels/useTaskViewModel";
import { TaskModel } from "../models/TaskModel";
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
  if (sender.toLowerCase().includes("planner")) return "#e01e5a"; // Slack pink
  if (sender.toLowerCase().includes("worker")) return "#2eb67d"; // Slack green
  if (sender.toLowerCase().includes("verifier")) return "#ecb22e"; // Slack yellow
  if (sender.toLowerCase().includes("supervisor") || sender.toLowerCase().includes("orchestrator")) return "#4a154b"; // Slack purple
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

function formatChannelName(prompt: string, taskId?: string): string {
  if (!prompt) return "channel";
  let slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .substring(0, 30);
  if (!slug) {
    slug = "channel";
  }
  if (taskId) {
    const suffix = taskId.substring(0, 6);
    return `${slug}-${suffix}`;
  }
  return slug;
}

function getArtifactHref(yaaaDir: string, activeTaskId: string | null, artPath: string): string {
  if (!yaaaDir || !activeTaskId || !artPath) return "#";
  const encodedPath = artPath.split("/").map(p => encodeURIComponent(p)).join("/");
  return `file://${yaaaDir}/tasks/${activeTaskId}/working/${encodedPath}`;
}

/** Only Markdown/plaintext artifacts get an in-app preview for now — PPT/PDF/Excel rendering is a separate, larger feature. */
function isPreviewableArtifact(artPath: string): boolean {
  return /\.(md|markdown|txt)$/i.test(artPath);
}

export function DashboardView({ viewModel }: DashboardViewProps) {
  const {
    goal,
    setGoal,
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
    startTask,
    confirmPlan,
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
  const [orchestratorMd, setOrchestratorMd] = useState<string | null>(null);
  const [historyMessages, setHistoryMessages] = useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const activeHistoryRequestRef = useRef<string | null>(null);

  // Split-screen artifact preview (Markdown/plaintext only for now).
  const [artifactPreview, setArtifactPreview] = useState<{ path: string; content: string } | null>(null);
  const [artifactPreviewLoading, setArtifactPreviewLoading] = useState(false);
  const [artifactPreviewError, setArtifactPreviewError] = useState<string | null>(null);
  const activeArtifactRequestRef = useRef(0);

  // YAAA data directory state
  const [yaaaDir, setYaaaDir] = useState<string>("");

  // User's name from onboarding profile
  const [userName, setUserName] = useState("");

  // Fetch yaaaDir on mount
  useEffect(() => {
    TaskModel.getYaaaDir()
      .then(setYaaaDir)
      .catch((err) => console.error("Failed to fetch YAAA dir:", err));
  }, []);

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

  const handleChipClick = (chip: string) => {
    setGoal(chip);
  };

  const handleReset = () => {
    setSelectedTaskId(null);
    setShowTaskView(false);
    setTaskId(null);
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
    setArtifactPreviewError(null);
    setArtifactPreviewLoading(true);
    setArtifactPreview({ path: artPath, content: "" });
    try {
      const content = await TaskModel.readArtifact(activeTaskId, artPath);
      if (activeArtifactRequestRef.current !== requestId) return;
      if (content === null) {
        setArtifactPreviewError("Could not read this file.");
      } else {
        setArtifactPreview({ path: artPath, content });
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
  };

  const handleNewMission = () => {
    setSelectedTaskId(null);
    setShowTaskView(false);
    setGoal("");
    setTaskId(null);
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
  // channelTopic (live event) is the fastest path; the tasks list (refreshed
  // independently via loadTasks) is the fallback if that event arrives after
  // the mission's event subscription has already been torn down.
  const liveTask = taskId ? tasks.find(t => t.id === taskId) : null;
  const currentChannelName = selectedTask
    ? (selectedTask.topic || formatChannelName(selectedTask.prompt, selectedTask.id))
    : (taskId ? (channelTopic || liveTask?.topic || formatChannelName(goal, taskId)) : "general");

  const memoizedData = useMemo(() => {
    let displayMessages: any[] = [];
    let systemLogEntries: any[] = [];
    const parsedOrchestrator = parseOrchestratorMd(orchestratorMd);

    if (selectedTaskId) {
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
        content: goal,
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
    logs,
    subtasks,
    artifacts,
    running,
    awaitingConfirmation,
    success
  ]);

  const { displayMessages, systemLogEntries, displaySubtasks, displayArtifacts, currentStatus } = memoizedData;
  const artifactGroups = useMemo(() => buildArtifactExplorer(displayArtifacts), [displayArtifacts]);
  const activeAgentCount = agents.filter(isActiveAgent).length;
  // Real capabilities this plan actually uses, replacing what used to be a
  // hardcoded fake Slack/GitHub/Web-Search "connected" list.
  const activeCapabilities = Array.from(new Set(displaySubtasks.map((st) => st.capability).filter(Boolean)));

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
                const channelName = t.topic || formatChannelName(t.prompt, t.id);
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
            {(showTaskView || selectedTaskId) && (
              <button className="dash-back-btn" onClick={handleReset}>
                ← New Mission
              </button>
            )}
          </div>

          <div className="dash-topbar-right">
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

        {(!selectedTaskId && !showTaskView) ? (
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
                    <summary>System log ({systemLogEntries.length})</summary>
                    {systemLogEntries.map((log) => (
                      <div className="slack-system-log-row" key={log.id}>
                        <span className="slack-system-log-time">{log.time}</span>
                        <span className="slack-system-log-text">{log.content}</span>
                      </div>
                    ))}
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
                      style={{ backgroundColor: getAvatarColor(msg.sender) }}
                    >
                      {msg.sender.charAt(0).toUpperCase()}
                    </div>
                    <div className="slack-message-content">
                      <div className="slack-message-header">
                        <span className="slack-message-sender">{msg.sender}</span>
                        <span className="slack-message-time">{msg.time}</span>
                      </div>
                      <div className={`slack-message-bubble ${msg.sender === 'User' ? 'slack-message-sender-user' : ''} ${msg.kind === 'response' ? 'slack-message-response' : ''} ${msg.kind === 'activity' ? 'slack-message-activity' : ''}`}>
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
                                {isPreviewableArtifact(art.path) && (
                                  <button
                                    type="button"
                                    className="slack-artifact-download"
                                    onClick={() => handlePreviewArtifact(art.path)}
                                  >
                                    Preview
                                  </button>
                                )}
                                {(!yaaaDir || !(selectedTaskId || taskId)) ? (
                                  <span className="slack-artifact-download disabled" style={{ opacity: 0.5, cursor: 'not-allowed' }}>
                                    Open
                                  </span>
                                ) : (
                                  <a
                                    className="slack-artifact-download"
                                    href={getArtifactHref(yaaaDir, selectedTaskId || taskId, art.path)}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Open
                                  </a>
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

                {/* Approval Banner inside chat list */}
                {showTaskView && pendingApproval && (
                  <div className="approval-banner" style={{ marginTop: '1.25rem' }}>
                    <div className="approval-title">⚠️ Security Confirmation Required</div>
                    <div className="approval-body">
                      <p>Agent <strong>{pendingApproval.agentId}</strong> requests permission to run:</p>
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
                      The orchestrator has proposed the work shown in Todo and Progress. No agent actions have started yet.
                    </div>
                    <div className="approval-actions">
                      <button className="btn-approve" onClick={confirmPlan}>Confirm plan &amp; start agents</button>
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
                    {!selectedTaskId && awaitingConfirmation && "🗺️ Plan ready. Review Todo and Progress, then confirm to start agents."}
                    {!selectedTaskId && running && "⚡ Mission in progress... Agent is running and printing thoughts."}
                    {!selectedTaskId && !running && success === true && "✅ Mission completed."}
                    {!selectedTaskId && !running && success === false && "❌ Mission failed."}
                    {!selectedTaskId && !running && success === null && "⚡ Channel initialized. Ready to execute."}
                  </span>
                </div>
                <MissionInput
                  value={goal}
                  onChange={setGoal}
                  onSubmit={() => startTask()}
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
                  return (
                  <details className="agent-space-block" key={agent.id}>
                    <summary className="agent-space-block-label">
                      <span>{agent.handle} · {agent.role}</span>
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
                      {agents.map((agent) => (
                        <div className="mission-team-member" key={agent.id}>
                          <span className={`mission-team-status ${agent.status}`} aria-label={agent.status} />
                          <div className="mission-team-identity">
                            <span className="mission-team-handle">{agent.handle}</span>
                            <span className="mission-team-role">{agent.role}</span>
                          </div>
                        </div>
                      ))}
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
                                {isPreviewableArtifact(art.path) && (
                                  <button
                                    type="button"
                                    className="artifact-link"
                                    onClick={() => handlePreviewArtifact(art.path)}
                                  >
                                    Preview
                                  </button>
                                )}
                                {(!yaaaDir || !(selectedTaskId || taskId)) ? (
                                  <span className="artifact-link disabled">Open</span>
                                ) : (
                                  <a
                                    className="artifact-link"
                                    href={getArtifactHref(yaaaDir, selectedTaskId || taskId, art.path)}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Open
                                  </a>
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
                  <div className="working-folder-path">
                    ~/.yaaa/tasks/{(selectedTaskId || taskId || "current").toString().substring(0, 8)}
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
                          : (awaitingConfirmation ? "This plan has no subtasks to review." : "Awaiting plan..."))}
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
                  {activeCapabilities.length === 0 ? (
                    <div className="slack-section-empty">No capabilities assigned yet.</div>
                  ) : (
                    <div className="integration-list">
                      {activeCapabilities.map((capability) => (
                        <div className="integration-row" key={capability}>
                          <span className="integration-name">{formatCapabilityLabel(capability)}</span>
                          <span className="integration-status connected">in plan</span>
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
                <div className="markdown-preview">{renderMarkdown(artifactPreview.content)}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
