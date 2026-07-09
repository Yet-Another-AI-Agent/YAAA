// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
