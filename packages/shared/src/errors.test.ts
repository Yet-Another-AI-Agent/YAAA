import { describe, it, expect } from "vitest";
import { getErrorFingerprint, isInsufficientFundsError, INSUFFICIENT_FUNDS_CODE, isTransientError } from "./errors.js";

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

  it("matches token/usage phrasings", () => {
    expect(isInsufficientFundsError("No tokens left on your account")).toBe(true);
    expect(isInsufficientFundsError("You are out of tokens")).toBe(true);
    expect(isInsufficientFundsError("Usage limit reached")).toBe(true);
    expect(isInsufficientFundsError("insufficient tokens")).toBe(true);
    expect(isInsufficientFundsError("balance remaining: 0")).toBe(true);
  });

  it("does not match auth-token errors", () => {
    expect(isInsufficientFundsError("invalid token")).toBe(false);
    expect(isInsufficientFundsError("authentication token expired")).toBe(false);
  });

  it("does not match unrelated errors", () => {
    expect(isInsufficientFundsError(null)).toBe(false);
    expect(isInsufficientFundsError(new Error("connection refused"))).toBe(false);
    expect(isInsufficientFundsError("Task execution failed due to subtask failure.")).toBe(false);
    expect(isInsufficientFundsError({ status: 500 })).toBe(false);
  });
});

describe("isTransientError", () => {
  it("matches rate limit and timeout status codes", () => {
    expect(isTransientError({ status: 429 })).toBe(true);
    expect(isTransientError({ statusCode: 408 })).toBe(true);
    expect(isTransientError({ response: { status: 504 } })).toBe(true);
    expect(isTransientError({ status: 500 })).toBe(true);
  });

  it("matches transient message keywords", () => {
    expect(isTransientError("rate limit exceeded")).toBe(true);
    expect(isTransientError(new Error("Request timed out"))).toBe(true);
    expect(isTransientError("Failed to connect: network error")).toBe(true);
    expect(isTransientError("Service Unavailable - please try again later")).toBe(true);
    expect(isTransientError("The model provider is temporarily unavailable. Please try again shortly.")).toBe(true);
    expect(isTransientError({ code: "upstream_error" })).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError("invalid credit card")).toBe(false);
    expect(isTransientError({ status: 400 })).toBe(false);
  });
});

describe("getErrorFingerprint", () => {
  it("groups the same failure when volatile ids and counts change", () => {
    expect(getErrorFingerprint(new Error("Request 123 failed at /tmp/run-1/output.txt")))
      .toBe(getErrorFingerprint(new Error("Request 456 failed at /tmp/run-2/output.txt")));
  });

  it("keeps meaningfully different failures separate", () => {
    expect(getErrorFingerprint(new Error("connection timeout")))
      .not.toBe(getErrorFingerprint(new Error("permission denied")));
  });
});
