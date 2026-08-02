// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SplashScreen } from "./SplashScreen";

describe("SplashScreen", () => {
  afterEach(cleanup);
  it("smoothly renders the supplied progress and message", () => {
    render(<SplashScreen progress={42} message="Loading bot definitions…" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByText("Loading bot definitions…")).toBeInTheDocument();
    expect(screen.getByAltText("YAAA Logo")).toBeInTheDocument();
  });
  it("emits success and navigates home once", () => {
    const onEvent = vi.fn();
    const onSuccess = vi.fn();
    const { rerender } = render(<SplashScreen status="success" progress={100} onEvent={onEvent} onSuccess={onSuccess} />);
    rerender(<SplashScreen status="success" progress={100} onEvent={onEvent} onSuccess={onSuccess} />);
    expect(onEvent).toHaveBeenCalledWith({ kind: "loaded-success" });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
  it("shows and emits a failure message once", () => {
    const onEvent = vi.fn();
    render(<SplashScreen status="failed" errorMessage="Network unavailable" onEvent={onEvent} />);
    expect(screen.getByText("Network unavailable")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(onEvent).toHaveBeenCalledWith({ kind: "failed", message: "Network unavailable" });
  });
});
