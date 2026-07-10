import path from "node:path";
import type { ToolCall } from "@yaaa/shared";

export interface AgentScope {
  capabilities: string[];
  allowedPaths: string[]; // only relevant for files
  riskCeiling: "low" | "medium" | "high";
}

export type PermissionDecision = "auto" | "confirm" | "deny";
export type PermissionPolicyScope = "global" | "task" | "agent";

/**
 * A serializable policy record. Persist these records through the task store,
 * then restore them with {@link PermissionEngine.restorePolicies} on startup.
 */
export interface PermissionPolicy {
  id: string;
  scope: PermissionPolicyScope;
  capability: string;
  /** Omit this to target every method exposed by a capability. */
  method?: string;
  decision: PermissionDecision;
  taskId?: string;
  agentId?: string;
  createdAt: string;
}

export type PermissionPolicyInput = Omit<
  PermissionPolicy,
  "id" | "createdAt"
> & {
  id?: string;
  createdAt?: string;
};

export interface PermissionCheckContext {
  taskId?: string;
}

export interface ApprovalDecision {
  approved: boolean;
  /** Persist an allow rule at this scope after approving the requested action. */
  alwaysAllow?: PermissionPolicyScope;
}

export type ApprovalHandler = (
  agentId: string,
  call: ToolCall,
) => Promise<boolean | ApprovalDecision>;

/**
 * Evaluates tool calls against least-privilege agent scopes and optional,
 * serializable user policies. Agent policies override task policies, which
 * override global policies. A policy can reduce permissions at any level.
 */
export class PermissionEngine {
  private scopes = new Map<string, AgentScope>();
  private agentTaskIds = new Map<string, string>();
  private policies = new Map<string, PermissionPolicy>();
  private approvalHandler?: ApprovalHandler;
  private policySequence = 0;

  grantScope(agentId: string, scope: AgentScope, taskId?: string): void {
    this.scopes.set(agentId, scope);
    if (taskId) this.agentTaskIds.set(agentId, taskId);
  }

  getScope(agentId: string): AgentScope | undefined {
    return this.scopes.get(agentId);
  }

  registerApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  /**
   * Adds or replaces a policy with the same scope, target, capability, and
   * method. The returned value is a plain object suitable for durable storage.
   */
  savePolicy(input: PermissionPolicyInput): PermissionPolicy {
    this.validatePolicy(input);
    const existing = this.findEquivalentPolicy(input);
    const policy: PermissionPolicy = {
      ...input,
      id: input.id ?? existing?.id ?? `permission-${++this.policySequence}`,
      createdAt:
        input.createdAt ?? existing?.createdAt ?? new Date().toISOString(),
    };
    this.policies.set(policy.id, policy);
    return { ...policy };
  }

  /** Records the user's "always allow" choice for the exact tool method. */
  rememberApproval(
    agentId: string,
    call: ToolCall,
    scope: PermissionPolicyScope,
    context: PermissionCheckContext = {},
  ): PermissionPolicy {
    const taskId = context.taskId ?? this.agentTaskIds.get(agentId);
    return this.savePolicy({
      scope,
      capability: call.capability,
      method: call.method,
      decision: "auto",
      ...(scope === "task"
        ? { taskId: this.requireTaskId(scope, taskId) }
        : {}),
      ...(scope === "agent" ? { agentId } : {}),
    });
  }

  removePolicy(policyId: string): boolean {
    return this.policies.delete(policyId);
  }

  /** Creates a persistence snapshot without exposing internal mutable state. */
  getPolicies(): PermissionPolicy[] {
    return [...this.policies.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((policy) => ({ ...policy }));
  }

  /** Restores policies previously produced by {@link getPolicies}. */
  restorePolicies(policies: PermissionPolicy[]): void {
    this.policies.clear();
    for (const policy of policies) {
      this.validatePolicy(policy);
      this.policies.set(policy.id, { ...policy });
      this.policySequence = Math.max(
        this.policySequence,
        this.sequenceFromId(policy.id),
      );
    }
  }

  async checkCall(
    agentId: string,
    call: ToolCall,
    context: PermissionCheckContext = {},
  ): Promise<PermissionDecision> {
    const scope = this.scopes.get(agentId);
    if (
      !scope ||
      !this.isCapabilityAllowed(scope, call) ||
      !this.isResourceAllowed(scope, call)
    ) {
      return "deny";
    }

    const policy = this.findMatchingPolicy(
      agentId,
      call,
      context.taskId ?? this.agentTaskIds.get(agentId),
    );
    if (policy) return policy.decision;

    return this.getDefaultDecision(scope, call);
  }

  async executeWithApproval<T>(
    agentId: string,
    call: ToolCall,
    executeFn: () => Promise<T>,
    context: PermissionCheckContext = {},
  ): Promise<T> {
    const decision = await this.checkCall(agentId, call, context);
    if (decision === "deny") {
      throw new Error(
        `Permission denied: agent ${agentId} is not permitted to execute ${call.capability}.${call.method}`,
      );
    }

    if (decision === "confirm") {
      const approval = await this.requestApproval(agentId, call);
      if (!approval.approved) {
        throw new Error(
          `User rejected execution of ${call.capability}.${call.method}`,
        );
      }
      if (approval.alwaysAllow) {
        this.rememberApproval(agentId, call, approval.alwaysAllow, context);
      }
    }

    return executeFn();
  }

  private async requestApproval(
    agentId: string,
    call: ToolCall,
  ): Promise<ApprovalDecision> {
    if (!this.approvalHandler) {
      throw new Error(
        `Approval required for ${call.capability}.${call.method} but no approval handler was registered.`,
      );
    }
    const response = await this.approvalHandler(agentId, call);
    return typeof response === "boolean" ? { approved: response } : response;
  }

  private isCapabilityAllowed(scope: AgentScope, call: ToolCall): boolean {
    return scope.capabilities.includes(call.capability);
  }

  private isResourceAllowed(scope: AgentScope, call: ToolCall): boolean {
    if (call.capability !== "files") return true;
    const targetPath = call.args.path || call.args.dirPath;
    if (typeof targetPath !== "string") return true;

    const absoluteTargetPath = path.resolve(targetPath);
    return scope.allowedPaths.some((allowedPath) =>
      this.isWithinPath(absoluteTargetPath, path.resolve(allowedPath)),
    );
  }

  private isWithinPath(targetPath: string, allowedPath: string): boolean {
    const relative = path.relative(allowedPath, targetPath);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    );
  }

  private findMatchingPolicy(
    agentId: string,
    call: ToolCall,
    taskId?: string,
  ): PermissionPolicy | undefined {
    return [...this.policies.values()]
      .filter((policy) => this.policyAppliesTo(policy, agentId, call, taskId))
      .sort(
        (left, right) => this.policyPriority(right) - this.policyPriority(left),
      )[0];
  }

  private policyAppliesTo(
    policy: PermissionPolicy,
    agentId: string,
    call: ToolCall,
    taskId?: string,
  ): boolean {
    if (policy.capability !== call.capability) return false;
    if (policy.method && policy.method !== call.method) return false;
    if (policy.scope === "global") return true;
    if (policy.scope === "task") return policy.taskId === taskId;
    return policy.agentId === agentId;
  }

  private policyPriority(policy: PermissionPolicy): number {
    const scopeWeight: Record<PermissionPolicyScope, number> = {
      global: 1,
      task: 2,
      agent: 3,
    };
    return scopeWeight[policy.scope] * 10 + (policy.method ? 1 : 0);
  }

  private getDefaultDecision(
    scope: AgentScope,
    call: ToolCall,
  ): PermissionDecision {
    if (this.isRiskyShellCall(call)) return "confirm";
    if (scope.riskCeiling === "low" && call.capability === "shell")
      return "confirm";
    return "auto";
  }

  private isRiskyShellCall(call: ToolCall): boolean {
    if (call.capability !== "shell") return false;
    const command = String(call.args.command || "");
    return ["rm ", "sudo ", "format ", "mkfs", "mv ", ">", ">>"].some(
      (riskyCommand) => command.includes(riskyCommand),
    );
  }

  private validatePolicy(policy: PermissionPolicyInput): void {
    if (!policy.capability)
      throw new Error("Permission policy capability is required.");
    if (policy.scope === "task" && !policy.taskId)
      throw new Error("Task-scoped permission policies require a taskId.");
    if (policy.scope === "agent" && !policy.agentId)
      throw new Error("Agent-scoped permission policies require an agentId.");
  }

  private requireTaskId(scope: PermissionPolicyScope, taskId?: string): string {
    if (!taskId)
      throw new Error(`${scope} permission policy requires a taskId.`);
    return taskId;
  }

  private findEquivalentPolicy(
    input: PermissionPolicyInput,
  ): PermissionPolicy | undefined {
    return [...this.policies.values()].find(
      (policy) =>
        policy.scope === input.scope &&
        policy.taskId === input.taskId &&
        policy.agentId === input.agentId &&
        policy.capability === input.capability &&
        policy.method === input.method,
    );
  }

  private sequenceFromId(id: string): number {
    const match = /^permission-(\d+)$/.exec(id);
    return match ? Number(match[1]) : 0;
  }
}
