import { useRef, useEffect, useState, useMemo, type FormEvent } from "react";
import logoImg from "../assets/logo.jpg";
import type { TaskViewModel } from "../viewmodels/useTaskViewModel";
import { TaskModel, type UIAgent, type UIAgentWorkspaceSnapshot, type UIMissionSnapshot } from "../models/TaskModel";
import { AnnotationOverlay } from "../components/AnnotationOverlay";
import { ArchitectureViewer, getMediaKind } from "../components/ArchitectureViewer";
import { ApiKeyModal } from "../components/ApiKeyModal";
import { MissionInput } from "../components/MissionInput";
import { ThinkingPanel } from "../components/ThinkingPanel";
import {
  RichMessageContent,
  UniversalViewer,
  inferViewerKind,
  isLargeMarkdown,
  type ViewerSpec,
} from "../components/UniversalViewer";
import {
  getAgentActivity,
  getAgentMessageOrderIndex,
  getVisibleLogContent,
  isActiveAgent,
  isAgentLifecycleLog,
} from "../utils/agentWorkspace";
import type { UILog } from "../viewmodels/useLogState";
import { renderMarkdown } from "../utils/simpleMarkdown";
import { buildArtifactExplorer, groupEntriesByAgent, type ArtifactExplorerEntry } from "../utils/artifactExplorer";
import {
  ORCHESTRATOR_DISPLAY,
  ORCHESTRATOR_MENTION,
  ORCHESTRATOR_ROLE_LABEL,
  agentIdentity,
  displaySender,
  humanizeChannelName,
  isOrchestratorSender,
} from "../utils/displayNames";
import { formatModelLabel } from "../utils/modelLabel";
import * as shared from "@yaaa/shared";
const { ORCHESTRATOR_MD_HEADERS } = shared;

function TypingText({ text, onComplete }: { text: string; onComplete?: () => void }) {
  const [displayedLength, setDisplayedLength] = useState(0);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    setDisplayedLength(0);
    const interval = setInterval(() => {
      setDisplayedLength((prev) => {
        const next = Math.min(prev + 2, text.length);
        if (next >= text.length) {
          clearInterval(interval);
        }
        return next;
      });
    }, 8);
    return () => clearInterval(interval);
  }, [text]);

  useEffect(() => {
    if (text.length > 0 && displayedLength >= text.length) {
      onCompleteRef.current?.();
    }
  }, [displayedLength, text.length]);

  const slicedText = text.substring(0, displayedLength);
  return <>{renderMarkdown(slicedText)}</>;
}

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

function metadataText(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function previewImageSrc(path: string): string {
  if (/^(?:https?:|file:|data:)/.test(path)) return path;
  return `file://${encodeURI(path)}`;
}

function toolLabel(metadata: Record<string, unknown> | undefined): string | null {
  const capability = metadataText(metadata, "capability");
  const method = metadataText(metadata, "method");
  if (!capability || !method) return null;
  return `${capability}.${method}`;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${remainingSeconds}s`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

function AgentWorkingStatus({ agent, activity }: { agent: UIAgent; activity: UILog[] }) {
  const active = ["planned", "working", "blocked"].includes(agent.status);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  if (!active) return null;

  const startedAt = agent.startedAt ? Date.parse(agent.startedAt) : NaN;
  const startedMs = Number.isFinite(startedAt) ? startedAt : activity[0]?.createdAt ?? now;
  const latest = [...activity].reverse().find((log) => log.kind === "activity") ?? activity.at(-1);
  const latestMs = latest?.createdAt;
  const latestText = latest?.content.replace(/^🛠️\s*/, "") || "Waiting for first activity update.";
  const latestLabel = latest
    ? `Last update ${latestMs ? `${formatElapsed(now - latestMs)} ago` : "just now"}`
    : "Waiting for first update";

  return (
    <div className="thread-live-status" role="status" aria-live="polite">
      <span className="thread-live-dot" aria-hidden="true" />
      <span>Working for {formatElapsed(now - startedMs)}</span>
      <span className="thread-live-muted">{latestLabel}</span>
      <span className="thread-live-action">{latestText}</span>
    </div>
  );
}

interface ClarifyingQuestion {
  question: string;
  options: string[];
}

function inferInlineOptions(question: string): string[] {
  // Gracefully handle older/model-generated questions that put a bounded
  // choice in prose instead of emitting the explicit Options: block.
  const match = question.match(/^(?:[^:]+:\s*)?(?:would\s+you\s+like|do\s+you\s+want)\s+(.+?),\s+or\s+(?:would\s+you\s+prefer|do\s+you\s+prefer|would\s+you\s+rather|would\s+you\s+choose)\s+(.+?)(?:\?\s*)$/i);
  if (!match) return [];
  const first = match[1].trim();
  const second = match[2].trim();
  return first && second ? [first, second] : [];
}

function extractClarifyingQuestions(content: string): ClarifyingQuestion[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const questions: ClarifyingQuestion[] = [];
  for (const line of lines) {
    const text = line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim();
    if (/\?\s*$/.test(text)) {
      questions.push({ question: text, options: [] });
      continue;
    }
    if (questions.length === 0 || /^options?\s*:/i.test(text)) continue;
    const option = line.match(/^\s*(?:[-*]|[A-D][.)]|\d+[.)])\s+(.+)$/i)?.[1]?.trim();
    if (option && !/\?\s*$/.test(option)) {
      const current = questions[questions.length - 1];
      if (current.options.length < 6 && !current.options.includes(option)) current.options.push(option);
    }
  }
  const seen = new Set<string>();
  return questions.filter((item) => {
    if (seen.has(item.question)) return false;
    seen.add(item.question);
    if (item.options.length === 0) item.options = inferInlineOptions(item.question);
    return true;
  }).slice(0, 8);
}

function extractQuestionItems(content: string): string[] {
  return extractClarifyingQuestions(content).map((item) => item.question);
}

function QuestionCarousel({
  content,
  onSubmit,
}: {
  content: string;
  onSubmit: (message: string) => void;
}) {
  const questions = useMemo(() => extractClarifyingQuestions(content), [content]);
  const [index, setIndex] = useState(0);
  const [selectedOptions, setSelectedOptions] = useState<Record<number, string[]>>({});
  const [otherAnswers, setOtherAnswers] = useState<Record<number, string>>({});
  // Answers go to the orchestrator as a chat message, which cannot be recalled.
  // Once sent, the form is spent: it stays visible as a record of what was
  // answered, but every control is disabled so a second click (or an Enter in
  // the textarea) cannot send a duplicate set of answers.
  const [submitted, setSubmitted] = useState(false);

  if (questions.length === 0) return null;

  const currentOptions = selectedOptions[index] ?? [];
  const currentOther = otherAnswers[index] ?? "";
  const answeredCount = questions.filter((_, questionIndex) =>
    (selectedOptions[questionIndex]?.length ?? 0) > 0 || Boolean(otherAnswers[questionIndex]?.trim()),
  ).length;
  const canSubmit = answeredCount > 0 && !submitted;
  const currentQuestion = questions[index];

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    const body = questions
      .map((question, questionIndex) => {
        const answer = [
          ...(selectedOptions[questionIndex] ?? []),
          otherAnswers[questionIndex]?.trim() ? `Other: ${otherAnswers[questionIndex].trim()}` : "",
        ].filter(Boolean).join("; ");
        return answer ? `Q: ${question.question}\nA: ${answer}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
    setSubmitted(true);
    onSubmit(`Answers to your questions:\n\n${body}`);
  };

  return (
    <form
      className={`question-carousel${submitted ? " question-carousel-submitted" : ""}`}
      onSubmit={submit}
      aria-label="Clarifying questions"
    >
      <div className="question-carousel-topline">
        <span>Question {index + 1} of {questions.length}</span>
        <span>{submitted ? `${answeredCount} sent` : `${answeredCount} answered`}</span>
      </div>
      <div className="question-carousel-question">{renderMarkdown(currentQuestion.question)}</div>
      {currentQuestion.options.length > 0 && (
        <fieldset className="question-carousel-options" disabled={submitted}>
          <legend>Select one or more options</legend>
          {currentQuestion.options.map((option) => (
            <label className="question-carousel-option" key={option}>
              <input
                type="checkbox"
                checked={currentOptions.includes(option)}
                onChange={() => setSelectedOptions((prev) => ({
                  ...prev,
                  [index]: currentOptions.includes(option)
                    ? currentOptions.filter((value) => value !== option)
                    : [...currentOptions, option],
                }))}
              />
              <span>{option}</span>
            </label>
          ))}
        </fieldset>
      )}
      <label className="question-carousel-other-label">
        Other (optional)
        <textarea
          className="question-carousel-answer"
          value={currentOther}
          placeholder={submitted ? "" : "Type your answer..."}
          disabled={submitted}
          readOnly={submitted}
          onChange={(event) => setOtherAnswers((prev) => ({ ...prev, [index]: event.target.value }))}
        />
      </label>
      <div className="question-carousel-actions">
        <button
          type="button"
          className="question-carousel-nav"
          disabled={submitted || index === 0}
          onClick={() => setIndex((value) => Math.max(0, value - 1))}
        >
          Back
        </button>
        <button
          type="button"
          className="question-carousel-nav"
          disabled={submitted || index >= questions.length - 1}
          onClick={() => setIndex((value) => Math.min(questions.length - 1, value + 1))}
        >
          Next
        </button>
        <button
          type="submit"
          className="question-carousel-submit"
          disabled={!canSubmit}
        >
          {submitted ? "Answers sent" : "Submit answers"}
        </button>
      </div>
      {submitted ? (
        <div className="question-carousel-sent" role="status">
          Answers sent to {ORCHESTRATOR_DISPLAY}. Add anything else in the message box below.
        </div>
      ) : null}
    </form>
  );
}

function ActivityPreview({ log }: { log: UILog }) {
  const metadata = log.metadata;
  const screenshotPath = metadataText(metadata, "screenshotPath");
  const screenshotDataUrl = metadataText(metadata, "screenshotDataUrl");
  const command = metadataText(metadata, "command");
  const query = metadataText(metadata, "query");
  const url = metadataText(metadata, "url");
  const path = metadataText(metadata, "path");
  const stdout = metadataText(metadata, "stdout");
  const stderr = metadataText(metadata, "stderr");
  const title = metadataText(metadata, "title");
  const label = toolLabel(metadata);
  const results = Array.isArray(metadata?.results) ? metadata.results.slice(0, 3) : [];
  const hasPreviewMedia = Boolean(screenshotPath || screenshotDataUrl);
  const hasCommandTranscript = Boolean(command && (stdout || stderr));
  const hasResultDetails = results.length > 0 || Boolean(stdout || stderr);
  const showDetails = hasPreviewMedia || hasCommandTranscript || hasResultDetails;

  return (
    <div className={`agent-space-action-row ${showDetails ? "with-details" : ""}`}>
      <div className="agent-space-action-body">
        <div className="agent-space-action-main">
          {label && <span className="agent-space-tool-pill">{label}</span>}
          <span className="agent-space-action-text">{log.content}</span>
        </div>
        {showDetails && (
          <div className={`agent-space-action-details ${screenshotDataUrl || screenshotPath ? "" : "no-thumbnail"}`}>
            {(screenshotDataUrl || screenshotPath) && (
              <img
                className="agent-space-action-thumbnail"
                src={screenshotDataUrl || previewImageSrc(screenshotPath || "")}
                alt={title || query || url || "Tool preview"}
              />
            )}
            <div className="agent-space-action-meta">
              {title && <div className="agent-space-action-title">{title}</div>}
              {query && results.length > 0 && <div className="agent-space-action-line"><span>Query</span>{query}</div>}
              {url && hasPreviewMedia && <div className="agent-space-action-line"><span>URL</span>{url}</div>}
              {path && hasPreviewMedia && <div className="agent-space-action-line"><span>Path</span>{path}</div>}
              {command && <pre className="agent-space-command"><code>$ {command}</code></pre>}
              {stdout && <pre className="agent-space-output"><code>{stdout}</code></pre>}
              {stderr && <pre className="agent-space-output error"><code>{stderr}</code></pre>}
              {results.length > 0 && (
                <div className="agent-space-results">
                  {results.map((result, index) => {
                    const item = result && typeof result === "object" ? result as Record<string, unknown> : {};
                    const resultTitle = typeof item.title === "string" ? item.title : `Result ${index + 1}`;
                    const resultUrl = typeof item.url === "string" ? item.url : "";
                    const description = typeof item.description === "string" ? item.description : "";
                    return (
                      <div className="agent-space-result" key={`${resultTitle}-${index}`}>
                        <div className="agent-space-result-title">{resultTitle}</div>
                        {resultUrl && <div className="agent-space-result-url">{resultUrl}</div>}
                        {description && <div className="agent-space-result-description">{description}</div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

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
  if (sender.toLowerCase() === "user") return "#36c5f0"; // Slack blue
  // YAAA / orchestrator / supervisor all share the purple persona color.
  if (isOrchestratorSender(sender) || sender === ORCHESTRATOR_DISPLAY) return "#4a154b";
  if (sender.toLowerCase().includes("planner")) return "#e01e5a"; // Slack pink
  if (sender.toLowerCase().includes("worker")) return "#2eb67d"; // Slack green
  if (sender.toLowerCase().includes("verifier")) return "#ecb22e"; // Slack yellow
  return "#707070";
}

/**
 * The picture shown next to a chat sender: YAAA's fixed brand thumbnail for the
 * orchestrator, the agent's generated avatar for a spawned agent, and a colored
 * initial for anyone else (the user, system notices, an agent whose avatar asset
 * is missing).
 */
function SenderAvatar({ sender, agent }: { sender: string; agent?: { pokemonImage?: string } }) {
  const image = isOrchestratorSender(sender) || sender === ORCHESTRATOR_DISPLAY
    ? logoImg
    : agent?.pokemonImage;
  if (image) {
    return <img className="sender-avatar-image" src={image} alt={sender} />;
  }
  return (
    <div className="sender-avatar-initial" style={{ backgroundColor: getAvatarColor(sender) }}>
      {sender.charAt(0).toUpperCase()}
    </div>
  );
}

function estimateUsedTokens(agent: any, logs: any[], workspaceSnapshot?: any): number {
  let totalChars = 4000; // Base for system prompt and tools definitions
  if (workspaceSnapshot?.files?.handsOn) {
    totalChars += workspaceSnapshot.files.handsOn.length;
  }
  if (workspaceSnapshot?.files?.handOff) {
    totalChars += workspaceSnapshot.files.handOff.length;
  }
  const agentActivity = getAgentActivity(agent, logs);
  for (const log of agentActivity) {
    totalChars += log.content.length;
  }
  return Math.max(1200, Math.round(totalChars / 4));
}

function estimateOrchestratorUsedTokens(logs: any[], goal: string): number {
  let totalChars = 8000; // Base for orchestrator prompt + schema
  totalChars += goal.length;
  for (const log of logs) {
    totalChars += log.content.length;
  }
  return Math.max(2500, Math.round(totalChars / 4));
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
 * Files the in-app viewer can render directly or through a specialized viewer.
 */
function isPreviewableArtifact(artPath: string): boolean {
  return Boolean(inferViewerKind(artPath)) || /\.(mmd|mermaid|png|jpe?g|gif|webp|svg)$/i.test(artPath);
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
    queuedMessages = [],
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
  const [selectedMissionSnapshot, setSelectedMissionSnapshot] = useState<UIMissionSnapshot | null>(null);
  // Channel id currently showing its inline "confirm delete?" affordance.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Global Delete Workspace button showing its inline confirm affordance.
  const [confirmWorkspaceDelete, setConfirmWorkspaceDelete] = useState(false);
  const [orchestratorMd, setOrchestratorMd] = useState<string | null>(null);
  const [historyMessages, setHistoryMessages] = useState<any[]>([]);
  const [resumedHistoryMessages, setResumedHistoryMessages] = useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const activeHistoryRequestRef = useRef<string | null>(null);
  const [typedMessageIds, setTypedMessageIds] = useState<Set<string>>(new Set());

  const handleTypeComplete = (id: string) => {
    setTypedMessageIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

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
  const [viewerModal, setViewerModal] = useState<ViewerSpec | null>(null);
  const [expandedAgentArtifactGroups, setExpandedAgentArtifactGroups] = useState<Set<string>>(new Set());
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
  const [agentWorkspaces, setAgentWorkspaces] = useState<Record<string, UIAgentWorkspaceSnapshot>>({});

  // User's name from onboarding profile
  const [userName, setUserName] = useState("");
  const [yaaaDir, setYaaaDir] = useState("");

  useEffect(() => {
    TaskModel.getYaaaDir()
      .then(setYaaaDir)
      .catch(() => {});
  }, []);

  const handleOpenWorkingFolder = () => {
    const activeId = selectedTaskId || taskId;
    if (activeId) {
      TaskModel.openWorkingFolder(activeId);
    }
  };

  // Reopened missions use the durable snapshot for identity resolution too.
  // The live view-model agent list is intentionally empty after an app
  // restart, so using it here caused historical messages to fall back to old
  // generic names and made the right-hand team appear empty.
  const persistedAgents = selectedTaskId ? (selectedMissionSnapshot?.agents || []) : agents;

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

  // Reopened missions are hydrated from the durable backend snapshot. This
  // keeps the UI from inferring execution state from the prose transcript.
  useEffect(() => {
    let active = true;
    if (!selectedTaskId) {
      setSelectedMissionSnapshot(null);
      setAgentWorkspaces({});
      return () => {
        active = false;
      };
    }
    TaskModel.getMissionSnapshot(selectedTaskId)
      .then(async (snapshot) => {
        if (!active) return;
        const hydratedSnapshot = snapshot.agents?.length
          ? snapshot
          : { ...snapshot, agents: await TaskModel.getTaskAgents(selectedTaskId) };
        setSelectedMissionSnapshot(hydratedSnapshot);
        void Promise.all(
          hydratedSnapshot.agents.map(async (agent) => [agent.id, await TaskModel.getAgentWorkspace(selectedTaskId, agent.id)] as const),
        ).then((entries) => {
          if (active) setAgentWorkspaces(Object.fromEntries(entries));
        }).catch(() => {});
      })
      .catch((err) => {
        console.error("Failed to load mission snapshot:", err);
        if (active) setSelectedMissionSnapshot(null);
      });
    return () => {
      active = false;
    };
  }, [selectedTaskId]);

  useEffect(() => {
    let active = true;
    const agentId = openThreadAgentId;
    if (!agentId || !selectedTaskId) return () => { active = false; };
    TaskModel.getAgentWorkspace(selectedTaskId, agentId)
      .then((workspace) => {
        if (active) setAgentWorkspaces((current) => ({ ...current, [agentId]: workspace }));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [openThreadAgentId, selectedTaskId]);

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

  // Load the proposed plan for either a live or reopened persisted task.
  useEffect(() => {
    let active = true;
    const reviewTaskId = selectedTaskId || taskId;
    if (planReviewOpen && reviewTaskId) {
      setPlanReviewLoading(true);
      setPlanReviewMd(null);
      TaskModel.readTaskOrchestrator(reviewTaskId)
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
  }, [planReviewOpen, selectedTaskId, taskId]);

  // Resolve any raw sender key (agent id OR roster handle) back to its agent,
  // so a chat bubble keyed by "@sage-1" and a team card keyed by "agent-research"
  // render as the same person. Names are always seeded on the canonical id.
  const resolveAgent = useMemo(() => {
    const byKey: Record<string, (typeof agents)[number]> = {};
    for (const a of persistedAgents) {
      if (a?.id) byKey[a.id] = a;
      if (a?.handle) byKey[a.handle] = a;
      if (a?.displayName) byKey[a.displayName] = a;
    }
    return (raw: string) => byKey[raw] || byKey[raw.replace(/^@/, "")];
  }, [persistedAgents]);

  const labelForSender = (raw: string): string => {
    if (isOrchestratorSender(raw)) return ORCHESTRATOR_DISPLAY;
    if (raw.toLowerCase() === "user") return "User";
    if (raw === "User" || raw === "System" || raw === "Agent") return raw;
    const a = resolveAgent(raw);
    if (a) return agentIdentity(a.id, a.role, a.pokemonName, a.handle).display;
    return displaySender(raw);
  };

  const handleChipClick = (chip: string) => {
    setGoal(chip);
  };

  /**
   * Route the channel composer: both a live mission and a persisted channel
   * continue in place. Only the home view starts a fresh mission.
   */
  const handleChannelSend = () => {
    if (selectedTaskId) {
      const persistedTaskId = selectedTaskId;
      setResumedHistoryMessages(historyMessages);
      setSelectedTaskId(null);
      setShowTaskView(true);
      continueMission(goal, persistedTaskId);
    } else if (taskId) {
      continueMission(goal);
    } else {
      startTask();
    }
  };

  const handleSelectTask = (id: string) => {
    if (id === taskId) {
      setSelectedTaskId(null);
      setSelectedMissionSnapshot(null);
      setShowTaskView(true);
      setSidebarOpen(false); // Collapse sidebar
    } else {
      setResumedHistoryMessages([]);
      setSelectedTaskId(id);
      setSelectedMissionSnapshot(null);
      setAgentWorkspaces({});
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
    const viewerKind = inferViewerKind(artPath);
    if (viewerKind && ["pdf", "pptx", "spreadsheet"].includes(viewerKind)) {
      setViewerModal({ type: viewerKind, source: { path: artPath }, display: "popup", title: artPath.split("/").pop() });
      return;
    }
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
    setResumedHistoryMessages([]);
    setHistoryMessages([]);
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

  const handleOpenRejectReview = () => {
    setPlanComment("");
    setRejectReason("");
    setRejecting(true);
    setPlanReviewOpen(true);
  };

  const activateSelectedPlan = () => {
    const targetTaskId = selectedTaskId || taskId;
    const wasSelected = Boolean(selectedTaskId);
    if (wasSelected) {
      setResumedHistoryMessages(historyMessages);
      setSelectedTaskId(null);
      setShowTaskView(true);
    }
    return { targetTaskId, wasSelected };
  };

  const handleClosePlanReview = () => {
    setPlanReviewOpen(false);
    setRejecting(false);
  };

  // Esc closes the top-most open popup, peeling nested popups off one at a time
  // (e.g. a document viewer opened over the agent thread closes first, revealing
  // the thread; a second Esc closes the thread). Repeated Esc therefore closes
  // every popup. The API-key gate is intentionally excluded — it is a required
  // step, not a dismissible popup.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // When focus is in an editable field, Esc belongs to that field (e.g.
      // cancelling an inline annotation edit), not to closing the popup.
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) {
        return;
      }
      if (viewerModal) {
        setViewerModal(null);
      } else if (planReviewOpen) {
        handleClosePlanReview();
      } else if (artifactPreview) {
        handleClosePreview();
      } else if (openThreadAgentId) {
        setOpenThreadAgentId(null);
      } else {
        return;
      }
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewerModal, planReviewOpen, artifactPreview, openThreadAgentId]);

  const handleAcceptPlan = () => {
    const comment = planComment;
    const { targetTaskId, wasSelected } = activateSelectedPlan();
    setPlanReviewOpen(false);
    setRejecting(false);
    setPlanComment("");
    setRejectReason("");
    if (wasSelected && targetTaskId) confirmPlan(comment, targetTaskId);
    else confirmPlan(comment);
  };

  const handleAcceptProposal = () => {
    const { targetTaskId, wasSelected } = activateSelectedPlan();
    if (wasSelected && targetTaskId) confirmPlan(undefined, targetTaskId);
    else confirmPlan();
  };

  const handleSubmitReject = () => {
    if (!rejectReason.trim()) return;
    const reason = rejectReason;
    const { targetTaskId, wasSelected } = activateSelectedPlan();
    setPlanReviewOpen(false);
    setRejecting(false);
    setRejectReason("");
    setPlanComment("");
    if (wasSelected && targetTaskId) rejectPlan(reason, targetTaskId);
    else rejectPlan(reason);
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
    const parsedOrchestrator = parseOrchestratorMd(orchestratorMd);

    if (inConversationView) {
      // #general — casual chat with @orchestrator; plain bubbles only.
      displayMessages = chatMessages.map((m) => ({ ...m, kind: "message", artifacts: [] }));
    } else {
      // A selected archived task reads directly from history. Once the user
      // resumes it, retain that same history ahead of new live logs.
      const visibleHistory = selectedTaskId
        ? historyMessages
        : showTaskView
          ? resumedHistoryMessages
          : [];
      visibleHistory.forEach((msg, idx) => {
        let sender = msg.from || "Agent";
        let content = "";
        let artifactsList = msg.artifacts || [];
        if (msg.kind === "thought") {
          content = msg.content;
        } else if (msg.kind === "result") {
          content = msg.incomplete
            ? `⏸️ Checkpoint saved — work is incomplete and must be continued.\n\n${msg.summary}`
            : msg.summary;
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

        // Public-channel user and orchestrator turns are persisted as
        // `thought` AgentMessages for storage compatibility. They are still
        // ordinary chat messages; only internal agent thoughts belong in the
        // collapsible ThinkingPanel.
        const isPersistedChatTurn =
          msg.kind === "thought" &&
          (msg.from === "user" || msg.from === "orchestrator");
        const isPlanProposal = content.startsWith("[plan-proposal]");
        if (isPlanProposal) {
          content = content.replace(/^\[plan-proposal\]\s*/, "");
        }

        displayMessages.push({
          id: msg.id || `hist-${idx}`,
          sender,
          time: msg.timestamp ? formatDate(msg.timestamp) : "",
          content,
          kind: isPlanProposal
            ? "plan_proposal"
            : isPersistedChatTurn
              ? "response"
            : msg.kind === "thought"
              ? "thinking"
              : msg.kind,
          artifacts: artifactsList,
          isHistorical: true,
        });
      });

      if (showTaskView && !selectedTaskId) {
        // Add live logs. System status logs are rendered inline
        // and cleared upon completion.
        logs.forEach((log) => {
          // Sub-agent tool activity belongs to that agent's channel, but
          // lightweight thinking should still stream into the mission so the
          // user can see progress while a long run is active.
          if (log.source === "agent" && log.kind !== "thinking") return;

          let sender = "Agent";
          if (log.source === "system") sender = "System";
          else if (log.source === "orchestrator") sender = "Orchestrator";
          else if (log.source === "user") sender = "User";

          let content = getVisibleLogContent(log.content);
          const isPlanProposal = content.startsWith("[plan-proposal]");
          if (isPlanProposal) {
            content = content.replace(/^\[plan-proposal\]\s*/, "");
          }
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
            kind: isPlanProposal
              ? "plan_proposal"
              : isAgentLifecycleLog(log)
                ? "lifecycle"
                : log.kind,
            artifacts: [],
          });
        });
      }

      const planIsAwaiting = selectedTaskId
        ? (selectedMissionSnapshot?.task.status || selectedTask?.status) === "awaiting_confirmation"
        : awaitingConfirmation;
      if (
        planIsAwaiting &&
        !displayMessages.some((message) => message.kind === "plan_proposal")
      ) {
        displayMessages.push({
          id: `plan-proposal-${selectedTaskId || taskId || "active"}`,
          sender: "Orchestrator",
          time: "",
          content: "Implementation strategy ready for review.",
          kind: "plan_proposal",
          artifacts: [],
          isHistorical: Boolean(selectedTaskId),
        });
      }
    }

    const displaySubtasks = selectedTaskId
      ? (selectedMissionSnapshot?.plan?.subtasks || parsedOrchestrator.subtasks)
      : subtasks;
    
    const displayArtifacts = selectedTaskId
      ? [
          ...(selectedMissionSnapshot?.plan?.subtasks || []).flatMap((subtask: any) => subtask.artifacts || []),
          ...historyMessages.reduce((acc: any[], m) => {
          if (m.kind === "result" && m.artifacts) {
            acc.push(...m.artifacts);
          }
          return acc;
          }, []),
        ].filter((artifact, index, all) => all.findIndex((candidate) => candidate.path === artifact.path) === index)
      : artifacts;

    const currentStatus = selectedTaskId
      ? (selectedMissionSnapshot?.task.status || selectedTask?.status || parsedOrchestrator.status)
      : (awaitingConfirmation
          ? "awaiting_confirmation"
          : (running ? "running" : (liveTask?.status || (success ? "success" : (success === false ? "failed" : "pending")))));

    return {
      displayMessages,
      displaySubtasks,
      displayArtifacts,
      currentStatus
    };
  }, [
    selectedTaskId,
    selectedTask,
    selectedMissionSnapshot,
    orchestratorMd,
    historyMessages,
    resumedHistoryMessages,
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

  const { displayMessages, displaySubtasks, displayArtifacts, currentStatus } = memoizedData;
  const artifactGroups = useMemo(() => buildArtifactExplorer(displayArtifacts), [displayArtifacts]);
  const visibleAgents = persistedAgents;
  const activeAgentCount = visibleAgents.filter(isActiveAgent).length;
  // Real capabilities this plan actually uses, replacing what used to be a
  // hardcoded fake Slack/GitHub/Web-Search "connected" list.
  const activeCapabilities = Array.from(new Set(displaySubtasks.map((st) => st.capability).filter(Boolean)));

  // Each spawned agent runs in its own sub-thread. While the agent is running
  // the main card shows YAAA's hands-on assignment; the agent-authored handoff
  // only appears after the agent has produced completion evidence.
  const missionThreads = useMemo(() => {
    return visibleAgents.map((agent) => {
      const subtask = displaySubtasks.find((s: any) => s.id === agent.subtaskId);
      const activity = getAgentActivity(agent, logs);
      const assignmentParts: string[] = [];
      if (subtask?.title) assignmentParts.push(subtask.title);
      if ((subtask as any)?.successCriteria) {
        assignmentParts.push(`Success criteria: ${(subtask as any).successCriteria}`);
      }
      const assignment = assignmentParts.join("\n\n") || "Assignment briefing pending.";
      const subtaskArtifacts = ((subtask as any)?.artifacts || []) as Array<{ path?: string; description?: string; mimeType?: string }>;
      const agentWorkspacePrefix = `agent-workspaces/${agent.id}/`;
      const artifacts = [...subtaskArtifacts, ...displayArtifacts].filter((artifact, index, all) => {
        const path = String(artifact.path || "");
        return path.startsWith(agentWorkspacePrefix) && all.findIndex((candidate) => candidate.path === artifact.path) === index;
      });
      const handsOnArtifact = artifacts.find((artifact) => /(?:^|\/)handsOn\.md$/i.test(String(artifact.path || "")));
      const handOffArtifact = artifacts.find((artifact) => /(?:^|\/)handOff\.md$/i.test(String(artifact.path || "")));
      const proofArtifact = artifacts.find((artifact) => /(?:^|\/)proofOfWork\.md$/i.test(String(artifact.path || "")));
      const handoffReady = ["completed", "failed", "exited"].includes(agent.status) && Boolean(agent.summary || handOffArtifact);
      const workspace = agentWorkspaces[agent.id];
      const handoff = agent.summary || workspace?.files.handOff || (handOffArtifact ? `${handOffArtifact.path}\n\n${handOffArtifact.description || "Agent handoff artifact ready."}` : "");
      const handsOn = workspace?.files.handsOn || assignment;
      return { agent, subtask, activity, assignment: handsOn, handoff, handoffReady, handsOnArtifact, handOffArtifact, proofArtifact };
    }).sort((a, b) => getAgentMessageOrderIndex(a.agent, logs) - getAgentMessageOrderIndex(b.agent, logs));
  }, [visibleAgents, displaySubtasks, displayArtifacts, logs, agentWorkspaces]);

  const openThread = openThreadAgentId
    ? missionThreads.find((t) => t.agent.id === openThreadAgentId) || null
    : null;

  // Anchor each agent's inline "View channel" card to the first lifecycle
  // notice that announced it, so the card appears in the stream where the
  // agent spun up rather than in a block pinned to the bottom of the chat.
  const agentCardByMessageId = useMemo(() => {
    const map = new Map<string, (typeof missionThreads)[number]>();
    const claimed = new Set<string>();
    for (const thread of missionThreads) {
      const needles = [thread.agent.id, thread.agent.handle?.replace(/^@/, ""), thread.agent.displayName]
        .filter(Boolean)
        .map((n) => String(n).toLowerCase());
      const anchor = displayMessages.find(
        (m: any) =>
          m.kind === "lifecycle" &&
          !claimed.has(m.id) &&
          needles.some((n) => m.content.toLowerCase().includes(n)),
      );
      if (anchor) {
        claimed.add(anchor.id);
        map.set(anchor.id, thread);
      }
    }
    return map;
  }, [missionThreads, displayMessages]);

  const anchoredAgentIds = useMemo(
    () => new Set(Array.from(agentCardByMessageId.values()).map((t) => t.agent.id)),
    [agentCardByMessageId],
  );

  // One row in the artifact explorer. Extracted so both the flat groups and the
  // per-agent sub-groups (agent artifacts) render identically.
  const renderArtifactItem = (art: ArtifactExplorerEntry, groupLabel: string) => (
    <div
      key={art.normalizedPath}
      className="artifact-item"
      role="treeitem"
      aria-label={`${groupLabel}: ${art.name}`}
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
  );

  const toggleAgentArtifactGroup = (agentId: string) => {
    setExpandedAgentArtifactGroups((current) => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  // One collapsed card per spawned sub-agent: the assignment/handoff document
  // opens in the viewer, and "View channel" opens that agent's full sub-channel.
  const renderMissionThreadCard = ({ agent, activity, assignment, handoff, handoffReady, handsOnArtifact, handOffArtifact }: (typeof missionThreads)[number]) => {
    const identity = labelForSender(agent.id);
    const documentTitle = handoffReady ? "Handoff document" : "handsOn assignment";
    const documentHeading = handoffReady
      ? `${identity} → ${ORCHESTRATOR_DISPLAY} · Handoff`
      : `${ORCHESTRATOR_DISPLAY} → ${identity} · handsOn`;
    const documentBody = handoffReady ? handoff : assignment;
    const documentArtifact = handoffReady ? handOffArtifact : handsOnArtifact;
    return (
      <div className="mission-thread-card" key={`card-${agent.id}`}>
        <div className="slack-message-avatar mission-thread-avatar">
          <SenderAvatar sender={identity} agent={agent} />
        </div>
        <div className="mission-thread-body">
          <div className="mission-thread-header">
            <span className="mission-thread-name">{identity}</span>
            <span className={`detail-status-pill ${agent.status}`}>{agent.status}</span>
          </div>
          <button
            type="button"
            className="mission-thread-handoff mission-thread-handoff-open"
            title={`Open ${documentTitle}`}
            onClick={() =>
              setViewerModal({
                type: "markdown",
                source: documentArtifact?.path
                  ? { path: documentArtifact.path }
                  : { content: `# ${documentHeading}\n\n${documentBody}` },
                display: "popup",
                title: documentTitle,
              })
            }
          >
            <span className="mission-thread-handoff-label">
              {handoffReady ? `${identity} handoff · open →` : `${ORCHESTRATOR_DISPLAY} handsOn · open →`}
            </span>
            <div className="mission-thread-handoff-text">{documentBody}</div>
          </button>
        </div>
        <button
          type="button"
          className="mission-thread-show-btn"
          onClick={() => setOpenThreadAgentId(agent.id)}
        >
          View channel{activity.length > 0 ? ` · ${activity.length}` : ""} →
        </button>
      </div>
    );
  };

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
                {queuedMessages.length > 0 && (
                  <div className="slack-queued-messages" role="status" aria-live="polite">
                    <div className="slack-queued-messages-header">
                      <span className="slack-queued-dot" aria-hidden="true" />
                      <strong>Queued for YAAA</strong>
                      <span>{queuedMessages.length} {queuedMessages.length === 1 ? "message" : "messages"}</span>
                    </div>
                    {queuedMessages.map((message) => (
                      <div className="slack-queued-message" key={message.id}>
                        <span className="slack-queued-message-icon" aria-hidden="true">↳</span>
                        <span className="slack-queued-message-text">{message.content}</span>
                        <span className="slack-queued-message-time">{message.time}</span>
                      </div>
                    ))}
                  </div>
                )}
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
                  // An agent-spawn lifecycle notice becomes that agent's inline
                  // "View channel" card, placed where the agent joined. Any
                  // other lifecycle chatter is folded into the card, so suppress
                  // it from the main stream once a thread exists for the work.
                  if (msg.kind === "lifecycle") {
                    const cardThread = agentCardByMessageId.get(msg.id);
                    if (cardThread) return renderMissionThreadCard(cardThread);
                    if (missionThreads.length > 0 && !selectedTaskId) return null;
                  }
                  const senderLabel = labelForSender(msg.sender);
                  const questionItems = senderLabel !== "User" ? extractQuestionItems(msg.content) : [];
                  const looksLikeClarification =
                    msg.kind === "info_request" ||
                    questionItems.length >= 2 ||
                    /\b(?:clarify|clarification|need a few|quick questions|follow-up questions)\b/i.test(msg.content);
                  const canAnswerQuestions =
                    !msg.isHistorical &&
                    msg.kind !== "plan_proposal" &&
                    questionItems.length > 0 &&
                    looksLikeClarification &&
                    Boolean(selectedTaskId || taskId);
                  if (msg.kind === "plan_proposal") {
                    const canReview =
                      currentStatus === "awaiting_confirmation" && !running;
                    return (
                      <div className="slack-message" key={msg.id} data-testid="plan-proposal-message">
                        <div className="slack-message-avatar">
                          <SenderAvatar sender={senderLabel} agent={resolveAgent(msg.sender)} />
                        </div>
                        <div className="slack-message-content">
                          <div className="slack-message-header">
                            <span className="slack-message-sender">{senderLabel}</span>
                            <span className="slack-message-time">{msg.time}</span>
                          </div>
                          <div className="slack-message-bubble slack-message-response">
                            <div className="slack-message-text">
                              <strong>Implementation strategy proposed</strong>
                              <p>{msg.content}</p>
                              {displaySubtasks.length > 0 && (
                                <ol>
                                  {displaySubtasks.map((subtask: any) => (
                                    <li key={subtask.id}>
                                      <div>{subtask.title}</div>
                                      {subtask.model ? <small>{formatModelLabel(subtask.model)}{subtask.modelReason ? ` — ${subtask.modelReason}` : ""}</small> : null}
                                    </li>
                                  ))}
                                </ol>
                              )}
                            </div>
                            {canReview && (
                              <div className="approval-actions">
                                <button type="button" className="btn-reject" onClick={handleOpenRejectReview}>
                                  Reject plan
                                </button>
                                <button type="button" className="btn btn-secondary" onClick={handleOpenPlanReview}>
                                  Review plan
                                </button>
                                <button type="button" className="btn-approve" onClick={handleAcceptProposal}>
                                  Accept plan
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  }
                  return msg.kind === "lifecycle" || msg.kind === "system" ? (
                    <div className="slack-system-notice" role="status" key={msg.id}>
                      <span className="slack-system-notice-line" aria-hidden="true" />
                      <span>{msg.content}</span>
                      <span className="slack-system-notice-time">{msg.time}</span>
                    </div>
                  ) : (
                  <div className="slack-message" key={msg.id}>
                    <div className="slack-message-avatar">
                      <SenderAvatar sender={senderLabel} agent={resolveAgent(msg.sender)} />
                    </div>
                    <div className="slack-message-content">
                      <div className="slack-message-header">
                        <span className="slack-message-sender">{senderLabel}</span>
                        <span className="slack-message-time">{msg.time}</span>
                      </div>
                      <div className={`slack-message-bubble ${senderLabel === 'User' ? 'slack-message-sender-user' : ''} ${msg.kind === 'response' ? 'slack-message-response' : ''} ${msg.kind === 'activity' ? 'slack-message-activity' : ''}`}>
                        <div className="slack-message-text">
                          {canAnswerQuestions ? (
                            <QuestionCarousel
                              content={msg.content}
                              onSubmit={(message) => continueMission(message, selectedTaskId || taskId || undefined)}
                            />
                          ) : (msg.id === displayMessages.filter(m => m.sender !== 'User' && m.kind === 'response').pop()?.id && !selectedTaskId && !msg.isHistorical && !typedMessageIds.has(msg.id) && !msg.content.includes("```yaaa-viewer") && !isLargeMarkdown(msg.content)) ? (
                            <TypingText text={msg.content} onComplete={() => handleTypeComplete(msg.id)} />
                          ) : (
                            <RichMessageContent
                              content={msg.content}
                              taskId={(selectedTaskId || taskId) ?? undefined}
                              onOpen={setViewerModal}
                            />
                          )}
                        </div>

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

                {/* Fallback: any agent whose spawn notice hasn't arrived yet has
                    no inline anchor, so surface its card here so no sub-channel
                    is ever hidden. Anchored agents render inline above. */}
                {showTaskView && !selectedTaskId &&
                  missionThreads.some((t) => !anchoredAgentIds.has(t.agent.id)) && (
                  <div className="mission-threads" aria-label="Agent threads">
                    {missionThreads
                      .filter((t) => !anchoredAgentIds.has(t.agent.id))
                      .map((thread) => renderMissionThreadCard(thread))}
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
              <div className="slack-chat-input-container">
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
                ) : (
                  <>
                    <details className="agent-space-block" key="yaaa-orchestrator">
                      <summary className="agent-space-block-label" style={{ fontWeight: "bold" }}>
                        <div style={{ display: "flex", alignItems: "center" }}>
                          <img
                            src={logoImg}
                            alt={ORCHESTRATOR_DISPLAY}
                            style={{ width: "16px", height: "16px", borderRadius: "2px", marginRight: "6px" }}
                          />
                          <span>{ORCHESTRATOR_DISPLAY} · {ORCHESTRATOR_MENTION}</span>
                        </div>
                        <span className="detail-status-pill completed">completed</span>
                      </summary>
                      <div className="agent-space-block-text">Model: {formatModelLabel("google/gemini-2.5-pro")} (planner)</div>
                      <div className="agent-space-block-text agent-space-block-note">Gemini Pro coordinates the mission plan; bounded agent work defaults to the lower-cost Gemini Flash model.</div>
                      <div className="agent-space-block-text">Assigned to: Lead Orchestration</div>
                      <div className="agent-space-block-text">Context window: {estimateOrchestratorUsedTokens(logs, goal).toLocaleString()} / 1,000,000 tokens used</div>
                    </details>
                    {agents.map((agent) => {
                      const agentActivity = getAgentActivity(agent, logs);
                      const identity = agentIdentity(agent.id, agent.role, agent.pokemonName, agent.handle);
                      return (
                      <details className="agent-space-block" key={agent.id}>
                        <summary className="agent-space-block-label">
                          <div style={{ display: "flex", alignItems: "center" }}>
                            {agent.pokemonImage ? (
                              <img src={agent.pokemonImage} alt={identity.firstName} style={{ width: "16px", height: "16px", borderRadius: "2px", marginRight: "6px", objectFit: "cover" }} />
                            ) : null}
                            <span>{identity.display} · {identity.mention}</span>
                          </div>
                          <span className={`detail-status-pill ${agent.status}`}>{agent.status}</span>
                        </summary>
                        <div className="agent-space-block-text">
                          Model: {agent.model ? formatModelLabel(agent.model) : agent.modelRole}
                        </div>
                        {agent.modelReason ? (
                          <div className="agent-space-block-text agent-space-block-note">{agent.modelReason}</div>
                        ) : null}
                        <div className="agent-space-block-text">Assigned to: {agent.subtaskId}</div>
                        {agent.initialGoal ? (
                          <div className="agent-space-block-text">Initial goal: {agent.initialGoal}</div>
                        ) : null}
                        {agent.activeAssignment && agent.activeAssignment !== agent.initialGoal ? (
                          <div className="agent-space-block-text agent-space-block-note">YAAA assignment: {agent.activeAssignment}</div>
                        ) : null}
                        <div className="agent-space-block-text">Context window: {estimateUsedTokens(agent, logs, agentWorkspaces[agent.id]).toLocaleString()} / 1,000,000 tokens used</div>
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
                  </>
                )}
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
                  {/* YAAA is the mission's constant: it is present and active from
                      the first message, before any agent is planned, so the team
                      list always leads with it rather than rendering empty. */}
                  <div className="mission-team-list">
                    <div className="mission-team-member" key="yaaa-orchestrator">
                      <span className="mission-team-status completed" aria-label="active" />
                      <img
                        className="mission-team-avatar"
                        src={logoImg}
                        alt={ORCHESTRATOR_DISPLAY}
                      />
                      <div className="mission-team-identity">
                        <span className="mission-team-handle">{ORCHESTRATOR_DISPLAY} · {ORCHESTRATOR_MENTION}</span>
                        <span className="mission-team-role">{ORCHESTRATOR_ROLE_LABEL} · {estimateOrchestratorUsedTokens(logs, goal).toLocaleString()} / 1M tokens</span>
                        <span className="mission-team-model">{formatModelLabel("google/gemini-2.5-pro")}</span>
                      </div>
                    </div>
                    {agents.map((agent) => {
                      const identity = agentIdentity(agent.id, agent.role, agent.pokemonName, agent.handle);
                      return (
                      <div className="mission-team-member" key={agent.id}>
                        <span className={`mission-team-status ${agent.status}`} aria-label={agent.status} />
                        {agent.pokemonImage ? (
                          <img className="mission-team-avatar" src={agent.pokemonImage} alt={identity.firstName} />
                        ) : null}
                        <div className="mission-team-identity">
                          <span className="mission-team-handle">{identity.firstName} · {identity.mention}</span>
                          <span className="mission-team-role">{identity.roleLabel} · {estimateUsedTokens(agent, logs, agentWorkspaces[agent.id]).toLocaleString()} / 1M tokens</span>
                          {agent.model ? (
                            <span className="mission-team-model" title={agent.modelReason}>{formatModelLabel(agent.model)}</span>
                          ) : null}
                        </div>
                      </div>
                      );
                    })}
                  </div>
                  {agents.length === 0 ? (
                    <div className="slack-section-empty">Specialist agents will join after the plan is confirmed.</div>
                  ) : null}
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
                          {group.id === "handoffs"
                            ? (
                              <div className="artifact-group-contents">
                                {groupEntriesByAgent(group.entries).map(({ agentId, entries }) => {
                                  const groupKey = agentId || "unassigned";
                                  const expanded = expandedAgentArtifactGroups.has(groupKey);
                                  return (
                                <div className="artifact-agent-group" key={groupKey}>
                                  <button
                                    type="button"
                                    className="artifact-agent-group-title artifact-agent-group-toggle"
                                    aria-expanded={expanded}
                                    aria-controls={`agent-artifacts-${groupKey}`}
                                    onClick={() => toggleAgentArtifactGroup(groupKey)}
                                  >
                                    <span className="artifact-agent-toggle-label">
                                      <span className={`artifact-group-chevron ${expanded ? "" : "collapsed"}`} aria-hidden="true">v</span>
                                      <span>{agentId ? labelForSender(agentId) : "Unassigned"}</span>
                                    </span>
                                    <span className="artifact-agent-count">{entries.length}</span>
                                  </button>
                                  {expanded && (
                                    <div id={`agent-artifacts-${groupKey}`} className="artifact-agent-contents">
                                      {entries.map((art) => renderArtifactItem(art, group.label))}
                                    </div>
                                  )}
                                </div>
                                  );
                                })}
                              </div>
                            )
                            : group.entries.map((art) => renderArtifactItem(art, group.label))}
                        </section>
                      ))}
                    </div>
                  )}
                </div>

                {/* ── 2. Working folder ── */}
                <div className="slack-details-section">
                  <div className="slack-section-title">Working folder</div>
                  <div className="working-folder-path" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <span style={{ fontSize: "11px", color: "var(--slack-text-muted)", wordBreak: "break-all", fontFamily: "var(--font-mono)" }}>
                      {yaaaDir && (selectedTaskId || taskId) ? `${yaaaDir}/tasks/${selectedTaskId || taskId}/working` : "No active task directory"}
                    </span>
                    {yaaaDir && (selectedTaskId || taskId) && (
                      <button
                        className="slack-channel-delete-confirm-btn"
                        style={{ padding: "4px 8px", fontSize: "11px", width: "fit-content", alignSelf: "flex-start" }}
                        onClick={handleOpenWorkingFolder}
                      >
                        Open in Finder
                      </button>
                    )}
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

                {/* ── 4. Active Integrations: the plan's real capabilities, not a fake fixed list ── */}
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
                  ) : /\.(md|markdown)$/i.test(artifactPreview.path) ? (
                    <UniversalViewer spec={{ type: "markdown", source: { content: artifactPreview.content } }} taskId={(selectedTaskId || taskId) ?? undefined} />
                  ) : /\.txt$/i.test(artifactPreview.path) ? (
                    <div className="markdown-preview">{artifactPreview.content}</div>
                  ) : (
                    <UniversalViewer spec={{ type: "code", source: { content: artifactPreview.content, path: artifactPreview.path } }} taskId={(selectedTaskId || taskId) ?? undefined} />
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

      {viewerModal && (
        <div className="artifact-preview-overlay viewer-modal-overlay" onClick={() => setViewerModal(null)} data-testid="universal-viewer-modal">
          <div className="artifact-preview-panel universal-viewer-panel" onClick={(event) => event.stopPropagation()}>
            <div className="artifact-preview-header">
              <span className="artifact-preview-title">{viewerModal.title || viewerModal.source.path?.split("/").pop() || `${viewerModal.type} viewer`}</span>
              <button type="button" className="artifact-preview-close" onClick={() => setViewerModal(null)} aria-label="Close viewer">✕</button>
            </div>
            <div className="artifact-preview-body">
              <UniversalViewer spec={viewerModal} taskId={(selectedTaskId || taskId) ?? undefined} />
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
                <UniversalViewer spec={{ type: "markdown-annotated", source: { content: planReviewMd, path: "orchestrator.md" } }} taskId={(selectedTaskId || taskId) ?? undefined} />
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
                    disabled={running || !awaitingConfirmation}
                    onChange={(e) => setRejectReason(e.target.value)}
                  />
                  <div className="plan-review-actions">
                    <button type="button" className="btn-reject" disabled={running || !awaitingConfirmation} onClick={() => setRejecting(false)}>
                      Back
                    </button>
                    <button
                      type="button"
                      className="btn-approve"
                      disabled={running || !awaitingConfirmation || !rejectReason.trim()}
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
                    disabled={running || !awaitingConfirmation}
                    onChange={(e) => setPlanComment(e.target.value)}
                  />
                  <div className="plan-review-actions">
                    <button type="button" className="btn-reject" disabled={running || !awaitingConfirmation} onClick={() => setRejecting(true)}>
                      Reject
                    </button>
                    <button type="button" className="btn-approve" disabled={running || !awaitingConfirmation} onClick={handleAcceptPlan}>
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
                  {ORCHESTRATOR_DISPLAY} → {labelForSender(openThread.agent.id)} · handsOn assignment
                </div>
                <button
                  type="button"
                  className="thread-handoff-doc thread-doc-open"
                  title="Open handsOn assignment"
                  onClick={() =>
                    setViewerModal({
                      type: "markdown",
                      source: openThread.handsOnArtifact?.path
                        ? { path: openThread.handsOnArtifact.path }
                        : {
                            content: `# ${ORCHESTRATOR_DISPLAY} → ${labelForSender(openThread.agent.id)} · handsOn\n\n${openThread.assignment}`,
                          },
                      display: "popup",
                      title: "handsOn assignment",
                    })
                  }
                >
                  {openThread.assignment}
                  <span className="thread-doc-open-hint">Open document →</span>
                </button>
              </div>
              {openThread.handoffReady && (
                <div className="thread-section">
                  <div className="thread-section-title">
                    {labelForSender(openThread.agent.id)} → {ORCHESTRATOR_DISPLAY} · Handoff document
                  </div>
                  <button
                    type="button"
                    className="thread-handoff-doc thread-doc-open"
                    title="Open handoff document"
                    onClick={() =>
                      setViewerModal({
                        type: "markdown",
                        source: openThread.handOffArtifact?.path
                          ? { path: openThread.handOffArtifact.path }
                          : {
                              content: `# ${labelForSender(openThread.agent.id)} → ${ORCHESTRATOR_DISPLAY} · Handoff\n\n${openThread.handoff}`,
                            },
                        display: "popup",
                        title: "Handoff document",
                      })
                    }
                  >
                    {openThread.handoff}
                    <span className="thread-doc-open-hint">Open document →</span>
                  </button>
                </div>
              )}
              <div className="thread-section">
                <div className="thread-section-title">Thread activity ({openThread.activity.length})</div>
                {openThread.activity.length === 0 ? (
                  <div className="agent-space-block-text">No activity reported yet.</div>
                ) : (
                  openThread.activity.map((log) => (
                    <ActivityPreview log={log} key={log.id} />
                  ))
                )}
              </div>
              <div className="thread-section">
                <div className="thread-section-title">Proof of work</div>
                <div className="agent-space-block-text">
                  Status: <span className={`detail-status-pill ${openThread.agent.status}`}>{openThread.agent.status}</span>
                </div>
                <AgentWorkingStatus agent={openThread.agent} activity={openThread.activity} />
                {openThread.agent.summary || openThread.proofArtifact ? (
                  <button
                    type="button"
                    className="thread-handoff-doc thread-doc-open"
                    title="Open proof-of-work document"
                    onClick={() =>
                      setViewerModal({
                        type: "markdown",
                        source: openThread.proofArtifact?.path
                          ? { path: openThread.proofArtifact.path }
                          : {
                              content: `# ${labelForSender(openThread.agent.id)} → ${ORCHESTRATOR_DISPLAY} · Proof of work\n\n${openThread.agent.summary}`,
                            },
                        display: "popup",
                        title: "Proof of work",
                      })
                    }
                  >
                    {openThread.proofArtifact
                      ? `${openThread.proofArtifact.path}\n\n${openThread.proofArtifact.description || "Proof of work artifact ready."}`
                      : openThread.agent.summary}
                    <span className="thread-doc-open-hint">Open document →</span>
                  </button>
                ) : (
                  <div className="agent-space-block-text">
                    The agent has not reported its proof of work yet.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
