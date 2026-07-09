import { describe, it, expect } from "vitest";
import { isValidMeshApiKey } from "./validation";

describe("isValidMeshApiKey", () => {
  it("accepts a valid key with letters after the prefix", () => {
    expect(isValidMeshApiKey("mesh_abcdefgh")).toBe(true);
  });

  it("accepts a valid key with digits after the prefix", () => {
    expect(isValidMeshApiKey("mesh_12345678")).toBe(true);
  });

  it("accepts a valid key with underscores and hyphens", () => {
    expect(isValidMeshApiKey("mesh_ab_cd-1234")).toBe(true);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(isValidMeshApiKey("  mesh_abcdefgh  ")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidMeshApiKey("")).toBe(false);
  });

  it("rejects a whitespace-only string", () => {
    expect(isValidMeshApiKey("   ")).toBe(false);
  });

  it("rejects a key with the wrong prefix", () => {
    expect(isValidMeshApiKey("sk-1234567890")).toBe(false);
  });

  it("rejects the prefix alone", () => {
    expect(isValidMeshApiKey("mesh_")).toBe(false);
  });

  it("rejects a key that is too short after the prefix", () => {
    expect(isValidMeshApiKey("mesh_short")).toBe(false);
  });

  it("rejects random text without the prefix", () => {
    expect(isValidMeshApiKey("randomtext")).toBe(false);
  });
});
