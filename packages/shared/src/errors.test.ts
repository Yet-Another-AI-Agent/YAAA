import { describe, it, expect } from "vitest";
import { isInsufficientFundsError, INSUFFICIENT_FUNDS_CODE } from "./errors.js";

describe("isInsufficientFundsError", () => {
  it("matches HTTP 402 payment-required errors", () => {
    expect(isInsufficientFundsError({ status: 402 })).toBe(true);
    expect(isInsufficientFundsError({ response: { status: 402 } })).toBe(true);
  });

  it("matches our own coded error", () => {
    expect(isInsufficientFundsError({ code: INSUFFICIENT_FUNDS_CODE })).toBe(true);
  });

  it("matches insufficient_quota type from OpenAI-style errors", () => {
    expect(isInsufficientFundsError({ type: "insufficient_quota" })).toBe(true);
    expect(isInsufficientFundsError({ error: { type: "insufficient_quota" } })).toBe(true);
  });

  it("matches message/summary keywords", () => {
    expect(isInsufficientFundsError("Insufficient balance to run this request")).toBe(true);
    expect(isInsufficientFundsError(new Error("You have exceeded your current quota"))).toBe(true);
    expect(isInsufficientFundsError("Execution failed: please add credit to your account")).toBe(true);
    expect(isInsufficientFundsError("402 Payment Required")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isInsufficientFundsError(null)).toBe(false);
    expect(isInsufficientFundsError(new Error("connection refused"))).toBe(false);
    expect(isInsufficientFundsError("Task execution failed due to subtask failure.")).toBe(false);
    expect(isInsufficientFundsError({ status: 500 })).toBe(false);
  });
});
