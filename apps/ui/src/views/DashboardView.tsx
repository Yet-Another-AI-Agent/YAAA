import { useRef, useEffect, useState } from "react";
import logoImg from "../assets/logo.jpg";
import type { TaskViewModel } from "../viewmodels/useTaskViewModel";

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
  } = viewModel;

  const consoleEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [greeting] = useState(getGreeting());
  const [showTaskView, setShowTaskView] = useState(false);

  // Auto-scroll logs
  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Switch to task view once a task starts
  useEffect(() => {
    if (running || taskId) setShowTaskView(true);
  }, [running, taskId]);

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
    setShowTaskView(false);
  };

  return (
    <div className="dash-root fade-in-dashboard">
      {/* Top-right: Back + Settings + Avatar */}
      <div className="dash-topbar">
        <div className="dash-topbar-left">
          {showTaskView && (
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

      {!showTaskView ? (
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
  );
}
