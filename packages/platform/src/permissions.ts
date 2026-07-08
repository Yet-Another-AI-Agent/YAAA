import path from "node:path";
import type { ToolCall } from "@yaaa/shared";

export interface AgentScope {
  capabilities: string[];
  allowedPaths: string[]; // only relevant for files
  riskCeiling: "low" | "medium" | "high";
}

export type PermissionDecision = "auto" | "confirm" | "deny";

export class PermissionEngine {
  private scopes = new Map<string, AgentScope>();
  private approvalHandler?: (agentId: string, call: ToolCall) => Promise<boolean>;

  grantScope(agentId: string, scope: AgentScope): void {
    this.scopes.set(agentId, scope);
  }

  getScope(agentId: string): AgentScope | undefined {
    return this.scopes.get(agentId);
  }

  registerApprovalHandler(handler: (agentId: string, call: ToolCall) => Promise<boolean>): void {
    this.approvalHandler = handler;
  }

  async checkCall(agentId: string, call: ToolCall): Promise<PermissionDecision> {
    const scope = this.scopes.get(agentId);
    if (!scope) {
      return "deny";
    }

    // 1. Capability check
    if (!scope.capabilities.includes(call.capability)) {
      return "deny";
    }

    // 2. Resource / Path scoping check for 'files' capability
    if (call.capability === "files") {
      const targetPath = call.args.path || call.args.dirPath;
      if (typeof targetPath === "string") {
        const absoluteTargetPath = path.resolve(targetPath);
        const isAllowed = scope.allowedPaths.some((allowed) => {
          const absoluteAllowed = path.resolve(allowed);
          return absoluteTargetPath.startsWith(absoluteAllowed);
        });
        if (!isAllowed) {
          return "deny";
        }
      }
    }

    // 3. Risk-level classifications
    // Built-in rule defaults
    if (call.capability === "shell") {
      const cmd = String(call.args.command || "");
      const riskyCommands = ["rm ", "sudo ", "format ", "mkfs", "mv ", ">", ">>"];
      const isRisky = riskyCommands.some((c) => cmd.includes(c));
      
      if (isRisky) {
        return "confirm";
      }
    }

    // If the orchestrator set a low risk ceiling but the subtask is higher risk
    if (scope.riskCeiling === "low" && call.capability === "shell") {
      return "confirm";
    }

    return "auto";
  }

  async executeWithApproval(agentId: string, call: ToolCall, executeFn: () => Promise<any>): Promise<any> {
    const decision = await this.checkCall(agentId, call);
    
    if (decision === "deny") {
      throw new Error(`Permission denied: agent ${agentId} is not permitted to execute ${call.capability}.${call.method}`);
    }

    if (decision === "confirm") {
      if (!this.approvalHandler) {
        throw new Error(`Approval required for ${call.capability}.${call.method} but no approval handler was registered.`);
      }
      
      const approved = await this.approvalHandler(agentId, call);
      if (!approved) {
        throw new Error(`User rejected execution of ${call.capability}.${call.method}`);
      }
    }

    return executeFn();
  }
}
