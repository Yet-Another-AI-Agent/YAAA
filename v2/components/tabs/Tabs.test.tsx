// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tabs } from "./Tabs";

describe("Tabs", () => {
  afterEach(cleanup);
  it("marks the selected tab and emits changes", () => {
    const onChange = vi.fn();
    render(<Tabs value="one" onChange={onChange} tabs={[{ id: "one", label: "One", count: 2 }, { id: "two", label: "Two" }]} />);
    expect(screen.getByRole("tab", { name: "One 2" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Two" }));
    expect(onChange).toHaveBeenCalledWith("two");
  });
});

