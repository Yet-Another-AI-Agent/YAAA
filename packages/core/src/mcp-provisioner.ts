import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { RegisteredMcpIntegration } from "./mcp-integrations.js";

/**
 * Dynamic MCP fetching: clone a server repository and install its
 * dependencies so it can be mounted for a workspace. Provisioning is the
 * explicit, consent-gated step that follows registration — an integration
 * must already be trusted (the user answered the global-vs-workspace
 * permission question) before any command runs, and nothing here ever
 * starts or executes the fetched server.
 */
export interface McpInstallSource {
  repoUrl: string;
}

export interface McpProvisionResult {
  installDir: string;
  /** Commands executed, in order — surfaced to the Agent Space log. */
  steps: string[];
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<void>;

const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/** Default runner: spawn without a shell so arguments can't be reinterpreted. */
export const execFileRunner: CommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, timeout: options.timeoutMs },
      (error) => (error ? reject(error) : resolve()),
    );
  });

function assertSafeRepoUrl(repoUrl: string): void {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    throw new Error("MCP source must be a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("MCP sources must be fetched over https.");
  }
  if (url.username || url.password) {
    throw new Error("MCP source URLs must not embed credentials.");
  }
}

export class McpProvisioner {
  constructor(
    private readonly baseDir: string,
    private readonly runCommand: CommandRunner = execFileRunner,
  ) {}

  /**
   * git-clone the integration's repository and install its dependencies.
   * Refuses untrusted integrations outright; cleans up the partial checkout
   * on any failure so a retry starts from a clean slate.
   */
  async provision(
    integration: RegisteredMcpIntegration,
    source: McpInstallSource,
  ): Promise<McpProvisionResult> {
    if (integration.state.trust !== "trusted") {
      throw new Error(
        "MCP integration must be trusted by the user before it can be installed.",
      );
    }
    assertSafeRepoUrl(source.repoUrl);

    const installDir = path.join(this.baseDir, integration.definition.id);
    if (fs.existsSync(installDir)) {
      throw new Error(
        `MCP integration '${integration.definition.id}' is already installed.`,
      );
    }
    fs.mkdirSync(this.baseDir, { recursive: true });

    const steps: string[] = [];
    try {
      steps.push(`git clone ${source.repoUrl}`);
      await this.runCommand(
        "git",
        ["clone", "--depth", "1", source.repoUrl, installDir],
        { cwd: this.baseDir, timeoutMs: COMMAND_TIMEOUT_MS },
      );

      if (fs.existsSync(path.join(installDir, "package.json"))) {
        steps.push("npm install");
        await this.runCommand("npm", ["install", "--no-fund", "--no-audit"], {
          cwd: installDir,
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
      }

      return { installDir, steps };
    } catch (err) {
      fs.rmSync(installDir, { recursive: true, force: true });
      throw err;
    }
  }

  /** Remove an installed server checkout (rollback / uninstall). */
  remove(integrationId: string): void {
    const installDir = path.join(this.baseDir, integrationId);
    const relative = path.relative(
      path.resolve(this.baseDir),
      path.resolve(installDir),
    );
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Refusing to remove a path outside the MCP directory.");
    }
    fs.rmSync(installDir, { recursive: true, force: true });
  }
}
