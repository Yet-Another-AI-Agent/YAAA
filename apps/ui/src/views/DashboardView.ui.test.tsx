// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { DashboardView } from "./DashboardView";
import { agentIdentity, displaySender } from "../utils/displayNames";

vi.mock("../assets/logo.jpg", () => ({ default: "logo.jpg" }));

const makeViewModel = (overrides = {}) => ({
  goal: "",
  setGoal: vi.fn(),
  submittedPrompt: "",
  taskId: null,
  setTaskId: vi.fn(),
  running: false,
  awaitingConfirmation: false,
  agents: [],
  subtasks: [],
  logs: [],
  pendingApproval: null,
  artifacts: [],
  summary: null,
  success: null,
  channelTopic: null,
  chatMessages: [],
  startTask: vi.fn(),
  continueMission: vi.fn(),
  confirmPlan: vi.fn(),
  rejectPlan: vi.fn(),
  resolveApproval: vi.fn(),
  deleteTask: vi.fn().mockResolvedValue(undefined),
  tasks: [],
  loadTasks: vi.fn().mockResolvedValue(undefined),
  apiKeyPrompt: null,
  setApiKeyPrompt: vi.fn(),
  ...overrides,
});

describe("DashboardView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (window as any).electronAPI = {
      getYaaaDir: vi.fn().mockResolvedValue("/mock/yaaa"),
      getTaskHistory: vi.fn().mockResolvedValue([]),
      getOnboardingProfile: vi.fn().mockResolvedValue({ name: "", profession: "", description: "" }),
      readTaskOrchestrator: vi.fn().mockResolvedValue(null),
      readArtifact: vi.fn().mockResolvedValue("# Report\n\nAll done."),
      listMcpIntegrations: vi.fn().mockResolvedValue([]),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as any).electronAPI;
  });

  it("renders the home view with brand label", () => {
    render(<DashboardView viewModel={makeViewModel()} />);
    expect(screen.getByText(/Yet Another AI Agent/)).toBeTruthy();
  });

  it("renders the mission orchestrator input", () => {
    render(<DashboardView viewModel={makeViewModel()} />);
    expect(screen.getByPlaceholderText("What's the mission today?")).toBeTruthy();
  });

  it("shows the approval banner when pendingApproval is set", () => {
    const pendingApproval = {
      agentId: "agent-files",
      toolCall: {
        id: "call-1",
        capability: "files",
        method: "writeFile",
        args: { path: "out.txt", content: "hello" },
      },
    };

    render(<DashboardView viewModel={makeViewModel({ pendingApproval, taskId: "task-1", running: true })} />);

    expect(screen.getByText("Security Confirmation Required", { exact: false })).toBeTruthy();
    // The requesting agent is shown by its friendly human name, not the raw id.
    expect(screen.getByText(displaySender("agent-files"))).toBeTruthy();
  });

  it("does not show approval banner when pendingApproval is null", () => {
    render(<DashboardView viewModel={makeViewModel()} />);
    expect(screen.queryByText("Security Confirmation Required", { exact: false })).toBeNull();
  });

  it("renders the hamburger menu button and toggles the sidebar collapsed class on click", () => {
    render(<DashboardView viewModel={makeViewModel()} />);
    
    const toggleBtn = screen.getByTitle("Toggle Sidebar");
    expect(toggleBtn).toBeTruthy();

    const sidebar = screen.getByText("Missions").closest(".dash-sidebar");
    expect(sidebar).toBeTruthy();
    expect(sidebar?.classList.contains("collapsed")).toBe(false);

    act(() => {
      toggleBtn.click();
    });
    expect(sidebar?.classList.contains("collapsed")).toBe(true);

    act(() => {
      toggleBtn.click();
    });
    expect(sidebar?.classList.contains("collapsed")).toBe(false);
  });

  it("collapses the sidebar when a task is selected from the sidebar", async () => {
    const tasks = [
      { id: "task-1", prompt: "Test task 1", status: "success", created_at: "2026-07-08T12:00:00Z" }
    ];
    render(<DashboardView viewModel={makeViewModel({ tasks })} />);

    const sidebar = screen.getByText("Missions").closest(".dash-sidebar");
    expect(sidebar?.classList.contains("collapsed")).toBe(false);

    const taskItem = screen.getByText("Test task 1");
    await act(async () => {
      taskItem.click();
    });

    expect(sidebar?.classList.contains("collapsed")).toBe(true);
  });

  it("collapses the sidebar if running is true or taskId is set on mount", () => {
    render(<DashboardView viewModel={makeViewModel({ running: true, taskId: "task-1" })} />);
    const sidebar = screen.getByText("Missions").closest(".dash-sidebar");
    expect(sidebar?.classList.contains("collapsed")).toBe(true);
  });

  it("deletes a channel from the sidebar after an inline confirm, without opening it", () => {
    const tasks = [
      { id: "task-1", prompt: "Test task 1", status: "success", created_at: "2026-07-08T12:00:00Z" }
    ];
    const deleteTask = vi.fn().mockResolvedValue(undefined);

    render(<DashboardView viewModel={makeViewModel({ tasks, deleteTask })} />);

    fireEvent.click(screen.getByTitle("Delete chat"));
    expect(deleteTask).not.toHaveBeenCalled(); // first click only arms the confirm

    fireEvent.click(screen.getByTitle("Confirm delete"));
    expect(deleteTask).toHaveBeenCalledWith("task-1");
    // Deleting shouldn't also select/open the channel it was attached to.
    expect(screen.queryByText(/Yet Another AI Agent/)).toBeTruthy();
  });

  it("does not delete a channel when the inline confirm is cancelled", () => {
    const tasks = [
      { id: "task-1", prompt: "Test task 1", status: "success", created_at: "2026-07-08T12:00:00Z" }
    ];
    const deleteTask = vi.fn();

    render(<DashboardView viewModel={makeViewModel({ tasks, deleteTask })} />);
    fireEvent.click(screen.getByTitle("Delete chat"));
    fireEvent.click(screen.getByTitle("Cancel"));

    expect(deleteTask).not.toHaveBeenCalled();
    expect(screen.queryByTitle("Confirm delete")).toBeNull();
    expect(screen.getByTitle("Delete chat")).toBeTruthy();
  });

  it("shows Active Integrations derived from the plan's real capabilities, not a fake fixed list", () => {
    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      subtasks: [
        { id: "task-1", title: "Write a file", capability: "files", dependsOn: [], riskLevel: "low", successCriteria: "", state: "pending" },
        { id: "task-2", title: "Verify it", capability: "verify", dependsOn: [], riskLevel: "low", successCriteria: "", state: "pending" },
      ],
    })} />);

    expect(screen.getByText("File System")).toBeTruthy();
    expect(screen.getByText("Verification")).toBeTruthy();
    expect(screen.queryByText("Slack")).toBeNull();
    expect(screen.queryByText("GitHub")).toBeNull();
  });

  it("opens an in-app preview of a Markdown artifact and renders it, without dangerouslySetInnerHTML", async () => {
    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      artifacts: [{ path: "summary.md", mimeType: "text/markdown", description: "Final report" }],
    })} />);

    await act(async () => {
      fireEvent.click(screen.getAllByText("Open")[0]);
    });

    expect((window as any).electronAPI.readArtifact).toHaveBeenCalledWith("task-1", "summary.md");
    expect(screen.getByRole("heading", { name: "Report" })).toBeTruthy();
    expect(screen.getByText("All done.")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Close preview"));
    expect(screen.queryByRole("heading", { name: "Report" })).toBeNull();
  });

  it("ignores a stale artifact response after a newer preview is requested", async () => {
    let resolveFirst!: (content: string) => void;
    let resolveSecond!: (content: string) => void;
    const first = new Promise<string>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<string>((resolve) => { resolveSecond = resolve; });
    (window as any).electronAPI.readArtifact
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);

    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      artifacts: [
        { path: "old.md", mimeType: "text/markdown", description: "Old" },
        { path: "new.md", mimeType: "text/markdown", description: "New" },
      ],
    })} />);

    const previewButtons = screen.getAllByText("Open");
    fireEvent.click(previewButtons[0]);
    fireEvent.click(previewButtons[1]);

    await act(async () => resolveSecond("# Current preview"));
    expect(screen.getByRole("heading", { name: "Current preview" })).toBeTruthy();

    await act(async () => resolveFirst("# Stale preview"));
    expect(screen.queryByRole("heading", { name: "Stale preview" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Current preview" })).toBeTruthy();
  });

  it("disables Open for artifacts the in-app viewer cannot render", () => {
    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      artifacts: [{ path: "deck.pptx", mimeType: "application/vnd.ms-powerpoint", description: "Slides" }],
    })} />);

    // No separate Preview control anymore; Open is the single viewer entry
    // point and is disabled for unsupported binary types.
    expect(screen.queryByText("Preview")).toBeNull();
    const open = screen.getByText("Open");
    expect(open.className).toContain("disabled");
  });

  it("groups artifact tree metadata for plans, handoffs, media, and generated files", () => {
    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      artifacts: [
        { path: "plans/IMPLEMENTATION_PLAN.md", mimeType: "text/markdown", description: "Execution blueprint" },
        { path: "agents/builder/HANDS_ON.md", mimeType: "text/markdown", description: "Agent boundaries" },
        { path: "agents/builder/HANDS_OFF.md", mimeType: "text/markdown", description: "Completed changes" },
        { path: "media/demo.mp4", mimeType: "video/mp4", description: "Generated walkthrough" },
        { path: "exports/results.csv", mimeType: "text/csv", description: "Generated data" },
      ],
    })} />);

    expect(screen.getByRole("tree", { name: "Mission artifacts" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Plans" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Agent handoffs" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Generated media" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Documents & files" })).toBeTruthy();
    expect(
      screen.getByRole("treeitem", { name: "Plans: IMPLEMENTATION_PLAN.md" }).getAttribute(
        "data-artifact-kind",
      ),
    ).toBe("plans");
    expect(screen.getByText("HANDS ON")).toBeTruthy();
    expect(screen.getByText("HANDS OFF")).toBeTruthy();
    expect(screen.getByText("Video")).toBeTruthy();
    expect(screen.getAllByText("agents / builder")).toHaveLength(2);
  });

  it("lists registered MCP servers in Active Integrations with their consent state", async () => {
    (window as any).electronAPI.listMcpIntegrations.mockResolvedValue([
      {
        definition: { id: "code-review-graph", displayName: "Code Review Graph" },
        state: { trust: "trusted", enabled: true },
      },
      {
        definition: { id: "sketchy", displayName: "Sketchy Server" },
        state: { trust: "untrusted", enabled: false },
      },
    ]);

    await act(async () => {
      render(<DashboardView viewModel={makeViewModel({ taskId: "task-1" })} />);
    });

    expect(screen.getByText("Code Review Graph")).toBeTruthy();
    expect(screen.getByText("MCP · connected")).toBeTruthy();
    expect(screen.getByText("Sketchy Server")).toBeTruthy();
    expect(screen.getByText("MCP · needs consent")).toBeTruthy();
  });

  it("shows an honest empty state for Active Integrations when the plan has no subtasks yet", () => {
    render(<DashboardView viewModel={makeViewModel({ taskId: "task-1", subtasks: [] })} />);
    expect(screen.getByText("No capabilities assigned yet.")).toBeTruthy();
  });

  it("collapses raw system status logs instead of rendering them as chat bubbles", () => {
    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      logs: [
        { id: "sys-1", time: "10:00", source: "system", content: 'Submitting task to supervisor: "hi"' },
        { id: "sys-2", time: "10:00", source: "system", content: "Task initialized. ID: abc-123. Listening to event stream..." },
      ],
    })} />);

    expect(screen.getByText(/System Logs \(Click to expand\)/)).toBeTruthy();
    expect(screen.getByText(/Submitting task to supervisor/)).toBeTruthy();
    // Collapsed by default: no `open` attribute on the <details> block.
    const block = screen.getByText(/System Logs \(Click to expand\)/).closest("details") as HTMLDetailsElement;
    expect(block.open).toBe(false);
    // Raw logs live inside the blueprint's encapsulation wrapper.
    expect(block.querySelector(".raw-logs")).toBeTruthy();
  });

  it("shows the LLM-generated channel topic instead of the raw task id once available", () => {
    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      goal: "Analyze the codebase",
      channelTopic: "codebase-analysis",
    })} />);

    // Slug topics render as normal-English words (hyphens become spaces).
    expect(screen.getByText("codebase analysis")).toBeTruthy();
  });

  it("does not contradict the plan-ready banner when a confirmed plan has no subtasks", () => {
    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      awaitingConfirmation: true,
      subtasks: [],
    })} />);

    expect(screen.getByText("This plan has no subtasks to review.")).toBeTruthy();
  });

  it("renders a casual conversation as the #general channel with YAAA bubbles", () => {
    render(<DashboardView viewModel={makeViewModel({
      chatMessages: [
        { id: "c1", sender: "User", content: "hi", time: "10:00" },
        { id: "c2", sender: "@orchestrator", content: "Hello! What are we building today?", time: "10:00" },
      ],
    })} />);

    // Conversation renders in the chat view, not the home hero.
    expect(screen.queryByText(/Yet Another AI Agent/)).toBeNull();
    expect(screen.getByText("general")).toBeTruthy();
    // The orchestrator persona always surfaces as "YAAA".
    expect(screen.getByText("YAAA")).toBeTruthy();
    expect(screen.queryByText("@orchestrator")).toBeNull();
    expect(screen.getByText("Hello! What are we building today?")).toBeTruthy();
    // No plan/confirmation machinery appears for small talk.
    expect(screen.queryByText(/Plan ready/)).toBeNull();
  });

  it("never renders a raw UUID fragment in fallback channel names", () => {
    const tasks = [
      { id: "1b154a77-9f21-4a52-8a5e-0b2f3d4c5e6f", prompt: "hi", status: "success", created_at: "2026-07-10T01:00:00Z", topic: null },
    ];
    render(<DashboardView viewModel={makeViewModel({ tasks })} />);

    expect(screen.getAllByText("hi").length).toBeGreaterThan(0);
    expect(screen.queryByText(/1b154a/)).toBeNull();
    expect(screen.queryByText("hi-1b154a")).toBeNull();
  });

  it("offers a permanently accessible Delete Workspace button that purges the active workspace after confirm", async () => {
    const deleteTask = vi.fn().mockResolvedValue(undefined);
    render(<DashboardView viewModel={makeViewModel({ taskId: "task-1", deleteTask })} />);

    fireEvent.click(screen.getByTitle("Delete Workspace"));
    expect(deleteTask).not.toHaveBeenCalled(); // first click only arms the confirm
    expect(screen.getByText(/kill agents, and purge history/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTitle("Confirm delete workspace"));
    });
    expect(deleteTask).toHaveBeenCalledWith("task-1");
  });

  it("disables the Delete Workspace button when no workspace is active", () => {
    render(<DashboardView viewModel={makeViewModel()} />);
    const btn = screen.getByTitle("Delete Workspace") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("cancels a Delete Workspace confirm without purging", () => {
    const deleteTask = vi.fn();
    render(<DashboardView viewModel={makeViewModel({ taskId: "task-1", deleteTask })} />);

    fireEvent.click(screen.getByTitle("Delete Workspace"));
    fireEvent.click(screen.getByTitle("Cancel delete workspace"));

    expect(deleteTask).not.toHaveBeenCalled();
    expect(screen.getByTitle("Delete Workspace")).toBeTruthy();
  });

  it("shows public join and exit notices in the channel", () => {
    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      logs: [
        { id: "join", time: "10:00", source: "system", content: "[agent-lifecycle] 🟢 @sage-1 joined the mission as Researcher." },
        { id: "exit", time: "10:02", source: "system", content: "[agent-lifecycle] 👋 @sage-1 is done and exited the mission." },
      ],
    })} />);

    expect(screen.getAllByRole("status")[0].textContent).toContain("joined the mission");
    expect(screen.getByText(/done and exited the mission/)).toBeTruthy();
  });

  it("renders the live mission roster and starts execution details collapsed", () => {
    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      agents: [{
        id: "agent-research",
        handle: "@sage-1",
        displayName: "Sage",
        taskId: "task-1",
        subtaskId: "research",
        role: "Researcher",
        modelRole: "fast",
        status: "working",
      }],
      logs: [{ id: "thought", time: "10:00", source: "agent", content: "[@sage-1] inspected the repository" }],
    })} />);

    // Both the chat bubble (keyed by the "@sage-1" handle) and the Mission Team
    // card (keyed by the "agent-research" id) resolve to the same human name.
    const identity = agentIdentity("agent-research", "Researcher");
    expect(identity.roleLabel).toBe("Researcher");
    // Name surfaces in the chat bubble sender and the agent thread card.
    expect(screen.getAllByText(identity.display).length).toBeGreaterThan(0);
    expect(screen.getByText(`${identity.firstName} · ${identity.mention}`)).toBeTruthy(); // team card
    expect(screen.queryByText("@sage-1")).toBeNull(); // raw handle no longer surfaced
    expect(screen.getByLabelText("working")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Agent Space"));
    const execution = screen.getByTestId("execution-activity") as HTMLDetailsElement;
    expect(execution.open).toBe(false);
    expect(screen.getByText(`${identity.display} · ${identity.mention}`)).toBeTruthy();
  });

  it("no longer renders a New Mission back button in the topbar", () => {
    render(<DashboardView viewModel={makeViewModel({ taskId: "task-1" })} />);
    expect(screen.queryByText("← New Mission")).toBeNull();
  });

  it("routes a follow-up in an open mission to continueMission, not a new task", () => {
    const continueMission = vi.fn();
    const startTask = vi.fn();
    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      goal: "add a second file",
      success: true, // mission finished → composer is idle and continuable
      continueMission,
      startTask,
    })} />);

    const input = screen.getByPlaceholderText("Message this channel…");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(continueMission).toHaveBeenCalledWith("add a second file");
    expect(startTask).not.toHaveBeenCalled();
  });

  it("opens the plan review modal and accepts with comments", async () => {
    const confirmPlan = vi.fn();
    (window as any).electronAPI.readTaskOrchestrator = vi
      .fn()
      .mockResolvedValue("# Plan\n\nStep one.");
    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      awaitingConfirmation: true,
      subtasks: [{ id: "s1", title: "Do the thing", capability: "files", dependsOn: [], riskLevel: "low", successCriteria: "", state: "pending" }],
      confirmPlan,
    })} />);

    await act(async () => {
      fireEvent.click(screen.getByText("Review plan"));
    });
    // The proposed plan MD is shown in the modal.
    expect(screen.getByRole("heading", { name: "Plan" })).toBeTruthy();

    // Leaving a comment switches the accept button to "addressing comments".
    fireEvent.change(screen.getByPlaceholderText(/Leave comments/), {
      target: { value: "tighten the scope" },
    });
    fireEvent.click(screen.getByText("Accept (addressing comments)"));
    expect(confirmPlan).toHaveBeenCalledWith("tighten the scope");
  });

  it("requires a reason to reject a plan", async () => {
    const rejectPlan = vi.fn();
    (window as any).electronAPI.readTaskOrchestrator = vi.fn().mockResolvedValue("# Plan");
    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      awaitingConfirmation: true,
      rejectPlan,
    })} />);

    await act(async () => {
      fireEvent.click(screen.getByText("Review plan"));
    });
    fireEvent.click(screen.getByText("Reject"));

    // Submit stays disabled until a reason is entered.
    const submit = screen.getByText("Submit rejection") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/what's wrong/), {
      target: { value: "wrong approach" },
    });
    expect((screen.getByText("Submit rejection") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText("Submit rejection"));
    expect(rejectPlan).toHaveBeenCalledWith("wrong approach");
  });

  it("opens a spawned agent's thread and returns via the back button", () => {
    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      subtasks: [{ id: "research", title: "Investigate the repo", capability: "browser", dependsOn: [], riskLevel: "low", successCriteria: "Findings documented", state: "running" }],
      agents: [{
        id: "browser-agent-abcd",
        handle: "@researcher-1",
        displayName: "Researcher",
        taskId: "task-1",
        subtaskId: "research",
        role: "ResearcherAgent",
        modelRole: "worker",
        status: "working",
      }],
    })} />);

    // The handoff document is shown inline on the thread card.
    expect(screen.getByText("Investigate the repo")).toBeTruthy();
    fireEvent.click(screen.getByText(/Show thread/));
    // Thread overlay shows the handoff document and success criteria.
    expect(screen.getByText(/Handoff document/)).toBeTruthy();
    expect(screen.getAllByText(/Findings documented/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText("← Back"));
    expect(screen.queryByText(/Handoff document/)).toBeNull();
  });
});
