import { describe, it, expect } from "vitest";
import {
  ORCHESTRATOR_DISPLAY,
  isOrchestratorSender,
  agentIdentity,
  displaySender,
  humanizeChannelName,
} from "./displayNames";

describe("isOrchestratorSender", () => {
  it("matches every orchestrator alias regardless of case", () => {
    for (const alias of ["orchestrator", "Orchestrator", "@orchestrator", "Supervisor", "supervisor", "YAAA", "yaaa"]) {
      expect(isOrchestratorSender(alias)).toBe(true);
    }
  });

  it("matches numbered orchestrator aliases", () => {
    expect(isOrchestratorSender("supervisor-1")).toBe(true);
  });

  it("does not match agents or users", () => {
    expect(isOrchestratorSender("files-agent-zbim")).toBe(false);
    expect(isOrchestratorSender("User")).toBe(false);
    expect(isOrchestratorSender("@qa-tester-2")).toBe(false);
  });
});

describe("agentIdentity", () => {
  it("is deterministic for the same id", () => {
    const a = agentIdentity("files-agent-zbim");
    const b = agentIdentity("files-agent-zbim");
    expect(a).toEqual(b);
  });

  it("derives a role label from the capability prefix", () => {
    expect(agentIdentity("files-agent-zbim").roleLabel).toBe("Software Engineer");
    expect(agentIdentity("verify-agent-rxtx").roleLabel).toBe("QA Tester");
  });

  it("prefers the roster role when provided", () => {
    expect(agentIdentity("files-agent-1", "UiArchitectAgent").roleLabel).toBe("UI Architect");
  });

  it("produces a mention and a combined display label", () => {
    const id = agentIdentity("files-agent-zbim");
    expect(id.mention).toBe(`@${id.firstName.toLowerCase()}`);
    expect(id.display).toBe(`${id.firstName} (${id.roleLabel})`);
  });

  it("falls back to a generic role for unknown ids", () => {
    expect(agentIdentity("mystery").roleLabel).toBe("Agent");
  });
});

describe("displaySender", () => {
  it("renders orchestrator aliases as YAAA", () => {
    expect(displaySender("orchestrator")).toBe(ORCHESTRATOR_DISPLAY);
    expect(displaySender("Supervisor")).toBe(ORCHESTRATOR_DISPLAY);
  });

  it("passes User, System, and generic Agent through unchanged", () => {
    expect(displaySender("User")).toBe("User");
    expect(displaySender("System")).toBe("System");
    expect(displaySender("Agent")).toBe("Agent");
  });

  it("maps an agent id to a human name and role", () => {
    const label = displaySender("files-agent-zbim");
    expect(label).toMatch(/\(Software Engineer\)$/);
  });

  it("uses the role lookup when available", () => {
    const label = displaySender("files-agent-1", (id) => (id === "files-agent-1" ? "DesignerAgent" : undefined));
    expect(label).toMatch(/\(Designer\)$/);
  });
});

describe("humanizeChannelName", () => {
  it("turns a slug into spaced words", () => {
    expect(humanizeChannelName("hello-world-python")).toBe("hello world python");
  });

  it("strips a leading hash and collapses separators", () => {
    expect(humanizeChannelName("#build__the_app")).toBe("build the app");
  });

  it("falls back to a placeholder when empty", () => {
    expect(humanizeChannelName("")).toBe("new mission");
    expect(humanizeChannelName("#")).toBe("new mission");
  });
});
