// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

vi.mock("./assets/logo.jpg", () => ({ default: "logo.jpg" }));

vi.mock("./viewmodels/useTaskViewModel", () => ({
  useTaskViewModel: vi.fn(() => ({
    goal: "",
    setGoal: vi.fn(),
    taskId: null,
    running: false,
    subtasks: [],
    logs: [],
    pendingApproval: null,
    artifacts: [],
    summary: null,
    success: null,
    startTask: vi.fn(),
    resolveApproval: vi.fn(),
  })),
}));

// Import App after mocks are in place
import App from "./App";

describe("App", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows SplashView initially", () => {
    render(<App />);
    expect(screen.getByText("Yet Another AI Agent")).toBeTruthy();
  });

  it("does not show the dashboard before splash ends", () => {
    render(<App />);
    expect(screen.queryByPlaceholderText("What's the mission today?")).toBeNull();
  });

  it("transitions from SplashView to DashboardView after 3000ms", async () => {
    render(<App />);

    expect(screen.getByText("Yet Another AI Agent")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByPlaceholderText("What's the mission today?")).toBeTruthy();
  });
});
