// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { DashboardView } from "./DashboardView";

vi.mock("../assets/logo.jpg", () => ({ default: "logo.jpg" }));

const makeViewModel = (overrides = {}) => ({
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
  ...overrides,
});

describe("DashboardView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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
});
