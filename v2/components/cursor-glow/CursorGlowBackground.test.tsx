// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorGlowBackground } from "./CursorGlowBackground";

describe("CursorGlowBackground", () => {
  let tick: (() => void) | undefined;
  beforeEach(() => { vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { tick = () => callback(0); return 1; })); vi.stubGlobal("cancelAnimationFrame", vi.fn()); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it("tracks pointer position through CSS variables without blocking input", () => {
    const { container } = render(<CursorGlowBackground />);
    const glow = container.firstElementChild as HTMLElement;
    expect(glow).toHaveAttribute("aria-hidden", "true");
    const pointerMove = new Event("pointermove");
    Object.assign(pointerMove, { clientX: 120, clientY: 80 });
    act(() => window.dispatchEvent(pointerMove));
    act(() => tick?.());
    expect(glow.style.getPropertyValue("--v2-glow-x")).toBe("120px");
    expect(glow.style.getPropertyValue("--v2-glow-y")).toBe("80px");
  });
});
