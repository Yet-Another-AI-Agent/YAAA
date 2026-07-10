import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cloneMcpIntegrationDefinition,
  validateMcpIntegrationDefinition,
} from "./mcp-integrations.js";
import { Workspace } from "./workspace.js";

const temporaryDirectories: string[] = [];

function createWorkspace(): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaaa-mcp-registry-"));
  temporaryDirectories.push(root);
  return new Workspace(root);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Workspace MCP integration registry", () => {
  it("persists global metadata without executing or enabling the server", () => {
    const workspace = createWorkspace();
    const marker = path.join(workspace.getYaaaDir(), "must-not-exist");
    const registered = workspace.registerMcpIntegration(
      { kind: "global" },
      {
        id: "review-graph",
        displayName: "Code Review Graph",
        transport: {
          kind: "stdio",
          command: "touch",
          args: [marker],
        },
      },
    );

    expect(registered.state).toEqual({ trust: "untrusted", enabled: false });
    expect(fs.existsSync(marker)).toBe(false);
    expect(new Workspace(workspace.getYaaaDir()).listMcpIntegrations({ kind: "global" }))
      .toEqual([registered]);
  });

  it("keeps task integrations isolated and removes them with the task", () => {
    const workspace = createWorkspace();
    const task = workspace.createTask("Review a change");
    const definition = {
      id: "project-tools",
      displayName: "Project Tools",
      transport: { kind: "http" as const, url: "https://mcp.example.test" },
    };

    workspace.registerMcpIntegration({ kind: "global" }, definition);
    workspace.registerMcpIntegration(
      { kind: "task", taskId: task.taskId },
      definition,
    );

    expect(workspace.listMcpIntegrations({ kind: "global" })).toHaveLength(1);
    expect(
      workspace.listMcpIntegrations({ kind: "task", taskId: task.taskId }),
    ).toHaveLength(1);

    workspace.deleteTask(task.taskId);

    expect(workspace.listMcpIntegrations({ kind: "global" })).toHaveLength(1);
    expect(() =>
      workspace.listMcpIntegrations({ kind: "task", taskId: task.taskId }),
    ).toThrow("Task not found.");
  });

  it("requires explicit trust before enabling and resets trust when metadata changes", () => {
    const workspace = createWorkspace();
    const scope = { kind: "global" } as const;
    workspace.registerMcpIntegration(scope, {
      id: "remote",
      displayName: "Remote MCP",
      transport: { kind: "http", url: "https://one.example.test/mcp" },
    });

    expect(() =>
      workspace.updateMcpIntegrationState(scope, "remote", { enabled: true }),
    ).toThrow("must be trusted");
    expect(
      workspace.updateMcpIntegrationState(scope, "remote", {
        trust: "trusted",
        enabled: true,
      }).state,
    ).toEqual({ trust: "trusted", enabled: true });

    const changed = workspace.registerMcpIntegration(scope, {
      id: "remote",
      displayName: "Remote MCP",
      transport: { kind: "http", url: "https://two.example.test/mcp" },
    });
    expect(changed.state).toEqual({ trust: "untrusted", enabled: false });
  });

  it("rejects malformed ids, transports, and unknown task scopes", () => {
    const workspace = createWorkspace();

    expect(() =>
      workspace.registerMcpIntegration(
        { kind: "global" },
        {
          id: "../../escape",
          displayName: "Escape",
          transport: { kind: "stdio", command: "server" },
        },
      ),
    ).toThrow("Integration id");
    expect(() =>
      workspace.registerMcpIntegration(
        { kind: "global" },
        {
          id: "local-file",
          displayName: "Local file",
          transport: { kind: "http", url: "file:///tmp/server" },
        },
      ),
    ).toThrow("must use http or https");
    expect(() =>
      workspace.registerMcpIntegration(
        { kind: "task", taskId: "missing-task" },
        {
          id: "tools",
          displayName: "Tools",
          transport: { kind: "stdio", command: "server" },
        },
      ),
    ).toThrow("Task not found.");
  });

  it("validates every declarative metadata boundary without executing a server", () => {
    const validate = (definition: unknown) => () => validateMcpIntegrationDefinition(definition);
    const base = {
      id: "valid-server",
      displayName: "Valid server",
      transport: { kind: "stdio", command: "server" },
    };

    expect(validate(null)).toThrow("must be an object");
    expect(validate({ ...base, id: 42 })).toThrow("Integration id");
    expect(validate({ ...base, displayName: 42 })).toThrow("display name");
    expect(validate({ ...base, displayName: "   " })).toThrow("display name");
    expect(validate({ ...base, description: 42 })).toThrow("description");
    expect(validate({ ...base, transport: null })).toThrow("transport is required");
    expect(validate({ ...base, transport: { kind: "stdio", command: 42 } })).toThrow(
      "requires a command",
    );
    expect(validate({ ...base, transport: { kind: "stdio", command: " " } })).toThrow(
      "requires a command",
    );
    expect(
      validate({ ...base, transport: { kind: "stdio", command: "server", args: "--flag" } }),
    ).toThrow("arguments must be strings");
    expect(
      validate({ ...base, transport: { kind: "stdio", command: "server", args: [42] } }),
    ).toThrow("arguments must be strings");
    expect(validate({ ...base, transport: { kind: "socket" } })).toThrow("stdio or http");
    expect(validate({ ...base, transport: { kind: "http", url: 42 } })).toThrow("valid URL");
    expect(validate({ ...base, transport: { kind: "http", url: "not a url" } })).toThrow(
      "valid URL",
    );
    expect(
      validate({ ...base, transport: { kind: "http", url: "https://user:secret@example.test" } }),
    ).toThrow("must not contain credentials");
  });

  it("clones optional stdio and HTTP metadata without sharing mutable arguments", () => {
    const args = ["--project", "."];
    const stdio = cloneMcpIntegrationDefinition({
      id: "stdio-server",
      displayName: "Stdio server",
      description: "Local tools",
      transport: { kind: "stdio", command: "server", args },
    });
    const minimalStdio = cloneMcpIntegrationDefinition({
      id: "minimal-stdio",
      displayName: "Minimal stdio",
      transport: { kind: "stdio", command: "server" },
    });
    const http = cloneMcpIntegrationDefinition({
      id: "http-server",
      displayName: "HTTP server",
      description: "Remote tools",
      transport: { kind: "http", url: "https://example.test/mcp" },
    });

    expect(stdio).toEqual({
      id: "stdio-server",
      displayName: "Stdio server",
      description: "Local tools",
      transport: { kind: "stdio", command: "server", args },
    });
    expect((stdio.transport as { args?: string[] }).args).not.toBe(args);
    expect(minimalStdio).not.toHaveProperty("description");
    expect((minimalStdio.transport as { args?: string[] }).args).toBeUndefined();
    expect(http).toHaveProperty("description", "Remote tools");
  });

  it("supports lookup, partial state updates, and idempotent removal", () => {
    const workspace = createWorkspace();
    const scope = { kind: "global" } as const;
    workspace.registerMcpIntegration(scope, {
      id: "stateful",
      displayName: "Stateful server",
      transport: { kind: "http", url: "https://example.test/mcp" },
    });

    expect(workspace.getMcpIntegration(scope, "missing")).toBeNull();
    expect(() => workspace.updateMcpIntegrationState(scope, "missing", {})).toThrow(
      "MCP integration not found",
    );
    expect(workspace.updateMcpIntegrationState(scope, "stateful", { trust: "trusted" }).state)
      .toEqual({ trust: "trusted", enabled: false });
    expect(workspace.updateMcpIntegrationState(scope, "stateful", { enabled: true }).state)
      .toEqual({ trust: "trusted", enabled: true });
    expect(workspace.updateMcpIntegrationState(scope, "stateful", { enabled: false }).state)
      .toEqual({ trust: "trusted", enabled: false });
    expect(workspace.removeMcpIntegration(scope, "stateful")).toBe(true);
    expect(workspace.removeMcpIntegration(scope, "stateful")).toBe(false);
  });
});
