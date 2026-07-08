// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLogState } from "./useLogState";

describe("useLogState", () => {
  it("initial state has an empty logs array", () => {
    const { result } = renderHook(() => useLogState());
    expect(result.current.logs).toEqual([]);
  });

  it("addLog adds an entry with correct source and content", () => {
    const { result } = renderHook(() => useLogState());

    act(() => {
      result.current.addLog("system", "hello");
    });

    expect(result.current.logs).toHaveLength(1);
    expect(result.current.logs[0].source).toBe("system");
    expect(result.current.logs[0].content).toBe("hello");
  });

  it("addLog sets a time string on the entry", () => {
    const { result } = renderHook(() => useLogState());

    act(() => {
      result.current.addLog("agent", "some content");
    });

    expect(typeof result.current.logs[0].time).toBe("string");
    expect(result.current.logs[0].time.length).toBeGreaterThan(0);
  });

  it("multiple addLog calls generate unique ids", () => {
    const { result } = renderHook(() => useLogState());

    act(() => {
      result.current.addLog("system", "first");
      result.current.addLog("agent", "second");
      result.current.addLog("orchestrator", "third");
    });

    const ids = result.current.logs.map((l) => l.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(3);
  });

  it("clearLogs empties the array", () => {
    const { result } = renderHook(() => useLogState());

    act(() => {
      result.current.addLog("system", "msg1");
      result.current.addLog("agent", "msg2");
    });

    expect(result.current.logs).toHaveLength(2);

    act(() => {
      result.current.clearLogs();
    });

    expect(result.current.logs).toEqual([]);
  });

  it("log entry has id, time, source, content fields", () => {
    const { result } = renderHook(() => useLogState());

    act(() => {
      result.current.addLog("orchestrator", "test content");
    });

    const log = result.current.logs[0];
    expect(log).toHaveProperty("id");
    expect(log).toHaveProperty("time");
    expect(log).toHaveProperty("source");
    expect(log).toHaveProperty("content");
  });
});
