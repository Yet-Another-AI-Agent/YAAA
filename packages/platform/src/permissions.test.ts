import path from "node:path";
import type { ToolCall } from "@yaaa/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentScope, PermissionEngine } from "./permissions.js";

describe("PermissionEngine", () => {
  let engine: PermissionEngine;
  let defaultScope: AgentScope;

  beforeEach(() => {
    engine = new PermissionEngine();
    defaultScope = {
      capabilities: ["files", "shell"],
      allowedPaths: [process.cwd()],
      riskCeiling: "medium",
    };
  });

  it("should deny everything if no scope is granted for the agent", async () => {
    const call: ToolCall = {
      id: "c-1",
      capability: "files",
      method: "readFile",
      args: { path: "a.txt" },
    };

    expect(await engine.checkCall("agent-unknown", call)).toBe("deny");
  });

  it("should deny if the capability is not in the granted capabilities list", async () => {
    engine.grantScope("agent-1", {
      ...defaultScope,
      capabilities: ["files"], // no 'shell'
    });

    const call: ToolCall = {
      id: "c-1",
      capability: "shell",
      method: "runCommand",
      args: { command: "ls" },
    };

    expect(await engine.checkCall("agent-1", call)).toBe("deny");
  });

  it("should allow files operations inside allowed paths and deny traversal", async () => {
    engine.grantScope("agent-1", defaultScope);

    const insideCall: ToolCall = {
      id: "c-1",
      capability: "files",
      method: "writeFile",
      args: { path: "summary.txt" },
    };
    expect(await engine.checkCall("agent-1", insideCall)).toBe("auto");

    const outsideCall: ToolCall = {
      id: "c-2",
      capability: "files",
      method: "writeFile",
      args: { path: "../../../etc/passwd" },
    };
    expect(await engine.checkCall("agent-1", outsideCall)).toBe("deny");
  });

  it("should return confirm for risky shell commands", async () => {
    engine.grantScope("agent-1", defaultScope);

    const riskyCall: ToolCall = {
      id: "c-1",
      capability: "shell",
      method: "runCommand",
      args: { command: "rm -rf /" },
    };
    expect(await engine.checkCall("agent-1", riskyCall)).toBe("confirm");
  });

  it("should return confirm if risk ceiling is low but capability is shell", async () => {
    engine.grantScope("agent-1", {
      ...defaultScope,
      riskCeiling: "low",
    });

    const standardCall: ToolCall = {
      id: "c-1",
      capability: "shell",
      method: "runCommand",
      args: { command: "ls" },
    };
    expect(await engine.checkCall("agent-1", standardCall)).toBe("confirm");
  });

  it("should call approval handler and execute function if approved", async () => {
    engine.grantScope("agent-1", defaultScope);

    const riskyCall: ToolCall = {
      id: "c-1",
      capability: "shell",
      method: "runCommand",
      args: { command: "rm -rf file" },
    };

    const approvalHandler = vi.fn().mockResolvedValue(true);
    engine.registerApprovalHandler(approvalHandler);

    const executeFn = vi.fn().mockResolvedValue("done");
    const result = await engine.executeWithApproval(
      "agent-1",
      riskyCall,
      executeFn,
    );

    expect(approvalHandler).toHaveBeenCalledWith("agent-1", riskyCall);
    expect(executeFn).toHaveBeenCalled();
    expect(result).toBe("done");
  });

  it("should throw error if approval is required but handler returns false", async () => {
    engine.grantScope("agent-1", defaultScope);

    const riskyCall: ToolCall = {
      id: "c-1",
      capability: "shell",
      method: "runCommand",
      args: { command: "rm -rf file" },
    };

    engine.registerApprovalHandler(async () => false);

    await expect(
      engine.executeWithApproval("agent-1", riskyCall, async () => "done"),
    ).rejects.toThrow("User rejected execution of shell.runCommand");
  });

  it("should throw error if approval is required but no handler registered", async () => {
    engine.grantScope("agent-1", defaultScope);

    const riskyCall: ToolCall = {
      id: "c-1",
      capability: "shell",
      method: "runCommand",
      args: { command: "rm -rf file" },
    };

    await expect(
      engine.executeWithApproval("agent-1", riskyCall, async () => "done"),
    ).rejects.toThrow(
      "Approval required for shell.runCommand but no approval handler was registered.",
    );
  });

  it("should get scope of agent correctly", () => {
    engine.grantScope("agent-1", defaultScope);
    expect(engine.getScope("agent-1")).toBe(defaultScope);
    expect(engine.getScope("unknown")).toBeUndefined();
  });

  it("does not treat a sibling path with a shared prefix as allowed", async () => {
    const allowedPath = path.join(process.cwd(), "workspace");
    engine.grantScope("agent-1", {
      ...defaultScope,
      allowedPaths: [allowedPath],
    });

    await expect(
      engine.checkCall("agent-1", {
        id: "c-1",
        capability: "files",
        method: "writeFile",
        args: { path: `${allowedPath}-other/report.md` },
      }),
    ).resolves.toBe("deny");
  });

  it("applies global, task, then agent policies in specificity order", async () => {
    engine.grantScope("agent-1", defaultScope, "task-a");
    engine.savePolicy({
      scope: "global",
      capability: "shell",
      decision: "deny",
    });
    engine.savePolicy({
      scope: "task",
      taskId: "task-a",
      capability: "shell",
      decision: "confirm",
    });

    const call: ToolCall = {
      id: "c-1",
      capability: "shell",
      method: "runCommand",
      args: { command: "ls" },
    };
    await expect(engine.checkCall("agent-1", call)).resolves.toBe("confirm");

    engine.savePolicy({
      scope: "agent",
      agentId: "agent-1",
      capability: "shell",
      decision: "auto",
    });
    await expect(engine.checkCall("agent-1", call)).resolves.toBe("auto");
  });

  it("prefers a method policy over a capability policy at the same scope", async () => {
    engine.grantScope("agent-1", defaultScope, "task-a");
    engine.savePolicy({
      scope: "task",
      taskId: "task-a",
      capability: "shell",
      decision: "deny",
    });
    engine.savePolicy({
      scope: "task",
      taskId: "task-a",
      capability: "shell",
      method: "runCommand",
      decision: "auto",
    });

    await expect(
      engine.checkCall("agent-1", {
        id: "c-1",
        capability: "shell",
        method: "runCommand",
        args: { command: "ls" },
      }),
    ).resolves.toBe("auto");
  });

  it("never lets an allow policy expand the agent's original capability scope", async () => {
    engine.grantScope("agent-1", { ...defaultScope, capabilities: ["files"] });
    engine.savePolicy({
      scope: "global",
      capability: "shell",
      decision: "auto",
    });

    await expect(
      engine.checkCall("agent-1", {
        id: "c-1",
        capability: "shell",
        method: "runCommand",
        args: { command: "ls" },
      }),
    ).resolves.toBe("deny");
  });

  it("records an approved always-allow choice and uses it for the next matching call", async () => {
    engine.grantScope("agent-1", defaultScope, "task-a");
    const call: ToolCall = {
      id: "c-1",
      capability: "shell",
      method: "runCommand",
      args: { command: "rm -rf scratch" },
    };
    const handler = vi
      .fn()
      .mockResolvedValue({ approved: true, alwaysAllow: "task" });
    engine.registerApprovalHandler(handler);

    await expect(
      engine.executeWithApproval("agent-1", call, async () => "done"),
    ).resolves.toBe("done");
    await expect(engine.checkCall("agent-1", call)).resolves.toBe("auto");
    expect(engine.getPolicies()).toMatchObject([
      {
        scope: "task",
        taskId: "task-a",
        capability: "shell",
        method: "runCommand",
        decision: "auto",
      },
    ]);
  });

  it("exports and restores always-allow policies for durable storage", async () => {
    engine.grantScope("agent-1", defaultScope, "task-a");
    const saved = engine.rememberApproval(
      "agent-1",
      {
        id: "c-1",
        capability: "shell",
        method: "runCommand",
        args: { command: "rm -rf scratch" },
      },
      "global",
    );

    const restored = new PermissionEngine();
    restored.grantScope("agent-1", defaultScope, "task-a");
    restored.restorePolicies(engine.getPolicies());

    expect(restored.getPolicies()).toEqual([saved]);
    await expect(
      restored.checkCall("agent-1", {
        id: "c-2",
        capability: "shell",
        method: "runCommand",
        args: { command: "rm -rf another" },
      }),
    ).resolves.toBe("auto");
  });

  it("rejects malformed scoped policies before they can be persisted", () => {
    expect(() =>
      engine.savePolicy({
        scope: "global",
        capability: "",
        decision: "auto",
      }),
    ).toThrow("Permission policy capability is required.");
    expect(() =>
      engine.savePolicy({
        scope: "task",
        capability: "shell",
        decision: "auto",
      }),
    ).toThrow("Task-scoped permission policies require a taskId.");
    expect(() =>
      engine.savePolicy({
        scope: "agent",
        capability: "shell",
        decision: "auto",
      }),
    ).toThrow("Agent-scoped permission policies require an agentId.");
  });

  it("preserves explicit policy metadata, reuses equivalent IDs, and removes policies", () => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    const first = engine.savePolicy({
      id: "custom-policy",
      createdAt,
      scope: "global",
      capability: "files",
      method: "readFile",
      decision: "auto",
    });
    const replacement = engine.savePolicy({
      scope: "global",
      capability: "files",
      method: "readFile",
      decision: "deny",
    });

    expect(first).toMatchObject({ id: "custom-policy", createdAt });
    expect(replacement).toMatchObject({ id: "custom-policy", createdAt });
    expect(engine.removePolicy("custom-policy")).toBe(true);
    expect(engine.removePolicy("custom-policy")).toBe(false);
  });

  it("covers resource-free calls and exact allowed paths", async () => {
    engine.grantScope("agent-1", defaultScope);

    await expect(
      engine.checkCall("agent-1", {
        id: "c-1",
        capability: "files",
        method: "listFiles",
        args: {},
      }),
    ).resolves.toBe("auto");
    await expect(
      engine.checkCall("agent-1", {
        id: "c-2",
        capability: "shell",
        method: "runCommand",
        args: {},
      }),
    ).resolves.toBe("auto");
    await expect(
      engine.checkCall("agent-1", {
        id: "c-3",
        capability: "files",
        method: "listFiles",
        args: { path: process.cwd() },
      }),
    ).resolves.toBe("auto");
  });

  it("denies execution before invoking the operation", async () => {
    const execute = vi.fn(async () => "done");
    await expect(
      engine.executeWithApproval(
        "unknown-agent",
        { id: "c-1", capability: "files", method: "readFile", args: { path: "a.txt" } },
        execute,
      ),
    ).rejects.toThrow("Permission denied");
    expect(execute).not.toHaveBeenCalled();
  });

  it("validates remembered task approvals and restores non-sequential policy IDs", () => {
    engine.grantScope("agent-1", defaultScope);
    expect(() =>
      engine.rememberApproval(
        "agent-1",
        { id: "c-1", capability: "shell", method: "runCommand", args: { command: "ls" } },
        "task",
      ),
    ).toThrow("task permission policy requires a taskId.");

    engine.restorePolicies([
      {
        id: "custom-id",
        createdAt: "2026-01-01T00:00:00.000Z",
        scope: "global",
        capability: "shell",
        decision: "auto",
      },
    ]);
    expect(engine.getPolicies()).toHaveLength(1);
  });
});
