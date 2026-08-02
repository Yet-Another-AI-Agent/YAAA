import { describe, expect, it, vi } from "vitest";
import { cloneValue } from "./clone";

describe("cloneValue", () => {
  it("clones structured values without sharing references", () => {
    const value = { nested: { list: [1, 2] } };
    const copy = cloneValue(value);
    copy.nested.list.push(3);
    expect(value.nested.list).toEqual([1, 2]);
  });

  it("preserves callback values through the fallback clone", () => {
    const action = vi.fn();
    const copy = cloneValue({ action });
    copy.action();
    expect(action).toHaveBeenCalledOnce();
  });

  it("clones arrays and primitives when structuredClone is unavailable", () => {
    vi.stubGlobal("structuredClone", undefined);
    const copy = cloneValue([{ value: "one" }]);
    expect(copy).toEqual([{ value: "one" }]);
    expect(cloneValue("text")).toBe("text");
    vi.unstubAllGlobals();
  });
});
