import { useRef, useEffect, useState } from "react";
import logoImg from "../assets/logo.jpg";
import type { TaskViewModel } from "../viewmodels/useTaskViewModel";
import { TaskModel } from "../models/TaskModel";
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

function formatChannelName(prompt: string): string {
  if (!prompt) return "channel";
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .substring(0, 30);
}

export function DashboardView({ viewModel }: DashboardViewProps) {
  const {
    goal,
    setGoal,
    taskId,
    setTaskId,
    running,
    subtasks,
    logs,
    pendingApproval,
    artifacts,
    summary,
    success,
    startTask,
    resolveApproval,
    tasks,
  } = viewModel;

  const consoleEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [greeting] = useState(getGreeting());
  const [showTaskView, setShowTaskView] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Past task selected states
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [orchestratorMd, setOrchestratorMd] = useState<string | null>(null);
  const [loadingOrchestrator, setLoadingOrchestrator] = useState(false);
  const [historyMessages, setHistoryMessages] = useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // YAAA data directory state
  const [yaaaDir, setYaaaDir] = useState<string>("");

  // Fetch yaaaDir on mount
  useEffect(() => {
    TaskModel.getYaaaDir()
      .then(setYaaaDir)
      .catch((err) => console.error("Failed to fetch YAAA dir:", err));
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

  // Fetch orchestrator.md when a task is selected
  useEffect(() => {
    let active = true;
    if (selectedTaskId) {
      setLoadingOrchestrator(true);
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
        } finally {
          if (active) {
            setLoadingOrchestrator(false);
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

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setGoal(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (goal.trim() && !running) startTask();
    }
  };

  const handleChipClick = (chip: string) => {
    setGoal(chip);
    textareaRef.current?.focus();
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
      TaskModel.getTaskHistory(id)
        .then((msgs) => {
          setHistoryMessages(msgs || []);
        })
        .catch((err) => {
          console.error("Failed to load task history:", err);
          setHistoryMessages([]);
        })
        .finally(() => {
          setLoadingHistory(false);
        });
    }
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
  const currentChannelName = selectedTask 
    ? formatChannelName(selectedTask.prompt)
    : (taskId ? formatChannelName(goal) : "general");

  let displayMessages: any[] = [];
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
      const parsed = parseOrchestratorMd(orchestratorMd);
      displayMessages.push({
        id: "user-prompt",
        sender: "User",
        time: formatDate(parsed.updatedAt),
        content: parsed.prompt || "Start task",
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
        kind: msg.kind,
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

    // Add live logs
    logs.forEach((log) => {
      let sender = log.source === "system" ? "System" : (log.source === "orchestrator" ? "Supervisor" : "Agent");
      let content = log.content;
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
        kind: log.source,
        artifacts: [],
      });
    });
  }

  const parsedOrchestrator = parseOrchestratorMd(orchestratorMd);
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
    : (running ? "running" : (success ? "success" : (success === false ? "failed" : "pending")));

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
                const status = t.id === taskId && running ? "running" : t.status;
                const channelName = formatChannelName(t.prompt);
                return (
                  <button
                    key={t.id}
                    className={`slack-channel-item ${isActive ? "active" : ""}`}
                    onClick={() => handleSelectTask(t.id)}
                    title={t.prompt}
                  >
                    <span className="slack-hash">#</span>
                    <span className="slack-channel-name">{channelName}</span>
                    <span style={{ display: "none" }}>{t.prompt}</span>
                    <span className={`slack-status-dot ${status}`} />
                  </button>
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
            <button className="icon-btn" title="Settings" aria-label="Settings">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
            <div className="avatar-btn" title="Krishna" aria-label="User profile">
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
              <h1 className="dash-greeting">{greeting}, Krishna.</h1>
            </div>

            {/* Mission Orchestrator Input */}
            <div className="mission-orchestrator">
              <div className="mission-label">MISSION ORCHESTRATOR</div>
              <div className="mission-input-wrapper">
                <textarea
                  ref={textareaRef}
                  className="mission-textarea"
                  placeholder="What's the mission today?"
                  value={goal}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  rows={1}
                  disabled={running}
                />
                <div className="mission-actions">
                  <button className="mission-action-btn" title="Attach file" aria-label="Attach file">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                    </svg>
                  </button>
                  <button className="mission-action-btn" title="Voice input" aria-label="Voice input">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                      <line x1="12" y1="19" x2="12" y2="23"/>
                      <line x1="8" y1="23" x2="16" y2="23"/>
                    </svg>
                  </button>
                  <button
                    className="mission-send-btn"
                    onClick={() => startTask()}
                    disabled={running || !goal.trim()}
                    title="Launch agent"
                    aria-label="Launch agent"
                  >
                    {running ? (
                      <span className="send-spinner" />
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="22" y1="2" x2="11" y2="13"/>
                        <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                      </svg>
                    )}
                  </button>
                </div>
              </div>
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
            {/* Middle slack-chat-pane */}
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

                {/* Main conversation message bubbles */}
                {!loadingHistory && displayMessages.length === 0 && (
                  <div className="panel-empty">
                    No logs or thoughts in this channel yet.
                  </div>
                )}

                {!loadingHistory && displayMessages.map((msg) => (
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
                      <div className={`slack-message-bubble ${msg.sender === 'User' ? 'slack-message-sender-user' : ''}`}>
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
                                <a 
                                  className="slack-artifact-download"
                                  href={`file://${yaaaDir}/tasks/${selectedTaskId || taskId}/working/${art.path}`} 
                                  target="_blank" 
                                  rel="noreferrer"
                                >
                                  Open
                                </a>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                
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

                {/* Result summary inline in chat */}
                {showTaskView && summary && (
                  <div className={`result-banner ${success ? "success" : "failed"}`} style={{ marginTop: '1.25rem' }}>
                    <span>{success ? "✅" : "❌"}</span>
                    <p>{summary}</p>
                  </div>
                )}

                <div ref={consoleEndRef} />
              </div>

              {/* Chat Input / Status Info */}
              <div className="slack-chat-input-container">
                <div className="slack-chat-input-box">
                  <span>
                    {selectedTaskId && "🔒 Channel is archived. You can view the complete execution log."}
                    {!selectedTaskId && running && "⚡ Mission in progress... Agent is running and printing thoughts."}
                    {!selectedTaskId && !running && success === true && "✅ Mission completed. Channel is archived."}
                    {!selectedTaskId && !running && success === false && "❌ Mission failed. Channel is archived."}
                    {!selectedTaskId && !running && success === null && "⚡ Channel initialized. Ready to execute."}
                  </span>
                </div>
              </div>
            </div>

            {/* Right slack-details-sidebar */}
            <div className="slack-details-sidebar">
              <div className="slack-details-header">
                Mission Details
              </div>
              <div className="slack-details-content">
                {/* Status section */}
                <div style={{ marginBottom: '1rem' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.5rem' }}>Status</div>
                  <span className={`detail-status-pill ${currentStatus}`}>
                    {currentStatus ? currentStatus.toUpperCase() : "PENDING"}
                  </span>
                </div>

                {/* Subtasks Section */}
                <div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.75rem' }}>Execution Plan</div>
                  {displaySubtasks.length === 0 ? (
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem', fontStyle: 'italic' }}>
                      {selectedTaskId ? "No subtasks recorded." : (running ? "Generating plan..." : "Awaiting plan...")}
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

                {/* Artifacts Section */}
                <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1.25rem' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.75rem' }}>Artifacts</div>
                  {displayArtifacts.length === 0 ? (
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem', fontStyle: 'italic' }}>
                      No artifacts generated yet.
                    </div>
                  ) : (
                    <div className="artifact-list">
                      {displayArtifacts.map((art, idx) => (
                        <div key={idx} className="artifact-item">
                          <div style={{ minWidth: 0, flex: 1, paddingRight: '8px' }}>
                            <div className="artifact-name" style={{ fontSize: '0.85rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {art.path.split("/").pop()}
                            </div>
                            <div className="artifact-desc" style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {art.description}
                            </div>
                          </div>
                          <a 
                            className="artifact-link" 
                            href={`file://${yaaaDir}/tasks/${selectedTaskId || taskId}/working/${art.path}`} 
                            target="_blank" 
                            rel="noreferrer"
                            style={{ fontSize: '0.85rem' }}
                          >
                            Open
                          </a>
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
    </div>
  );
}
