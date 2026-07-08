import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolCall } from "@yaaa/shared";
import { PermissionEngine, type AgentScope } from "./permissions.js";

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
    const result = await engine.executeWithApproval("agent-1", riskyCall, executeFn);

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
      engine.executeWithApproval("agent-1", riskyCall, async () => "done")
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
      engine.executeWithApproval("agent-1", riskyCall, async () => "done")
    ).rejects.toThrow("Approval required for shell.runCommand but no approval handler was registered.");
  });

  it("should get scope of agent correctly", () => {
    engine.grantScope("agent-1", defaultScope);
    expect(engine.getScope("agent-1")).toBe(defaultScope);
    expect(engine.getScope("unknown")).toBeUndefined();
  });
});
