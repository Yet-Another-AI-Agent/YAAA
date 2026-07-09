// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { DashboardView } from "./DashboardView";

vi.mock("../assets/logo.jpg", () => ({ default: "logo.jpg" }));

const makeViewModel = (overrides = {}) => ({
  goal: "",
  setGoal: vi.fn(),
  taskId: null,
  setTaskId: vi.fn(),
  running: false,
  subtasks: [],
  logs: [],
  pendingApproval: null,
  artifacts: [],
  summary: null,
  success: null,
  startTask: vi.fn(),
  resolveApproval: vi.fn(),
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
    expect(screen.getByText("agent-files")).toBeTruthy();
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
});
