// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { DashboardView } from "./DashboardView";
import {
  ORCHESTRATOR_DISPLAY,
  ORCHESTRATOR_MENTION,
  agentIdentity,
  displaySender,
} from "../utils/displayNames";

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
  queuedMessages: [],
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

  it("does not restart an agent response animation when the composer rerenders", () => {
    const response = {
      id: "agent-response",
      time: "10:00",
      source: "orchestrator",
      content: "abcdefghij",
      kind: "response",
    };
    const { rerender, container } = render(
      <DashboardView viewModel={makeViewModel({ taskId: "task-1", running: true, logs: [response] })} />,
    );

    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(container.querySelector(".slack-message-text")?.textContent).toBe("abcd");

    rerender(
      <DashboardView viewModel={makeViewModel({ taskId: "task-1", running: true, goal: "x", logs: [response] })} />,
    );
    act(() => {
      vi.advanceTimersByTime(8);
    });

    expect(container.querySelector(".slack-message-text")?.textContent).toBe("abcdef");
  });

  it("shows each consecutive agent response once without replaying the prior response", () => {
    const firstResponse = {
      id: "first-response",
      time: "20:03:20",
      source: "orchestrator",
      content: "First answer",
      kind: "response",
    };
    const firstTurn = makeViewModel({ taskId: "task-1", running: false, logs: [firstResponse] });
    const { rerender, container } = render(<DashboardView viewModel={firstTurn} />);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(container.querySelectorAll(".slack-message-text")[0]?.textContent).toBe("First answer");

    const userFollowUp = {
      id: "user-follow-up",
      time: "20:03:31",
      source: "user",
      content: "what else",
      kind: "response",
    };
    rerender(
      <DashboardView
        viewModel={makeViewModel({ taskId: "task-1", running: true, logs: [firstResponse, userFollowUp] })}
      />,
    );
    expect(container.querySelectorAll(".slack-message-text")[0]?.textContent).toBe("First answer");

    const secondResponse = {
      id: "second-response",
      time: "20:03:36",
      source: "orchestrator",
      content: "Second answer",
      kind: "response",
    };
    rerender(
      <DashboardView
        viewModel={makeViewModel({
          taskId: "task-1",
          running: false,
          logs: [firstResponse, userFollowUp, secondResponse],
        })}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(200);
    });

    const messages = container.querySelectorAll(".slack-message-text");
    expect(messages[0]?.textContent).toBe("First answer");
    expect(messages[2]?.textContent).toBe("Second answer");
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

  it("restores persisted user and orchestrator turns as chat bubbles, not thoughts", async () => {
    const tasks = [
      { id: "task-1", prompt: "testing rerender", status: "success", created_at: "2026-07-08T12:00:00Z" },
    ];
    (window as any).electronAPI.getTaskHistory.mockResolvedValue([
      { kind: "thought", from: "user", content: "testing rerender" },
      {
        kind: "thought",
        from: "orchestrator",
        content: "Could you provide more details about testing rerender?",
      },
      { kind: "thought", from: "planner", content: "Classifying the request" },
    ]);

    const { container } = render(<DashboardView viewModel={makeViewModel({ tasks })} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle("testing rerender"));
    });

    expect(screen.getByText("Could you provide more details about testing rerender?")).toBeTruthy();
    expect(container.querySelectorAll(".slack-message")).toHaveLength(2);
    expect(screen.getByText("Thought · 1 step")).toBeTruthy();
    expect(screen.queryByText("Thought · 3 steps")).toBeNull();
  });

  it("continues a reopened channel with its persisted task id and keeps its history visible", async () => {
    const continueMission = vi.fn();
    const startTask = vi.fn();
    const tasks = [
      { id: "persisted-task", prompt: "Original conversation", status: "success", created_at: "2026-07-08T12:00:00Z" },
    ];
    (window as any).electronAPI.getTaskHistory.mockResolvedValue([
      { kind: "thought", from: "user", content: "Original question" },
      { kind: "thought", from: "orchestrator", content: "Original answer" },
    ]);

    const { rerender } = render(<DashboardView viewModel={makeViewModel({
      tasks,
      goal: "Continue with that context",
      continueMission,
      startTask,
    })} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle("Original conversation"));
    });

    fireEvent.keyDown(screen.getByPlaceholderText("Message this channel…"), { key: "Enter" });

    expect(continueMission).toHaveBeenCalledWith(
      "Continue with that context",
      "persisted-task",
    );
    expect(startTask).not.toHaveBeenCalled();

    rerender(<DashboardView viewModel={makeViewModel({
      tasks,
      taskId: "persisted-task",
      goal: "",
      running: true,
      continueMission,
      startTask,
    })} />);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText("Original question")).toBeTruthy();
    expect(screen.getByText("Original answer")).toBeTruthy();
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

  it("enables the PowerPoint viewer for presentation artifacts", () => {
    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      artifacts: [{ path: "deck.pptx", mimeType: "application/vnd.ms-powerpoint", description: "Slides" }],
    })} />);

    // Open is the single entry point for the dedicated PowerPoint viewer.
    expect(screen.queryByText("Preview")).toBeNull();
    const open = screen.getByText("Open");
    expect(open.tagName).toBe("BUTTON");
    fireEvent.click(open);
    expect(screen.getByTestId("universal-viewer-modal")).toBeTruthy();
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
    expect(screen.getByRole("group", { name: "Agent artifacts" })).toBeTruthy();
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

  it("collapses agent artifact subgroups by default and expands them independently", () => {
    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      artifacts: [
        { path: "agents/builder/HANDS_ON.md", mimeType: "text/markdown", description: "Agent boundaries" },
        { path: "agents/builder/HANDS_OFF.md", mimeType: "text/markdown", description: "Completed changes" },
      ],
    })} />);

    expect(screen.getByRole("group", { name: "Agent artifacts" })).toBeTruthy();
    const toggle = screen.getByRole("button", { name: /builder/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("HANDS ON")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("HANDS ON")).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("HANDS ON")).toBeNull();
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

  it("renders raw system status logs inline as system notices", () => {
    const { container } = render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      logs: [
        { id: "sys-1", time: "10:00", source: "system", content: 'Submitting task to supervisor: "hi"', kind: "system" },
        { id: "sys-2", time: "10:00", source: "system", content: "Task initialized. ID: abc-123. Listening to event stream...", kind: "system" },
      ],
    })} />);

    expect(screen.getByText(/Submitting task to supervisor/)).toBeTruthy();
    expect(screen.getByText(/Task initialized/)).toBeTruthy();
    const notices = container.querySelectorAll(".slack-system-notice");
    expect(notices.length).toBe(2);
  });

  it("keeps queued follow-ups pinned above the chat messages", () => {
    const { container } = render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      running: true,
      queuedMessages: [{ id: "queued-1", content: "whats happening?", time: "09:39:24" }],
    })} />);

    const queue = container.querySelector(".slack-queued-messages");
    expect(queue).toBeTruthy();
    expect(queue?.textContent).toContain("Queued for YAAA");
    expect(queue?.textContent).toContain("whats happening?");
    expect(container.querySelector(".slack-chat-messages")?.firstElementChild).toBe(queue);
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

  it("shows YAAA in the mission team with its thumbnail before any agent has joined", () => {
    render(<DashboardView viewModel={makeViewModel({ taskId: "task-1", agents: [] })} />);

    const team = screen.getByLabelText("Mission team");
    // YAAA leads the roster from the first message, not only once agents exist.
    expect(within(team).getByText(`${ORCHESTRATOR_DISPLAY} · ${ORCHESTRATOR_MENTION}`)).toBeTruthy();
    // Its dot is the "active" (green) status, never a pending/failed one.
    expect(within(team).getByLabelText("active")).toBeTruthy();
    // YAAA's thumbnail is the app's own brand mark, as used in the sidebar.
    expect(within(team).getByAltText(ORCHESTRATOR_DISPLAY).getAttribute("src")).toBe("logo.jpg");
  });

  it("names the model each agent was spun up on, with the reason as its tooltip", () => {
    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      agents: [{
        id: "agent-research",
        handle: "@sage-1",
        displayName: "Sage",
        taskId: "task-1",
        subtaskId: "research",
        role: "Researcher",
        modelRole: "anthropic/claude-sonnet-4.5",
        model: "anthropic/claude-sonnet-4.5",
        modelReason: "Mesh's live catalog offers it.",
        status: "working",
      }],
    })} />);

    const team = screen.getByLabelText("Mission team");
    const model = within(team).getByText("Anthropic Claude Sonnet 4.5");
    expect(model.getAttribute("title")).toBe("Mesh's live catalog offers it.");

    // Agent Space spells out the same model plus why it was chosen.
    fireEvent.click(screen.getByTitle("Agent Space"));
    expect(screen.getByText("Model: Anthropic Claude Sonnet 4.5")).toBeTruthy();
    expect(screen.getByText("Mesh's live catalog offers it.")).toBeTruthy();
  });

  it("omits the model line for an agent whose model is not resolved yet", () => {
    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      agents: [{
        id: "agent-research",
        handle: "@sage-1",
        displayName: "Sage",
        taskId: "task-1",
        subtaskId: "research",
        role: "Researcher",
        modelRole: "worker",
        status: "working",
      }],
    })} />);

    const team = screen.getByLabelText("Mission team");
    expect(within(team).queryByText(/Anthropic|Google/)).toBeNull();
  });

  describe("clarifying-question form", () => {
    const QUESTIONS = "I need a few clarifications:\n\n- What is the deadline?\n- Which format do you want?";

    // Clarifying questions reach the mission channel as an orchestrator log.
    const renderQuestions = (continueMission = vi.fn()) => {
      render(<DashboardView viewModel={makeViewModel({
        taskId: "task-1",
        continueMission,
        logs: [
          { id: "q1", time: "10:00", source: "orchestrator", kind: "response", content: QUESTIONS },
        ],
      })} />);
      return continueMission;
    };

    it("sends the answers once and then disables the whole form", () => {
      const continueMission = renderQuestions();
      const answer = screen.getByPlaceholderText("Type your answer...");
      fireEvent.change(answer, { target: { value: "Next Friday" } });

      const submit = screen.getByText("Submit answers");
      fireEvent.click(submit);

      expect(continueMission).toHaveBeenCalledTimes(1);
      expect(continueMission.mock.calls[0][0]).toContain("Next Friday");

      // Every control is now spent — a second click cannot send a duplicate.
      const form = screen.getByLabelText("Clarifying questions");
      expect((within(form).getByText("Answers sent") as HTMLButtonElement).disabled).toBe(true);
      expect((form.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
      expect(within(form).getByText("Back").closest("button")!.disabled).toBe(true);
      expect(within(form).getByText("Next").closest("button")!.disabled).toBe(true);
      expect(within(form).getByRole("status").textContent).toContain("Answers sent to YAAA");
    });

    it("ignores a repeat submit of the form after it was sent", () => {
      const continueMission = renderQuestions();
      fireEvent.change(screen.getByPlaceholderText("Type your answer..."), { target: { value: "PDF" } });
      const form = screen.getByLabelText("Clarifying questions");

      fireEvent.submit(form);
      fireEvent.submit(form);
      fireEvent.submit(form);

      // Submitting the form directly bypasses the disabled button, so the
      // guard has to live in the handler, not just in the markup.
      expect(continueMission).toHaveBeenCalledTimes(1);
    });

    it("cannot be submitted before anything is answered", () => {
      const continueMission = renderQuestions();
      const submit = screen.getByText("Submit answers") as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      fireEvent.submit(screen.getByLabelText("Clarifying questions"));
      expect(continueMission).not.toHaveBeenCalled();
    });

    it("renders suggested options as radio buttons and includes Other text", () => {
      const continueMission = vi.fn();
      render(<DashboardView viewModel={makeViewModel({
        taskId: "task-1",
        continueMission,
        logs: [{
          id: "q-options",
          time: "10:00",
          source: "orchestrator",
          kind: "response",
          content: "Which format should the deliverable use?\nOptions:\n- PowerPoint\n- PDF",
        }],
      })} />);

      fireEvent.click(screen.getByLabelText("PowerPoint"));
      fireEvent.change(screen.getByPlaceholderText("Type your answer..."), { target: { value: "A branded version" } });
      fireEvent.click(screen.getByText("Submit answers"));

      expect(continueMission).toHaveBeenCalledWith(expect.stringContaining("PowerPoint"), expect.anything());
      expect(continueMission.mock.calls[0][0]).toContain("Other: A branded version");
    });

    it("renders Markdown in options and turns a Markdown-only Other option into a textarea", () => {
      render(<DashboardView viewModel={makeViewModel({
        taskId: "task-1",
        logs: [{
          id: "q-markdown-options",
          time: "10:00",
          source: "orchestrator",
          kind: "response",
          content: "Which output?\nOptions:\n- **PowerPoint**\n- **Other**",
        }],
      })} />);

      expect(screen.getByLabelText("PowerPoint").getAttribute("type")).toBe("radio");
      expect(screen.getByText("PowerPoint").tagName).toBe("STRONG");
      expect(screen.getByPlaceholderText("Type your answer...")).toBeTruthy();
    });

    it("shows the textarea when Other includes please specify punctuation", () => {
      render(<DashboardView viewModel={makeViewModel({
        taskId: "task-1",
        logs: [{
          id: "q-other-specify",
          time: "10:00",
          source: "orchestrator",
          kind: "response",
          content: "What is the target audience?\nOptions:\n- General public\n- Other (please specify).",
        }],
      })} />);

      fireEvent.click(screen.getByLabelText("Other"));
      expect(screen.getByPlaceholderText("Type your answer...")).toBeTruthy();
    });

    it("treats a labeled prompt as a question instead of a radio option", () => {
      render(<DashboardView viewModel={makeViewModel({
        taskId: "task-1",
        logs: [{
          id: "q-labeled-prompt",
          time: "10:00",
          source: "orchestrator",
          kind: "response",
          content: "I can help with that. Please provide a few details?\n- Target Audience: Who is the primary audience for this slideshow video? Knowing this will help tailor the language.\n- General public\n- Aquarium hobbyists\n- Other (please specify).",
        }],
      })} />);

      expect(screen.queryByLabelText("Target Audience: Who is the primary audience for this slideshow video? Knowing this will help tailor the language.")).toBeNull();
      expect(screen.getByText(/Target Audience: Who is the primary audience/)).toBeTruthy();
      expect(screen.getByLabelText("General public").getAttribute("type")).toBe("radio");
    });

    it("infers checkbox options when the AI puts an either-or choice in the question", () => {
      render(<DashboardView viewModel={makeViewModel({
        taskId: "task-1",
        logs: [{
          id: "q-inline-options",
          time: "10:00",
          source: "orchestrator",
          kind: "response",
          content: "Presentation format: Would you like slide content, or would you prefer a PowerPoint file?",
        }],
      })} />);

      expect(screen.getByLabelText("slide content")).toBeTruthy();
      expect(screen.getByLabelText("a PowerPoint file")).toBeTruthy();
    });
  });

  it("no longer renders the Contexts section", () => {
    render(<DashboardView viewModel={makeViewModel({ taskId: "task-1" })} />);
    expect(screen.queryByText("Contexts")).toBeNull();
    expect(screen.queryByText(/^Project: /)).toBeNull();
    expect(screen.queryByText(/^User: /)).toBeNull();
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

  it("shows plan review actions from live awaiting state even if task list status is stale", () => {
    const tasks = [{
      id: "task-1",
      prompt: "Build a thing",
      status: "planning",
      created_at: "2026-07-12T05:37:20.135Z",
    }];
    render(<DashboardView viewModel={makeViewModel({
      taskId: "task-1",
      awaitingConfirmation: true,
      running: false,
      tasks,
      subtasks: [{ id: "s1", title: "Do the thing", capability: "files", dependsOn: [], riskLevel: "low", successCriteria: "", state: "pending" }],
      logs: [{ id: "plan", time: "10:00", source: "orchestrator", content: "[plan-proposal] Implementation plan ready for review.", kind: "response" }],
    })} />);

    expect(screen.getByText("Accept plan")).toBeTruthy();
    expect(screen.getByText("Review plan")).toBeTruthy();
    expect(screen.getByText("Reject plan")).toBeTruthy();
  });

  it("restores an awaiting plan as an actionable proposal message", async () => {
    const confirmPlan = vi.fn();
    const tasks = [{
      id: "persisted-plan",
      prompt: "Build a Python tool",
      status: "awaiting_confirmation",
      created_at: "2026-07-12T05:37:20.135Z",
    }];
    (window as any).electronAPI.getTaskHistory.mockResolvedValue([
      { kind: "thought", from: "user", content: "Build a Python tool" },
      {
        kind: "thought",
        from: "orchestrator",
        content: "[plan-proposal] Implementation plan ready for review.",
      },
    ]);
    (window as any).electronAPI.readTaskOrchestrator.mockResolvedValue(
      "# Plan\n\n## [subtask-1] Build the tool\n- Capability: `files`",
    );

    render(<DashboardView viewModel={makeViewModel({ tasks, confirmPlan })} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle("Build a Python tool"));
    });

    expect(screen.getByTestId("plan-proposal-message")).toBeTruthy();
    expect(screen.getByText("Implementation plan proposed")).toBeTruthy();
    fireEvent.click(screen.getByText("Accept plan"));
    expect(confirmPlan).toHaveBeenCalledWith(undefined, "persisted-plan");
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

    // The hands-on assignment is shown inline on the thread card while work is in progress.
    expect(screen.getByText("Investigate the repo")).toBeTruthy();
    expect(screen.getByText(/handsOn · open/)).toBeTruthy();
    expect(screen.queryByText(/handoff · open/)).toBeNull();
    fireEvent.click(screen.getByText(/View channel/));
    // Thread overlay shows the assignment and success criteria, but no agent handoff yet.
    expect(screen.getByText(/handsOn assignment/)).toBeTruthy();
    expect(screen.queryByText(/Handoff document/)).toBeNull();
    expect(screen.getAllByText(/Findings documented/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText("← Back"));
    expect(screen.queryByText(/handsOn assignment/)).toBeNull();
  });
});
