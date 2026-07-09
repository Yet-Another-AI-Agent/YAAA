import { describe, it, expect } from "vitest";
import { isValidMeshApiKey } from "./validation";

describe("isValidMeshApiKey", () => {
  it("accepts a mesh_-prefixed key", () => {
    expect(isValidMeshApiKey("mesh_abcdefgh")).toBe(true);
  });

  it("accepts keys from other providers (no fixed prefix)", () => {
    expect(isValidMeshApiKey("sk-1234567890")).toBe(true);
    expect(isValidMeshApiKey("github_pat_abcdefgh")).toBe(true);
    expect(isValidMeshApiKey("AbC123XyZ")).toBe(true);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(isValidMeshApiKey("  abcdefgh  ")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidMeshApiKey("")).toBe(false);
  });

  it("rejects a whitespace-only string", () => {
    expect(isValidMeshApiKey("   ")).toBe(false);
  });

  it("rejects a token that is too short", () => {
    expect(isValidMeshApiKey("short")).toBe(false);
  });

  it("rejects tokens containing whitespace", () => {
    expect(isValidMeshApiKey("abcd 1234")).toBe(false);
  });
});
