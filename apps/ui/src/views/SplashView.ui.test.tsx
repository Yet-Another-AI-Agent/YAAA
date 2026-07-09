// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SplashView } from "./SplashView";

vi.mock("../assets/logo.jpg", () => ({ default: "logo.jpg" }));

describe("SplashView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders "Yet Another AI Agent"', () => {
    render(<SplashView onAnimationEnd={vi.fn()} />);
    expect(screen.getByText("Yet Another AI Agent")).toBeTruthy();
  });

  it("calls onAnimationEnd after 3000ms", () => {
    const onAnimationEnd = vi.fn();
    render(<SplashView onAnimationEnd={onAnimationEnd} />);

    expect(onAnimationEnd).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3000);

    expect(onAnimationEnd).toHaveBeenCalledOnce();
  });

  it("does not call onAnimationEnd before 3000ms", () => {
    const onAnimationEnd = vi.fn();
    render(<SplashView onAnimationEnd={onAnimationEnd} />);

    vi.advanceTimersByTime(2999);

    expect(onAnimationEnd).not.toHaveBeenCalled();
  });

  describe("Onboarding flows", () => {
    beforeEach(() => {
      (window as any).electronAPI = {
        getOnboardingStatus: vi
          .fn()
          .mockResolvedValue({ hasKey: true, hasProfile: true, skipped: true }),
        saveOnboardingKeys: vi.fn(),
        saveOnboardingProfile: vi.fn(),
        parseResume: vi.fn(),
      };
    });

    afterEach(() => {
      delete (window as any).electronAPI;
    });

    it("renders Step A when hasKey is false", async () => {
      const getStatusMock = (window as any).electronAPI.getOnboardingStatus;
      getStatusMock.mockResolvedValue({
        hasKey: false,
        hasProfile: false,
        skipped: false,
      });

      render(<SplashView onAnimationEnd={vi.fn()} />);

      // Advance timers by 3000ms to exit splash screen state. Wrap in act so
      // React flushes the async status-fetch state update + re-render.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      expect(screen.getByText("Mesh API Key Configuration")).toBeTruthy();
      expect(
        screen.getByPlaceholderText("Enter Mesh API Key (e.g. mesh_...)"),
      ).toBeTruthy();
    });

    it("renders Step B when hasKey is true but profile is missing and not skipped", async () => {
      const getStatusMock = (window as any).electronAPI.getOnboardingStatus;
      getStatusMock.mockResolvedValue({
        hasKey: true,
        hasProfile: false,
        skipped: false,
      });

      render(<SplashView onAnimationEnd={vi.fn()} />);

      // Advance timers by 3000ms to exit splash screen state. Wrap in act so
      // React flushes the async status-fetch state update + re-render.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      expect(screen.getByText("Create Agentic Profile")).toBeTruthy();
      expect(screen.getByPlaceholderText("e.g. Alice Smith")).toBeTruthy();
      expect(screen.getByText("Skip Profile")).toBeTruthy();
    });

    it("shows a validation error and does not save when the key is invalid", async () => {
      const getStatusMock = (window as any).electronAPI.getOnboardingStatus;
      getStatusMock.mockResolvedValue({
        hasKey: false,
        hasProfile: false,
        skipped: false,
      });
      const saveKeysMock = (window as any).electronAPI.saveOnboardingKeys;

      render(<SplashView onAnimationEnd={vi.fn()} />);

      // Advance timers by 3000ms to reach Step A. Wrap in act so React
      // flushes the async state update + re-render before we query.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      const input = screen.getByPlaceholderText(
        "Enter Mesh API Key (e.g. mesh_...)",
      );
      fireEvent.change(input, { target: { value: "notavalidkey" } });

      const submitButton = screen.getByText("Save & Continue");
      fireEvent.click(submitButton);

      expect(
        screen.getByText(
          "Please enter a valid Mesh API Key (it should start with 'mesh_').",
        ),
      ).toBeTruthy();
      expect(saveKeysMock).not.toHaveBeenCalled();
    });
  });
});
