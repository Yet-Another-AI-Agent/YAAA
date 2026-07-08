import { useRef, useEffect, useState } from "react";
import logoImg from "../assets/logo.jpg";
import type { TaskViewModel } from "../viewmodels/useTaskViewModel";
import { TaskModel } from "../models/TaskModel";

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

    if (line.startsWith("## Plan")) {
      currentSection = "plan";
      continue;
    }
    if (line.startsWith("## Execution Ledger")) {
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
      if (line.startsWith("### Step")) {
        const match = line.match(/### Step (\d+)\s*\((.*?)\)/);
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
        if (line.startsWith("* **Strategy**:")) {
          currentStep.strategy = line.replace("* **Strategy**:", "").trim();
        } else if (line.startsWith("- ") && !line.includes("**")) {
          let foundFacts = false;
          for (let j = i - 1; j >= 0; j--) {
            const prevLine = lines[j].trim();
            if (prevLine.startsWith("* **Facts Learned**:")) {
              foundFacts = true;
              break;
            }
            if (prevLine.startsWith("* **Assumptions Made**:") || prevLine.startsWith("### Step")) {
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

export function DashboardView({ viewModel }: DashboardViewProps) {
  const {
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
    tasks,
  } = viewModel;

  const consoleEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [greeting] = useState(getGreeting());
  const [showTaskView, setShowTaskView] = useState(false);

  // Past task selected states
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [orchestratorMd, setOrchestratorMd] = useState<string | null>(null);
  const [loadingOrchestrator, setLoadingOrchestrator] = useState(false);

  // Auto-scroll logs
  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Switch to task view once a task starts
  useEffect(() => {
    if (running || taskId) {
      setSelectedTaskId(null);
      setShowTaskView(true);
    }
  }, [running, taskId]);

  // Fetch orchestrator.md when a task is selected
  useEffect(() => {
    if (selectedTaskId) {
      setLoadingOrchestrator(true);
      (async () => {
        try {
          const content = await TaskModel.readTaskOrchestrator(selectedTaskId);
          setOrchestratorMd(content);
        } catch (err) {
          console.error("Failed to load orchestrator:", err);
          setOrchestratorMd(null);
        } finally {
          setLoadingOrchestrator(false);
        }
      })();
    } else {
      setOrchestratorMd(null);
    }
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
  };

  const handleSelectTask = (id: string) => {
    setSelectedTaskId(id);
    setShowTaskView(false);
  };

  const handleNewMission = () => {
    setSelectedTaskId(null);
    setShowTaskView(false);
    setGoal("");
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

  return (
    <div className="dash-root fade-in-dashboard">
      {/* ─── SIDEBAR LIST ─── */}
      <div className="dash-sidebar">
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
          <div className="sidebar-section-title">Recent Missions</div>
          {tasks.length === 0 ? (
            <div className="sidebar-empty">No past missions</div>
          ) : (
            tasks.map((t) => {
              const isActive = t.id === (taskId || selectedTaskId);
              // Handle active run case (t.status could be 'running' or 'success'/'failed')
              const status = t.id === taskId && running ? "running" : t.status;
              return (
                <button
                  key={t.id}
                  className={`sidebar-item ${isActive ? "active" : ""}`}
                  onClick={() => handleSelectTask(t.id)}
                >
                  <span className={`status-indicator ${status}`} />
                  <div className="sidebar-item-content">
                    <div className="sidebar-item-prompt" title={t.prompt}>{t.prompt}</div>
                    <div className="sidebar-item-meta">
                      {formatDate(t.created_at)}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* ─── MAIN CONTENT CONTAINER ─── */}
      <div className="dash-main-container">
        {/* Top-right: Back + Settings + Avatar */}
        <div className="dash-topbar">
          <div className="dash-topbar-left">
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

        {selectedTaskId ? (
          /* ─── PAST MISSION VIEW ─── */
          loadingOrchestrator ? (
            <div className="past-task-detail">
              <div className="panel-empty">
                <div className="thinking-dots">
                  <span /><span /><span />
                </div>
                <span style={{ marginLeft: "1rem" }}>Reading mission log...</span>
              </div>
            </div>
          ) : !orchestratorMd ? (
            <div className="past-task-detail">
              <div className="panel-empty">
                <span>No execution ledger found for this mission.</span>
              </div>
            </div>
          ) : (() => {
            const parsed = parseOrchestratorMd(orchestratorMd);
            return (
              <div className="past-task-detail fade-in-dashboard">
                <div className="detail-header">
                  <div className="detail-info">
                    <div className="detail-prompt">"{parsed.prompt || 'Untitled Mission'}"</div>
                    <div className="detail-meta">
                      <span>ID: {parsed.taskId}</span>
                      <span>Updated: {formatDate(parsed.updatedAt)}</span>
                    </div>
                  </div>
                  <span className={`detail-status-pill ${parsed.status}`}>
                    {parsed.status || "Unknown"}
                  </span>
                </div>

                <div className="detail-grid">
                  {/* Plan Panel */}
                  <div className="task-panel glass-card">
                    <h3 className="panel-title">Execution Plan</h3>
                    {parsed.planGoal && (
                      <div style={{ fontSize: "0.9rem", color: "var(--text-secondary)", marginBottom: "1rem", fontStyle: "italic" }}>
                        Goal: {parsed.planGoal}
                      </div>
                    )}
                    <div className="subtask-list">
                      {parsed.subtasks.map((st) => (
                        <div key={st.id} className={`subtask-item ${st.state}`}>
                          <div className="subtask-dot-col">
                            <span className={`status-badge ${st.state}`} />
                          </div>
                          <div className="subtask-body">
                            <div className="subtask-title">
                              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", marginRight: "0.5rem" }}>
                                [{st.id}]
                              </span>
                              {st.title}
                            </div>
                            <div className="subtask-meta">
                              {st.capability && <span className="capability-tag">{st.capability}</span>}
                              {st.successCriteria && (
                                <span style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>
                                  Criteria: {st.successCriteria}
                                </span>
                              )}
                              {st.dependencies && st.dependencies.length > 0 && (
                                <span style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>
                                  Needs: {st.dependencies.join(", ")}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Ledger Steps Panel */}
                  <div className="task-panel glass-card">
                    <h3 className="panel-title">Execution Ledger</h3>
                    <div className="ledger-steps-list">
                      {parsed.steps.length === 0 ? (
                        <div className="panel-empty">No steps recorded in ledger.</div>
                      ) : (
                        parsed.steps.map((step, idx) => (
                          <div key={idx} className="ledger-step-card">
                            <div className="ledger-step-header">
                              <span>Step {step.step}</span>
                              <span className="ledger-step-time">{formatDate(step.timestamp)}</span>
                            </div>
                            {step.strategy && (
                              <div className="ledger-step-strategy">
                                {step.strategy}
                              </div>
                            )}
                            <div className="ledger-step-lists">
                              {step.facts && step.facts.length > 0 && (
                                <div>
                                  <div className="ledger-step-list-title">Facts Learned</div>
                                  <ul className="ledger-bullets facts">
                                    {step.facts.map((fact, fIdx) => (
                                      <li key={fIdx}>{fact}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {step.assumptions && step.assumptions.length > 0 && (
                                <div>
                                  <div className="ledger-step-list-title">Assumptions Made</div>
                                  <ul className="ledger-bullets assumptions">
                                    {step.assumptions.map((ass, aIdx) => (
                                      <li key={aIdx}>{ass}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })()
        ) : !showTaskView ? (
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
          /* ─── TASK EXECUTION VIEW ─── */
          <div className="dash-task-view fade-in-dashboard">
            {/* Compact input bar at top */}
            <div className="compact-input-bar">
              <div className="compact-input-wrapper">
                <textarea
                  ref={textareaRef}
                  className="mission-textarea compact"
                  placeholder="What's the mission today?"
                  value={goal}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  rows={1}
                  disabled={running}
                />
                <div className="mission-actions">
                  <button className="mission-action-btn" title="Attach file" aria-label="Attach file">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                    </svg>
                  </button>
                  <button className="mission-action-btn" title="Voice input" aria-label="Voice input">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                    {running ? <span className="send-spinner" /> : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="22" y1="2" x2="11" y2="13"/>
                        <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Human-in-the-Loop Approval Banner */}
            {pendingApproval && (
              <div className="approval-banner">
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

            {/* Result Banner */}
            {summary && (
              <div className={`result-banner ${success ? "success" : "failed"}`}>
                <span>{success ? "✅" : "❌"}</span>
                <p>{summary}</p>
              </div>
            )}

            <div className="task-grid">
              {/* Pipeline */}
              <div className="task-panel glass-card">
                <h3 className="panel-title">Execution Pipeline</h3>
                {subtasks.length === 0 ? (
                  <div className="panel-empty">
                    {running ? (
                      <div className="thinking-dots">
                        <span /><span /><span />
                      </div>
                    ) : "Planning subtasks..."}
                  </div>
                ) : (
                  <div className="subtask-list">
                    {subtasks.map((st) => (
                      <div key={st.id} className={`subtask-item ${st.state}`}>
                        <div className="subtask-dot-col">
                          <span className={`status-badge ${st.state}`} />
                          {st.state === "running" && <div className="subtask-line-active" />}
                        </div>
                        <div className="subtask-body">
                          <div className="subtask-title">{st.title}</div>
                          <div className="subtask-meta">
                            <span className="capability-tag">{st.capability}</span>
                            <span className={`risk-tag ${st.riskLevel}`}>{st.riskLevel} risk</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Console */}
              <div className="task-panel glass-card console-panel">
                <h3 className="panel-title">Thought Stream</h3>
                <div className="console-log-box">
                  {logs.length === 0 && (
                    <div className="console-empty">Awaiting stream...</div>
                  )}
                  {logs.map((log) => (
                    <div key={log.id} className="log-entry">
                      <div className="log-header">
                        <span className={`log-source ${log.source}`}>{log.source.toUpperCase()}</span>
                        <span className="log-time">{log.time}</span>
                      </div>
                      <div className="log-content">{log.content}</div>
                    </div>
                  ))}
                  <div ref={consoleEndRef} />
                </div>

                {/* Artifacts */}
                {artifacts.length > 0 && (
                  <div className="artifacts-tray">
                    <h4 className="tray-label">Artifacts</h4>
                    {artifacts.map((art, idx) => (
                      <div key={idx} className="artifact-item">
                        <div>
                          <div className="artifact-name">{art.path.split("/").pop()}</div>
                          <div className="artifact-desc">{art.description}</div>
                        </div>
                        <a className="artifact-link" href={`file:///Users/krishnarajk/Documents/projects/yaaa/apps/ui/workspace/${art.path}`} target="_blank" rel="noreferrer">Open</a>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
