import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegisteredMcpIntegration } from "./mcp-integrations.js";
import {
  McpProvisioner,
  execFileRunner,
  type CommandRunner,
} from "./mcp-provisioner.js";

const temporaryDirectories: string[] = [];

function makeBaseDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaaa-mcp-"));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeIntegration(
  trust: "trusted" | "untrusted" = "trusted",
): RegisteredMcpIntegration {
  return {
    definition: {
      id: "code-review-graph",
      displayName: "Code Review Graph",
      transport: { kind: "stdio", command: "node", args: ["server.js"] },
    },
    scope: { kind: "global" },
    state: { trust, enabled: false },
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}

/** Fake runner that simulates a git clone producing a Node package. */
function makeCloningRunner(withPackageJson = true): CommandRunner {
  return vi.fn(async (command: string, args: string[]) => {
    if (command === "git") {
      const target = args[args.length - 1];
      fs.mkdirSync(target, { recursive: true });
      if (withPackageJson) {
        fs.writeFileSync(path.join(target, "package.json"), "{}", "utf-8");
      }
    }
  });
}

describe("McpProvisioner", () => {
  it("refuses to provision an untrusted integration", async () => {
    const provisioner = new McpProvisioner(makeBaseDir(), vi.fn());
    await expect(
      provisioner.provision(makeIntegration("untrusted"), {
        repoUrl: "https://github.com/example/mcp.git",
      }),
    ).rejects.toThrow("must be trusted");
  });

  it.each([
    "http://github.com/example/mcp.git",
    "git@github.com:example/mcp.git",
    "https://user:pass@github.com/example/mcp.git",
    "not a url",
  ])("rejects unsafe source %j", async (repoUrl) => {
    const provisioner = new McpProvisioner(makeBaseDir(), vi.fn());
    await expect(
      provisioner.provision(makeIntegration(), { repoUrl }),
    ).rejects.toThrow(/https|valid URL|credentials/);
  });

  it("clones and installs a trusted Node-based server", async () => {
    const baseDir = makeBaseDir();
    const runner = makeCloningRunner();
    const provisioner = new McpProvisioner(baseDir, runner);

    const result = await provisioner.provision(makeIntegration(), {
      repoUrl: "https://github.com/example/mcp.git",
    });

    expect(result.installDir).toBe(path.join(baseDir, "code-review-graph"));
    expect(result.steps).toEqual([
      "git clone https://github.com/example/mcp.git",
      "npm install",
    ]);
    expect(runner).toHaveBeenCalledWith(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "https://github.com/example/mcp.git",
        result.installDir,
      ],
      expect.objectContaining({ cwd: baseDir }),
    );
    expect(runner).toHaveBeenCalledWith(
      "npm",
      ["install", "--no-fund", "--no-audit"],
      expect.objectContaining({ cwd: result.installDir }),
    );
  });

  it("skips dependency install when the checkout has no package.json", async () => {
    const provisioner = new McpProvisioner(
      makeBaseDir(),
      makeCloningRunner(false),
    );

    const result = await provisioner.provision(makeIntegration(), {
      repoUrl: "https://github.com/example/mcp.git",
    });

    expect(result.steps).toEqual([
      "git clone https://github.com/example/mcp.git",
    ]);
  });

  it("cleans up the partial checkout when installation fails", async () => {
    const baseDir = makeBaseDir();
    const runner: CommandRunner = vi.fn(async (command, args) => {
      if (command === "git") {
        const target = args[args.length - 1];
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, "package.json"), "{}", "utf-8");
        return;
      }
      throw new Error("npm exploded");
    });
    const provisioner = new McpProvisioner(baseDir, runner);

    await expect(
      provisioner.provision(makeIntegration(), {
        repoUrl: "https://github.com/example/mcp.git",
      }),
    ).rejects.toThrow("npm exploded");
    expect(fs.existsSync(path.join(baseDir, "code-review-graph"))).toBe(false);
  });

  it("refuses to install twice into the same directory", async () => {
    const baseDir = makeBaseDir();
    fs.mkdirSync(path.join(baseDir, "code-review-graph"), { recursive: true });
    const provisioner = new McpProvisioner(baseDir, vi.fn());

    await expect(
      provisioner.provision(makeIntegration(), {
        repoUrl: "https://github.com/example/mcp.git",
      }),
    ).rejects.toThrow("already installed");
  });

  it("execFileRunner resolves on success and rejects on a failing command", async () => {
    const cwd = makeBaseDir();
    await expect(
      execFileRunner(process.execPath, ["-e", "process.exit(0)"], {
        cwd,
        timeoutMs: 30_000,
      }),
    ).resolves.toBeUndefined();
    await expect(
      execFileRunner(process.execPath, ["-e", "process.exit(1)"], {
        cwd,
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow();
  });

  it("removes an installed checkout but never a path outside the MCP dir", () => {
    const baseDir = makeBaseDir();
    const installDir = path.join(baseDir, "code-review-graph");
    fs.mkdirSync(installDir, { recursive: true });
    const provisioner = new McpProvisioner(baseDir, vi.fn());

    provisioner.remove("code-review-graph");
    expect(fs.existsSync(installDir)).toBe(false);

    expect(() => provisioner.remove("../escape")).toThrow(
      "outside the MCP directory",
    );
    expect(() => provisioner.remove("")).toThrow("outside the MCP directory");
  });
});
