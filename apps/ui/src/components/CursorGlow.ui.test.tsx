// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import React from "react";
import { CursorGlow } from "./CursorGlow";

describe("CursorGlow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders without error", () => {
    const { container } = render(<CursorGlow />);
    const el = container.querySelector(".cursor-glow");
    expect(el).toBeTruthy();
  });

  it("rendered element has aria-hidden set to true", () => {
    const { container } = render(<CursorGlow />);
    const el = container.querySelector(".cursor-glow");
    expect(el?.getAttribute("aria-hidden")).toBe("true");
  });

  it("attaches a mousemove listener to window", () => {
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    render(<CursorGlow />);

    const calls = addEventListenerSpy.mock.calls.filter(([event]) => event === "mousemove");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("removes the mousemove listener on unmount", () => {
    const removeEventListenerSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<CursorGlow />);

    unmount();

    const calls = removeEventListenerSpy.mock.calls.filter(([event]) => event === "mousemove");
    expect(calls.length).toBeGreaterThan(0);
  });
});
