import { describe, expect, it } from "vitest";
import { mergeRecursive } from "./recursive-data";

describe("mergeRecursive", () => {
  it("returns a clone for an undefined patch", () => {
    const source = { text: "same" };
    const result = mergeRecursive(source, undefined);
    expect(result).toEqual(source);
    expect(result).not.toBe(source);
  });

  it("merges nested records and replaces scalar values", () => {
    expect(mergeRecursive({ nested: { count: 1 }, text: "old" }, { nested: { count: 2 }, text: "new" })).toEqual({ nested: { count: 2 }, text: "new" });
  });

  it("updates identified array items and appends new items", () => {
    const source = { controls: [{ id: "one", value: false }] };
    expect(mergeRecursive(source, { controls: [{ id: "one", value: true }, { id: "two", value: false }] })).toEqual({ controls: [{ id: "one", value: true }, { id: "two", value: false }] });
  });

  it("appends arrays without identified records", () => {
    expect(mergeRecursive([1], [2, 3])).toEqual([1, 2, 3]);
  });
});
