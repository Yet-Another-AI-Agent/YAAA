import type { IBus, IStore, ModelResolution, ModelResolver } from "@yaaa/interfaces";
import { agentControl, container, orchestratorMailbox, type Container, type IEventQueue } from "@yaaa/platform";
import { type AgentRun, type Subtask, type TaskPlan, type LedgerEntry, type DependencyOutput, type VerificationFinding, buildAgentBrief, getErrorFingerprint, isInsufficientFundsError } from "@yaaa/shared";
import { AGENT_REGISTRY, selectAgentTemplate } from "../registry.js";
import { InnerLoop } from "./inner-loop.js";
import { SupervisorAssessor } from "./supervisor-assessor.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The retry decision is driven by the *shape of the failure*, not a fixed
// attempt count: when the same error fingerprint recurs this many times the
// agent is demonstrably stuck, so we stop and escalate to a different approach.
const MAX_IDENTICAL_ERRORS = 3;

// Provider rate limits are shared by all workers in a mission. Keep this hard
// capped at two even if an old plan asks for more agents; callers may lower it
// for local/test runs, but can never raise it accidentally.
export function resolveMaxParallelAgents(): number {
  const configured = Number(process.env.YAAA_MAX_PARALLEL_AGENTS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(2, Math.floor(configured))
    : 2;
}

// A pure safety backstop so an agent that fails a *different* way every single
// time (and so never trips the recurrence detector above) still terminates.
// It is not the primary control — the recurrence/kill-switch logic is — and it
// is operator-tunable rather than a bare literal.
function resolveMaxSubtaskAttempts(): number {
  const raw = Number(process.env.YAAA_MAX_SUBTASK_ATTEMPTS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
}

// Timebox continuations are NOT failures — an agent that checkpoints incomplete
// and hands off to a continuation is making progress, not erroring. They get
// their own generous budget, kept separate from the error-retry budget above so
// a slow-but-progressing subtask is never marked failed just for taking several
// renewed timers. Only a runaway with no end in sight trips this backstop.
function resolveMaxContinuations(): number {
  const raw = Number(process.env.YAAA_MAX_CONTINUATIONS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20;
}

// How many fix→re-verify rounds a failing verification may negotiate before the
// subtask is declared failed. A failed verifier is not the end of the line: the
// master sends the deliverable back to a worker to fix, then re-verifies.
function resolveMaxVerificationRounds(): number {
  const raw = Number(process.env.YAAA_MAX_VERIFICATION_ROUNDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2;
}

/**
 * Optional operator-configured model to use on retries, giving cross-provider
 * resilience without hardcoding a specific (and possibly unavailable) model.
 * When unset, retries reuse the agent's own configured model.
 */
function resolveBackupModel(): string | undefined {
  return process.env.YAAA_BACKUP_MODEL?.trim() || undefined;
}

function logOuter(taskId: string, message: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[YAAA:OuterLoop:${taskId}] ${message}${suffix}`);
}

function warnOuter(taskId: string, message: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.warn(`[YAAA:OuterLoop:${taskId}] ${message}${suffix}`);
}

function summaryWithRuntimeEvidence(summary: string, evidence?: unknown): string {
  const evidenceText = typeof evidence === "string" ? evidence.trim() : "";
  if (!evidenceText || evidenceText === "- None recorded.") return summary;
  return `${summary}\n\nRuntime tool evidence reviewed by supervisor:\n${evidenceText}`;
}

/** Run-wide mutable state shared (by reference) across concurrent subtasks. */
interface RunContext {
  subtaskStates: Record<string, "pending" | "running" | "completed" | "failed">;
  facts: string[];
  assumptions: string[];
  /** Structured results keyed by subtask id, threaded into dependents' briefs. */
  completedOutputs: Map<string, DependencyOutput>;
  /** Synchronous read-then-increment step allocator (see run() for why it's safe). */
  allocateStep: () => number;
  /** Structured evidence recovered after a process restart. */
  resumeDirective?: string;
}

const TEXT_ARTIFACT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".xml",
]);
const MAX_DEPENDENCY_EVIDENCE_CHARS = 18_000;

export class OuterLoop {
  private bus: IBus;
  private store: IStore;
  private innerLoop: InnerLoop;
  private supervisor: SupervisorAssessor;
  private scope: Container;
  private modelResolver?: ModelResolver;
  private durableQueue?: IEventQueue;

  private async recordPlanCorrection(
    taskId: string,
    plan: TaskPlan,
    correction: { subtaskId: string; agentId?: string; action: string; reason: string; nextAgentTemplate?: string; nextModel?: string },
  ): Promise<void> {
    plan.corrections = [
      ...(plan.corrections ?? []),
      { id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...correction },
    ];
    await this.store.savePlan(taskId, plan);
    await this.bus.publish(`task.${taskId}.plan_updated`, plan);
    await this.bus.publish(`task.${taskId}.started`, {
      kind: "status",
      from: "orchestrator",
      taskId,
      state: "working",
      note: `YAAA reassessed ${correction.subtaskId} after agent completion: ${correction.action}. ${correction.reason}`,
    });
  }

  private async recordVerificationFindings(
    taskId: string,
    plan: TaskPlan,
    subtask: Subtask,
    agent: AgentRun,
    verdict: { summary?: string; reason?: string; findings?: string[]; evidence?: string[]; limitations?: string[] },
  ): Promise<void> {
    const findings = (verdict.findings ?? []).map(String);
    const evidence = (verdict.evidence ?? []).map(String);
    const limitations = (verdict.limitations ?? []).map(String);
    const finding: VerificationFinding = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      subtaskId: subtask.id,
      agentId: agent.id,
      status: "open",
      summary: String(verdict.summary ?? verdict.reason ?? "Verification found an issue."),
      findings: findings.length ? findings : ["The verifier reported a failed verification without a specific finding."],
      evidence,
      limitations,
    };
    plan.verificationFindings = [...(plan.verificationFindings ?? []), finding];
    await this.store.savePlan(taskId, plan);
    await this.bus.publish(`task.${taskId}.plan_updated`, plan);
    await this.bus.publish(`task.${taskId}.started`, {
      kind: "status",
      from: "orchestrator",
      taskId,
      state: "working",
      note: `YAAA received verification bugs from ${agent.handle} for ${subtask.id}: ${finding.findings.join(" | ")}${limitations.length ? ` Limitation: ${limitations.join(" | ")}` : ""}`,
    });
  }

  private async resolveVerificationFindings(taskId: string, plan: TaskPlan, subtaskId: string, resolution: string, resolved: boolean): Promise<void> {
    if (!plan.verificationFindings?.length) return;
    plan.verificationFindings = plan.verificationFindings.map((finding) =>
      finding.subtaskId === subtaskId && finding.status === "open"
        ? { ...finding, status: resolved ? "resolved" : "open", resolution: resolved ? resolution : undefined }
        : finding,
    );
    await this.store.savePlan(taskId, plan);
    await this.bus.publish(`task.${taskId}.plan_updated`, plan);
  }

  constructor(scope: Container = container) {
    this.scope = scope;
    this.bus = scope.resolve<IBus>("IBus");
    this.store = scope.resolve<IStore>("IStore");
    this.innerLoop = new InnerLoop(scope);
    this.supervisor = new SupervisorAssessor(scope);
    try {
      this.modelResolver = scope.resolve<ModelResolver>("modelResolver");
    } catch {
      // Unit tests and alternate runtimes may not provide Mesh catalog access.
    }
    try {
      this.durableQueue = scope.resolve<IEventQueue>("IEventQueue");
    } catch {
      // In-memory unit-test scopes intentionally omit durable queue wiring.
    }
  }

  private selectTemplate(subtask: Subtask): string {
    return selectAgentTemplate(subtask);
  }

  /** Execute one worker assignment through the durable agent queue. The
   * existing InnerLoop remains the executor; the queue adds a recoverable
   * assignment boundary and lease so a process crash does not erase work. */
  private async runInnerLoop(options: Parameters<InnerLoop["run"]>[0]): Promise<any> {
    if (!this.durableQueue) return this.innerLoop.run(options);
    await this.durableQueue.recoverExpired("agent");
    const item = {
      id: `agent-work-${options.taskId}-${options.agentId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      taskId: options.taskId,
      queue: "agent" as const,
      recipientId: options.agentId,
      payload: options,
      createdAt: new Date().toISOString(),
      availableAt: new Date().toISOString(),
      attempts: 0,
    };
    await this.durableQueue.enqueue(item);
    const [claim] = await this.durableQueue.claim("agent", options.taskId, options.agentId, 1, 10 * 60_000);
    if (!claim) throw new Error(`Agent assignment ${item.id} could not be claimed.`);
    try {
      const result = await this.innerLoop.run(options);
      await this.durableQueue.acknowledge(claim);
      return result;
    } catch (error) {
      await this.durableQueue.retry(claim);
      throw error;
    }
  }

  /**
   * Ask the runtime which model this agent should actually run on. The catalog
   * behind the resolver is fetched once and cached, so this is a cheap call per
   * attempt. If the lookup is unavailable the requested model is used as-is,
   * which keeps keyless/test runtimes working.
   */
  private async resolveModel(taskId: string, requested?: string): Promise<ModelResolution> {
    if (!this.modelResolver) {
      return {
        model: requested,
        reason: requested
          ? `YAAA used ${requested} as requested; Mesh's catalog was not consulted in this runtime.`
          : "No model was requested and Mesh's catalog was not consulted in this runtime.",
      };
    }
    try {
      const resolution = await this.modelResolver(requested);
      logOuter(taskId, "resolved model from Mesh catalog", {
        requestedModel: requested ?? null,
        selectedModel: resolution.model ?? null,
      });
      return resolution;
    } catch (error) {
      warnOuter(taskId, "model catalog lookup failed; preserving requested model", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        model: requested,
        reason: requested
          ? `Mesh's catalog could not be read, so YAAA kept the requested model ${requested}.`
          : "Mesh's catalog could not be read and no model was requested.",
      };
    }
  }

  private static avatarSlug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  private findCachedAvatar(name: string): string | undefined {
    const fileName = `${OuterLoop.avatarSlug(name)}.png`;
    const directories = [
      path.resolve(__dirname, "../assets/pokemon-avatars"),
      path.resolve(__dirname, "../../assets/pokemon-avatars"),
      path.resolve(process.cwd(), "packages/agents/assets/pokemon-avatars"),
    ];
    return directories
      .map((directory) => path.join(directory, fileName))
      .find((candidate) => fs.existsSync(candidate));
  }

  private async selectPokemonAndImage(taskId: string): Promise<{ name: string; image: string }> {
    try {
      const paths = [
        path.resolve(__dirname, "../pokemon.json"),
        path.resolve(__dirname, "../../pokemon.json"),
        path.resolve(__dirname, "../src/pokemon.json"),
        path.resolve(process.cwd(), "packages/agents/src/pokemon.json"),
        path.resolve(process.cwd(), "pokemon.json"),
      ];
      let pokemonList: Array<{ name: string; prompt: string }> = [];
      for (const p of paths) {
        if (fs.existsSync(p)) {
          pokemonList = JSON.parse(fs.readFileSync(p, "utf8"));
          break;
        }
      }
      if (pokemonList.length === 0) {
        pokemonList = [
          { name: "Pikachu", prompt: "cute electric mouse pikachu" },
          { name: "Charizard", prompt: "orange fire dragon charizard" },
          { name: "Bulbasaur", prompt: "cute green toad plant bulbasaur" },
          { name: "Squirtle", prompt: "cute water turtle squirtle" },
          { name: "Jigglypuff", prompt: "cute singing pink balloon jigglypuff" },
        ];
      }

      // The roster has historically contained accidental duplicate entries.
      // Keep one stable entry per character so persisted assignments remain
      // deterministic across app restarts.
      const seenNames = new Set<string>();
      pokemonList = pokemonList.filter((pokemon) => {
        const key = pokemon.name.trim().toLowerCase();
        if (!key || seenNames.has(key)) return false;
        seenNames.add(key);
        return true;
      });

      // Query used pokemons for this task from db
      const existingAgents = (await this.store.getAgents(taskId)) || [];
      const usedNames = new Set(existingAgents.map((a) => a.pokemonName).filter(Boolean));

      // Find available Pokemons
      let available = pokemonList.filter((p) => !usedNames.has(p.name));
      if (available.length === 0) {
        available = pokemonList;
      }

      // Select a random one
      const selected = available[Math.floor(Math.random() * available.length)];

      // Avatars are pre-generated and shipped with the app. Never spend a
      // Mesh image-generation call during agent creation; a missing asset is
      // allowed to fall back to the UI initials avatar.
      const avatarPath = this.findCachedAvatar(selected.name);
      const imageVal = avatarPath
        ? `data:image/png;base64,${fs.readFileSync(avatarPath).toString("base64")}`
        : "";
      if (!avatarPath) {
        warnOuter(taskId, "cached Pokemon avatar missing", { pokemon: selected.name });
      }
      return { name: selected.name, image: imageVal };
    } catch (err) {
      console.error("Error in selectPokemonAndImage:", err);
      return { name: "Pikachu", image: "" };
    }
  }

  private async createAgentRun(taskId: string, subtask: Subtask, step: number, templateName = this.selectTemplate(subtask)): Promise<AgentRun> {
    const template = AGENT_REGISTRY[templateName];
    const pokemon = await this.selectPokemonAndImage(taskId);
    // One canonical identity is used everywhere: UI handle, AgentRun id,
    // workspace folder, artifact prefix, and per-agent DB directory.
    const nameSlug = pokemon.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
    const canonicalId = `${nameSlug}-${step}`;
    const handle = `@${canonicalId}`;
    const displayName = pokemon.name.trim();
    return {
      id: canonicalId,
      handle,
      displayName,
      taskId,
      subtaskId: subtask.id,
      role: templateName,
      modelRole: template?.modelRole ?? "worker",
      initialGoal: subtask.title,
      activeAssignment: subtask.title,
      model: subtask.model,
      modelReason: subtask.modelReason,
      status: "planned",
      pokemonName: pokemon.name,
      pokemonImage: pokemon.image,
    };
  }

  private requiredArtifactGaps(subtask: Subtask, artifacts: Array<{ path: string }>, missionGoal = ""): string[] {
    const contract = `${missionGoal}\n${subtask.title}\n${subtask.successCriteria}`.toLowerCase();
    const paths = artifacts.map((artifact) => String(artifact.path || "").toLowerCase());
    const gaps: string[] = [];
    if (/powerpoint|pptx|slide deck|presentation|slides?/.test(contract) && !paths.some((p) => p.endsWith(".pptx"))) {
      gaps.push("Create and verify a real .pptx presentation file; a Markdown outline is not an acceptable substitute.");
    }
    if (/generated image|actual image|illustration|visual(?:ly)?(?: appealing| asset| deck)?|embed(?:ded|s)? image|png|jpg|jpeg/.test(contract) && !paths.some((p) => /\.(png|jpe?g|webp|gif)$/.test(p))) {
      gaps.push("Create the required image assets as real PNG/JPG/WebP files and reference/embed them in the deliverable.");
    }
    return gaps;
  }

  /** Read dependency artifacts once, immediately before the next agent starts. */
  private readDependencyEvidence(outputs: DependencyOutput[]): DependencyOutput[] {
    let workingDir: string;
    try {
      workingDir = this.scope.resolve<string>("workingDir");
    } catch {
      return outputs;
    }
    const root = path.resolve(workingDir);
    let remaining = MAX_DEPENDENCY_EVIDENCE_CHARS;
    return outputs.map((output) => {
      const evidence: string[] = [];
      for (const artifact of output.artifacts ?? []) {
        if (remaining <= 0) break;
        const artifactPath = String(artifact.path || "");
        const extension = path.extname(artifactPath).toLowerCase();
        if (!TEXT_ARTIFACT_EXTENSIONS.has(extension)) continue;
        const absolute = path.resolve(root, artifactPath);
        if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
        try {
          const stat = fs.statSync(absolute);
          if (!stat.isFile() || stat.size === 0 || stat.size > remaining) continue;
          const contents = fs.readFileSync(absolute, "utf8").trim();
          if (!contents) continue;
          evidence.push(`### ${artifactPath}\n${contents}`);
          remaining -= contents.length;
        } catch {
          // A missing or binary artifact remains available by path in the brief.
        }
      }
      if (evidence.length === 0) return output;
      return {
        ...output,
        summary: `${output.summary}\n\nYAAA inspected these dependency files before starting you:\n\n${evidence.join("\n\n")}`,
      };
    });
  }

  /**
   * Verifiers need the live filesystem because generated paths can differ from
   * the planner's intended name. Keep the inventory bounded, but include source
   * generators and binary outputs so the verifier can resolve both.
   */
  private listWorkspaceArtifactPaths(): string[] {
    let workingDir: string;
    try {
      workingDir = this.scope.resolve<string>("workingDir");
    } catch {
      return [];
    }
    const root = path.resolve(workingDir);
    const found: string[] = [];
    const visit = (directory: string): void => {
      if (found.length >= 300) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (found.length >= 300) return;
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile()) found.push(path.relative(root, absolute).split(path.sep).join("/"));
      }
    };
    visit(root);
    return found.sort();
  }

  private writeHandsOnBrief(agent: AgentRun, brief: string): void {
    let workingDir: string;
    try {
      workingDir = this.scope.resolve<string>("workingDir");
    } catch {
      return;
    }
    const workspaceDir = path.join(workingDir, "agent-workspaces", agent.id);
    fs.mkdirSync(workspaceDir, { recursive: true });
    const content = `# handsOn\n\n- Prepared by YAAA immediately before execution.\n- Agent: ${agent.handle} (${agent.displayName})\n- Model: ${agent.model ?? agent.modelRole}\n\n${brief}\n`;
    fs.writeFileSync(path.join(workspaceDir, "handsOn.md"), content, "utf8");
  }

  private async recordAgentLifecycle(agent: AgentRun): Promise<void> {
    // A lifecycle event is an immutable observation.  Copy before handing it
    // to persistence/subscribers because the live assignment is updated as
    // the inner loop progresses.
    const snapshot = { ...agent };
    logOuter(snapshot.taskId, "agent lifecycle", {
      agentId: snapshot.id,
      handle: snapshot.handle,
      role: snapshot.role,
      status: snapshot.status,
      subtaskId: snapshot.subtaskId,
      modelRole: snapshot.modelRole,
    });
    await this.store.saveAgent(snapshot.taskId, snapshot);
    await this.bus.publish(`task.${snapshot.taskId}.agent.${snapshot.id}.lifecycle`, snapshot);
  }

  /** Drain messages posted while the run is busy and route them cooperatively
   * at a model-turn boundary. This keeps the LangGraph graph unchanged while
   * making the orchestrator a real event loop instead of a one-shot Promise. */
  private async processQueuedMessages(taskId: string, force = false): Promise<void> {
    await this.durableQueue?.recoverExpired("orchestrator");
    await orchestratorMailbox.hydrate(taskId, `orchestrator-${taskId}`);
    const queued = orchestratorMailbox.drain(taskId);
    if (queued.length === 0) return;
    const agents = (await this.store.getAgents(taskId)) ?? [];
    const workingAgents = agents.filter((agent) => agent.status === "working" || agent.status === "blocked");
    if (workingAgents.length === 0 && !force) {
      orchestratorMailbox.requeue(taskId, queued);
      return;
    }
    for (const message of queued) {
      if (message.from === "agent") {
        // The durable chat message is already authored by the worker. Do not
        // mirror it as a YAAA status bubble; that was the attribution bug shown
        // in the screenshot (YAAA appeared to speak for the sub-agent).
        const targetAgent = agents.find((agent) => agent.id === message.agentId);
        const targetHandle = targetAgent?.handle ?? message.agentId ?? "agent";
        await this.bus.publish(`task.${taskId}.agent_message`, {
          kind: "info_reply",
          from: "orchestrator",
          to: targetAgent?.id ?? message.agentId ?? "agent",
          answer: `@${targetHandle.replace(/^@/, "")} I received your question: ${message.content}. Continue with the safest evidence-based path while I review it and keep your current work moving.`,
        });
        await orchestratorMailbox.acknowledge(message.id);
        continue;
      }

      await this.bus.publish(`task.${taskId}.started`, {
        kind: "status",
        from: "orchestrator",
        taskId,
        state: "working",
        note: `📬 Processing queued ${message.from} message: ${message.content}`,
      });

      // A pickup event alone is not an answer: the UI uses it to move the
      // optimistic user turn out of the queue, but the user still needs a
      // visible orchestrator response. Keep this acknowledgement on the
      // event-loop path so every queued user message is answered even while
      // the workers continue their current subtasks.
      await this.bus.publish(`task.${taskId}.started`, {
        kind: "status",
        from: "orchestrator",
        taskId,
        state: "working",
        note: workingAgents.length > 0
          ? `✅ I’m here — I received your message and routed it to the active agents. I’ll keep the existing work moving and report back with the next result.`
          : `✅ I’m here — I received your message. There are no active workers at this instant, so I’ll incorporate it at the next mission checkpoint and report back with the next result.`,
      });
      for (const agent of workingAgents) {
        await this.bus.publish(`task.${taskId}.agent_message`, {
          kind: "info_reply",
          from: "orchestrator",
          to: agent.id,
          answer: `@${agent.handle.replace(/^@/, "")} ${message.content}`,
        });
        const redirect = {
          type: "redirect",
          handsOn: `${message.from === "user" ? "User" : "Orchestrator"} message received while you were working:\n\n${message.content}\n\nIncorporate it at the next safe turn. Continue from existing artifacts; do not restart unless the evidence requires it.`,
          reason: "Queued message delivered by the orchestrator event loop.",
        } as const;
        // The durable queue is the source of truth for each worker lane. The
        // in-process mailbox remains as a low-latency compatibility path for
        // runtimes/tests that do not provide a durable queue.
        if (this.durableQueue) {
          await this.durableQueue.enqueue({
            id: `agent-message-${taskId}-${agent.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            taskId,
            queue: "agent",
            recipientId: agent.id,
            payload: redirect,
            createdAt: new Date().toISOString(),
            availableAt: new Date().toISOString(),
            attempts: 0,
          });
          await this.bus.publish(`task.${taskId}.agent.${agent.id}.thought`, {
            kind: "thought",
            from: agent.id,
            content: `📤 YAAA dropped a message in ${agent.handle}'s queue: ${message.content}`,
          });
        } else {
          agentControl.post(agent.id, redirect);
        }
        agentControl.post(agent.id, {
          type: "extend",
          additionalMs: 120_000,
          reason: "Time granted to process queued orchestration input.",
        });
      }
      await orchestratorMailbox.acknowledge(message.id);
    }
  }

  /**
   * Negotiate a failing verification instead of surrendering to it: send the
   * deliverable back to a worker with the verifier's findings, then re-verify,
   * bounded by {@link resolveMaxVerificationRounds}. Returns the reconciled
   * outcome. This is what turns a "verifier failed → whole run aborts" into a
   * "verifier failed → fix it → re-check" collaboration.
   */
  private async negotiateVerification(
    taskId: string,
    plan: TaskPlan,
    verifySubtask: Subtask,
    initialVerdict: { status?: string; findings?: string[]; evidence?: string[]; summary?: string; reason?: string; artifacts?: DependencyOutput["artifacts"] },
    ctx: RunContext,
  ): Promise<{ passed: boolean; summary: string; artifacts: DependencyOutput["artifacts"] }> {
    const maxRounds = resolveMaxVerificationRounds();
    const producer = plan.subtasks.find((s) => verifySubtask.dependsOn.includes(s.id));
    const producerTemplate = producer ? selectAgentTemplate(producer) : "FilesAgent";
    const verifyTemplate = selectAgentTemplate(verifySubtask);
    const producerOutputs: DependencyOutput[] = producer
      ? [ctx.completedOutputs.get(producer.id)].filter((o): o is DependencyOutput => o !== undefined)
      : [];
    let verdict = initialVerdict;

    for (let round = 1; round <= maxRounds && (verdict.status ?? "failed") === "failed"; round++) {
      const findings = (verdict.findings ?? []).map((f) => `- ${f}`).join("\n") || "- (no specific findings)";
      const evidence = (verdict.evidence ?? []).map((e) => `- ${e}`).join("\n") || "- (none)";
      await this.bus.publish(`task.${taskId}.started`, {
        kind: "status",
        from: "orchestrator",
        taskId,
        state: "working",
        note: `🔁 Verification failed for "${verifySubtask.title}" (round ${round}/${maxRounds}). Sending it back to a worker to fix, then re-verifying.`,
      });

      // 1) Fix worker — repair the producer's deliverable using the findings.
      const fixAgent = await this.createAgentRun(taskId, producer ?? verifySubtask, ctx.allocateStep());
      await this.recordAgentLifecycle(fixAgent);
      const fixWorkspace = `agent-workspaces/${fixAgent.id}`;
      const fixBrief = buildAgentBrief({
        missionGoal: plan.goal,
        subtaskTitle: producer ? producer.title : verifySubtask.title,
        successCriteria: producer ? producer.successCriteria : verifySubtask.successCriteria,
        dependencyOutputs: producerOutputs,
        retryDirective: `An independent verifier FAILED the current deliverable. Fix it in place so it satisfies the success criteria — do NOT start over.\n\nVerifier findings:\n${findings}\n\nEvidence:\n${evidence}`,
        handsOnPath: `${fixWorkspace}/handsOn.md`,
        proofOfWorkPath: `${fixWorkspace}/proofOfWork.md`,
        handOffPath: `${fixWorkspace}/handOff.md`,
      });
      try {
        const fixResult = await this.runInnerLoop({ agentId: fixAgent.id, taskId, templateName: producerTemplate, instruction: fixBrief, model: producer?.model });
        fixAgent.status = "completed";
        fixAgent.summary = fixResult.summary || "";
      } catch (err: any) {
        fixAgent.status = "failed";
        fixAgent.summary = err?.message;
      }
      fixAgent.finishedAt = new Date().toISOString();
      await this.recordAgentLifecycle(fixAgent);
      ctx.facts.push(`Verification round ${round} fix for ${verifySubtask.id}: ${fixAgent.summary || "(no summary)"}`);

      // 2) Re-verify the repaired deliverable with a fresh verifier agent.
      const reVerifyAgent = await this.createAgentRun(taskId, verifySubtask, ctx.allocateStep());
      await this.recordAgentLifecycle(reVerifyAgent);
      const verifyWorkspace = `agent-workspaces/${reVerifyAgent.id}`;
      const verifyBrief = buildAgentBrief({
        missionGoal: plan.goal,
        subtaskTitle: verifySubtask.title,
        successCriteria: verifySubtask.successCriteria,
        dependencyOutputs: producerOutputs,
        retryDirective: `Re-verify the deliverable after fix round ${round}. A previous verification failed with:\n${findings}\nConfirm whether those issues are now resolved.`,
        handsOnPath: `${verifyWorkspace}/handsOn.md`,
        proofOfWorkPath: `${verifyWorkspace}/proofOfWork.md`,
        handOffPath: `${verifyWorkspace}/handOff.md`,
      });
      try {
        const reVerify: any = await this.runInnerLoop({ agentId: reVerifyAgent.id, taskId, templateName: verifyTemplate, instruction: verifyBrief, model: verifySubtask.model });
        verdict = reVerify;
        reVerifyAgent.status = "completed";
        reVerifyAgent.summary = reVerify.summary ?? reVerify.reason;
      } catch (err: any) {
        reVerifyAgent.status = "failed";
        reVerifyAgent.summary = err?.message;
        verdict = { status: "failed", reason: err?.message, findings: [err?.message] };
      }
      reVerifyAgent.finishedAt = new Date().toISOString();
      await this.recordAgentLifecycle(reVerifyAgent);
    }

    const passed = (verdict.status ?? "failed") === "passed";
    return { passed, summary: verdict.summary ?? verdict.reason ?? "", artifacts: verdict.artifacts ?? [] };
  }

  /**
   * Execute a single subtask's full attempt / kill-switch lifecycle.
   *
   * Extracted from `run` so a whole batch of independent ready subtasks can be
   * mapped over and awaited concurrently via `Promise.all`. Every piece of
   * run-wide mutable state it touches is passed in by reference via `ctx` so
   * concurrent invocations share one consistent view.
   */
  private async runSubtask(taskId: string, plan: TaskPlan, subtask: Subtask, ctx: RunContext): Promise<void> {
    const { subtaskStates, facts, assumptions, completedOutputs, allocateStep } = ctx;
    logOuter(taskId, "subtask starting", {
      subtaskId: subtask.id,
      title: subtask.title,
      capability: subtask.capability,
      agentTemplate: subtask.agentTemplate,
      plannedModel: subtask.model,
      dependsOn: subtask.dependsOn,
    });
    subtaskStates[subtask.id] = "running";
    subtask.state = "running";
    await this.store.savePlan(taskId, plan);
    await this.bus.publish(`task.${taskId}.plan_updated`, plan);

    // Claim this subtask's first step number synchronously. The ledger entry
    // and the first spawned agent share it, mirroring the original serial
    // numbering where `step` was not bumped between them.
    let currentStep = allocateStep();

    const ledgerEntry: LedgerEntry = {
      timestamp: new Date().toISOString(),
      step: currentStep,
      facts: [...facts],
      assumptions: [...assumptions],
      subtaskStates: { ...subtaskStates },
      nextStepStrategy: `Spawning ${this.selectTemplate(subtask)} to execute subtask: ${subtask.title}`
    };
    await this.store.saveLedgerEntry(taskId, ledgerEntry);

    await this.bus.publish(`task.${taskId}.started`, {
      kind: "status",
      from: "orchestrator",
      taskId,
      state: "working",
      note: `Starting subtask: ${subtask.title}`
    });

    let templateName = this.selectTemplate(subtask);
    let nextModelOverride: string | undefined;
    const maxAttempts = resolveMaxSubtaskAttempts();
    const maxContinuations = resolveMaxContinuations();
    const backupModel = resolveBackupModel();
    logOuter(taskId, "subtask execution policy", {
      subtaskId: subtask.id,
      templateName,
      maxAttempts,
      backupModel: backupModel ?? null,
    });

    // Anti-infinite-loop kill switch: track consecutive identical error
    // states. Three identical bounces trigger a hard interrupt — the
    // failing agent is killed, the failure chain is logged, and one fresh
    // agent is spawned with orders to try a completely different
    // approach. If that also fails, the subtask is declared failed.
    let lastErrorMessage: string | null = null;
    let lastErrorFingerprint: string | null = null;
    let identicalErrors = 0;
    let differentApproachAttempted = false;
    let attempts = 0;
    // Error retries and timebox continuations are budgeted independently: a slow
    // subtask that keeps checkpointing progress must not exhaust the error budget.
    let errorAttempts = 0;
    let continuations = 0;
    let lastIncompleteSummary: string | null = null;
    let lastIncompleteArtifacts: Array<{ path: string; mimeType: string; description: string }> = [];
    // Set by the supervisor when it decides to redirect a checkpointed worker;
    // becomes the next continuation's directive, overriding the generic "continue
    // from your handoff" text with concrete course-correction.
    let supervisorRedirect: string | null = null;

    while (subtaskStates[subtask.id] === "running") {
      attempts++;
      // Preserve the planner's cost-aware model choice for workers. On worker
      // retries, keep that same model rather than silently switching to a
      // hardcoded/provider-specific backup. Non-worker roles may use the
      // configured backup model on retries. Whatever is requested is then
      // resolved against Mesh's catalog, so an agent only ever spawns on a
      // model Mesh actually offers.
      const template = AGENT_REGISTRY[templateName];
      const isWorker = template?.modelRole === "worker";
      const requestedModel =
        nextModelOverride || (attempts === 1 || isWorker ? subtask.model || undefined : backupModel);
      const requestSource =
        attempts === 1
          ? requestedModel ? "planner" : "template-default"
          : isWorker
            ? requestedModel ? "planner-stable-retry" : "template-default-retry"
            : requestedModel ? "backup" : "template-default-retry";
      const resolution = await this.resolveModel(taskId, requestedModel);
      const selectedModel = resolution.model;
      const agent = await this.createAgentRun(taskId, subtask, currentStep, templateName);
      if (selectedModel) {
        agent.modelRole = selectedModel;
        agent.model = selectedModel;
        agent.modelReason = resolution.reason;
      }
      const workspacePrefix = `agent-workspaces/${agent.id}`;
      const handsOnArtifact = {
        path: `${workspacePrefix}/handsOn.md`,
        mimeType: "text/markdown",
        description: `Orchestrator hands-on assignment for ${subtask.id}.`,
      };
      subtask.artifacts = [
        handsOnArtifact,
        ...((subtask.artifacts ?? []).filter((artifact) => artifact.path !== handsOnArtifact.path)),
      ];
      await this.store.savePlan(taskId, plan);
      logOuter(taskId, "attempt starting", {
        subtaskId: subtask.id,
        attempt: attempts,
        agentId: agent.id,
        handle: agent.handle,
        templateName,
        requestedModel: requestedModel ?? null,
        selectedModel: selectedModel ?? null,
        requestSource,
        effectiveModelRole: agent.modelRole,
      });
      // The agent is visible as planned while YAAA prepares its concrete,
      // dependency-aware assignment. It becomes working only after handsOn.md
      // has been written and the effective role/model are finalized below.
      await this.recordAgentLifecycle(agent);
      await this.bus.publish(`task.${taskId}.plan_updated`, plan);

      // Gather the structured results of this subtask's completed
      // dependencies so the agent sees real sibling output, not a flat fact list.
      const dependencyOutputs: DependencyOutput[] = subtask.dependsOn
        .map((depId) => completedOutputs.get(depId))
        .filter((out): out is DependencyOutput => out !== undefined);

      const retryDirective = supervisorRedirect
        ? `Supervisor course-correction from the team lead who reviewed the previous checkpoint:\n${supervisorRedirect}\n\nContinue from the existing artifacts; do not restart from scratch.\n\nCheckpoint artifacts:\n${lastIncompleteArtifacts.map((artifact) => `- ${artifact.path}: ${artifact.description}`).join("\n") || "- None recorded."}`
        : differentApproachAttempted
        ? `Previous agents failed ${identicalErrors} consecutive times with: "${lastErrorMessage}". Attempt a COMPLETELY DIFFERENT approach — do not repeat the failed strategy.`
        : lastIncompleteSummary
          ? `Previous agent reached its timebox and produced an incomplete handoff instead of a final deliverable. Continue from the listed artifacts; do not restart unless the evidence is insufficient.\n\nCheckpoint summary:\n${lastIncompleteSummary}\n\nCheckpoint artifacts:\n${lastIncompleteArtifacts.map((artifact) => `- ${artifact.path}: ${artifact.description}`).join("\n") || "- None recorded."}`
          : attempts > 1 && lastErrorMessage
            ? `A previous attempt to execute this subtask failed with the following error: "${lastErrorMessage}". Please check the existing files in the workspace and correct any mistakes to resolve this issue.`
            : ctx.resumeDirective
              ? ctx.resumeDirective
        : undefined;

      const preparedDependencyOutputs = this.readDependencyEvidence(dependencyOutputs);
      const instruction = buildAgentBrief({
        missionGoal: plan.goal,
        subtaskTitle: subtask.title,
        successCriteria: subtask.successCriteria,
        dependencyOutputs: preparedDependencyOutputs,
        retryDirective,
        handsOnPath: `${workspacePrefix}/handsOn.md`,
        proofOfWorkPath: `${workspacePrefix}/proofOfWork.md`,
        handOffPath: `${workspacePrefix}/handOff.md`,
        workspaceArtifactPaths: ["VerifierAgent", "QaTesterAgent", "CvTesterAgent"].includes(templateName)
          ? this.listWorkspaceArtifactPaths()
          : undefined,
      });
      this.writeHandsOnBrief(agent, instruction);
      // Persist the concise live assignment on the agent card; the complete
      // brief remains in handsOn.md for the agent and downstream workers.
      agent.activeAssignment = retryDirective
        ? `${subtask.title}\n\n${retryDirective}`
        : subtask.title;
      agent.status = "working";
      agent.startedAt = new Date().toISOString();
      await this.recordAgentLifecycle(agent);

      try {
        const modelLabel = selectedModel
          ? ` using ${requestSource} model: ${selectedModel}`
          : ` using ${requestSource}`;
        console.log(`[OuterLoop] Executing subtask ${subtask.id} (attempt ${attempts})${modelLabel}`);
      const result = await this.runInnerLoop({
          agentId: agent.id,
          taskId,
          templateName,
          instruction,
          contextArtifacts: lastIncompleteArtifacts.map((artifact) => artifact.path),
          model: selectedModel,
        });

        const summary = result.summary || JSON.stringify(result);
        const resultArtifacts = [handsOnArtifact, ...(result.artifacts ?? [])];
        if (result.incomplete) {
          subtask.result = summary;
          subtask.artifacts = resultArtifacts;
          lastIncompleteSummary = summary;
          lastIncompleteArtifacts = resultArtifacts;
          facts.push(`Subtask ${subtask.id} checkpointed incomplete. Summary: ${summary}`);
          await this.store.savePlan(taskId, plan);
          await this.bus.publish(`task.${taskId}.plan_updated`, plan);
          agent.status = "exited";
          agent.finishedAt = new Date().toISOString();
          agent.summary = summary;
          await this.recordAgentLifecycle(agent);
          continuations++;
          logOuter(taskId, "attempt checkpointed incomplete", {
            subtaskId: subtask.id,
            attempt: attempts,
            agentId: agent.id,
            artifactCount: resultArtifacts.length,
            continuations,
            maxContinuations,
          });

          // A timebox checkpoint is progress, not failure. Instead of blindly
          // cold-spawning a continuation, the supervisor reads the worker's live
          // progress and decides: continue (more time), redirect (corrected
          // handsOn), accept (criteria already met), or fail (no viable path).
          const decision = await this.supervisor.assess(taskId, {
            missionGoal: plan.goal,
            subtaskTitle: subtask.title,
            successCriteria: subtask.successCriteria,
            checkpointSummary: summaryWithRuntimeEvidence(summary, result.runtimeEvidence),
            artifacts: resultArtifacts.map((a) => ({ path: a.path, description: a.description })),
            continuations,
            maxContinuations,
          });
          await this.recordPlanCorrection(taskId, plan, {
            subtaskId: subtask.id,
            agentId: agent.id,
            action: decision.action,
            reason: decision.reason,
            nextAgentTemplate: decision.nextAgentTemplate,
            nextModel: decision.nextModel,
          });
          await this.bus.publish(`task.${taskId}.started`, {
            kind: "status",
            from: "orchestrator",
            taskId,
            state: "working",
            note: `👔 Supervisor reviewed the "${subtask.title}" checkpoint → ${decision.action}: ${decision.reason}`,
          });

          if (decision.action === "accept") {
            subtaskStates[subtask.id] = "completed";
            subtask.state = "completed";
            subtask.result = summary;
            subtask.artifacts = resultArtifacts;
            facts.push(`Subtask ${subtask.id} accepted by supervisor at checkpoint. Summary: ${summary}`);
            completedOutputs.set(subtask.id, { id: subtask.id, title: subtask.title, summary, artifacts: resultArtifacts });
            await this.store.savePlan(taskId, plan);
            await this.bus.publish(`task.${taskId}.plan_updated`, plan);
            continue;
          }

          if (decision.action === "fail" || continuations >= maxContinuations) {
            subtaskStates[subtask.id] = "failed";
            subtask.state = "failed";
            const why =
              decision.action === "fail"
                ? `Supervisor stopped it: ${decision.reason}`
                : `Exceeded ${continuations} incomplete checkpoint continuation(s)`;
            facts.push(`Subtask ${subtask.id} failed at checkpoint. ${why}`);
            await this.store.savePlan(taskId, plan);
            await this.bus.publish(`task.${taskId}.plan_updated`, plan);
            continue;
          }

          // continue or redirect → renew the timer with a continuation agent. A
          // redirect carries corrected instructions into the next brief.
          supervisorRedirect = decision.action === "redirect" ? decision.handsOn ?? null : null;
          if (decision.nextAgentTemplate && AGENT_REGISTRY[decision.nextAgentTemplate]) {
            templateName = decision.nextAgentTemplate;
          }
          nextModelOverride = decision.nextModel || undefined;
          if (decision.nextAgentTemplate || decision.nextModel) {
            await this.bus.publish(`task.${taskId}.started`, {
              kind: "status",
              from: "orchestrator",
              taskId,
              state: "working",
              note: `🔀 Adaptive continuation: next agent will use ${templateName}${nextModelOverride ? ` on ${nextModelOverride}` : ""}.`,
            });
          }
          currentStep = allocateStep();
          continue;
        }

        // A verify subtask that returns a "failed" verdict is NOT a done subtask.
        // Negotiate a bounded fix→re-verify loop before accepting the outcome,
        // instead of letting the failure fall straight through to a run abort.
        if (subtask.capability === "verify" && (result as any).status === "failed") {
          await this.recordVerificationFindings(taskId, plan, subtask, agent, result as any);
          await this.recordPlanCorrection(taskId, plan, {
            subtaskId: subtask.id,
            agentId: agent.id,
            action: "verification-findings-received",
            reason: `YAAA received verifier bugs: ${((result as any).findings ?? []).map(String).join(" | ") || "unspecified verification failure"}. It will decide whether correction and reverification are necessary.`,
          });
          const outcome = await this.negotiateVerification(taskId, plan, subtask, result as any, ctx);
          agent.status = outcome.passed ? "completed" : "failed";
          agent.finishedAt = new Date().toISOString();
          agent.summary = outcome.summary || summary;
          await this.recordAgentLifecycle(agent);
          if (!outcome.passed) {
            subtaskStates[subtask.id] = "failed";
            subtask.state = "failed";
            subtask.result = outcome.summary || summary;
            await this.store.savePlan(taskId, plan);
            await this.bus.publish(`task.${taskId}.plan_updated`, plan);
            facts.push(`Subtask ${subtask.id} failed verification after fix rounds. ${outcome.summary}`);
            await this.resolveVerificationFindings(taskId, plan, subtask.id, "YAAA could not resolve the reported verification bugs within the bounded correction rounds.", false);
            continue;
          }
          subtaskStates[subtask.id] = "completed";
          subtask.state = "completed";
          subtask.result = outcome.summary || summary;
          subtask.artifacts = resultArtifacts;
          await this.store.savePlan(taskId, plan);
          await this.bus.publish(`task.${taskId}.plan_updated`, plan);
          facts.push(`Subtask ${subtask.id} passed after ${resolveMaxVerificationRounds()}-round fix negotiation. Summary: ${outcome.summary || summary}`);
          await this.resolveVerificationFindings(taskId, plan, subtask.id, outcome.summary || "YAAA corrected the deliverable and independent verification passed.", true);
          completedOutputs.set(subtask.id, { id: subtask.id, title: subtask.title, summary: outcome.summary || summary, artifacts: resultArtifacts });
          logOuter(taskId, "verification reconciled to pass", { subtaskId: subtask.id });
          continue;
        }

        const artifactGaps = this.requiredArtifactGaps(subtask, resultArtifacts, plan.goal);
        const completionReview = await this.supervisor.assess(taskId, {
          missionGoal: plan.goal,
          subtaskTitle: subtask.title,
          successCriteria: artifactGaps.length > 0
            ? `${subtask.successCriteria}\n\nMANDATORY ARTIFACT GAPS — do not accept until resolved:\n- ${artifactGaps.join("\n- ")}`
            : subtask.successCriteria,
          checkpointSummary: artifactGaps.length > 0
            ? `${summaryWithRuntimeEvidence(summary, result.runtimeEvidence)}\n\nThe orchestrator's artifact gate found:\n- ${artifactGaps.join("\n- ")}`
            : summaryWithRuntimeEvidence(summary, result.runtimeEvidence),
          artifacts: resultArtifacts.map((a) => ({ path: a.path, description: a.description })),
          continuations,
          maxContinuations,
        });
        const effectiveCompletionReview = artifactGaps.length > 0 && completionReview.action !== "fail"
          ? {
              action: "redirect" as const,
              reason: `Required deliverables are missing: ${artifactGaps.join(" ")}`,
              handsOn: `${completionReview.handsOn ? `${completionReview.handsOn}\n\n` : ""}Do not stop at the Markdown outline. Produce the missing concrete deliverables now: ${artifactGaps.join(" ")} Inspect the existing files first and continue from them.`,
              nextAgentTemplate: completionReview.nextAgentTemplate,
              nextModel: completionReview.nextModel,
            }
          : completionReview;
        await this.recordPlanCorrection(taskId, plan, {
          subtaskId: subtask.id,
          agentId: agent.id,
          action: effectiveCompletionReview.action,
          reason: effectiveCompletionReview.reason,
          nextAgentTemplate: effectiveCompletionReview.nextAgentTemplate,
          nextModel: effectiveCompletionReview.nextModel,
        });
        await this.bus.publish(`task.${taskId}.started`, {
          kind: "status",
          from: "orchestrator",
          taskId,
          state: "working",
          note: `Supervisor checked "${subtask.title}" against the current todo → ${effectiveCompletionReview.action}: ${effectiveCompletionReview.reason}`,
        });

        if (effectiveCompletionReview.action === "redirect") {
          subtask.result = summary;
          subtask.artifacts = resultArtifacts;
          lastIncompleteSummary = summary;
          lastIncompleteArtifacts = resultArtifacts;
          supervisorRedirect = effectiveCompletionReview.handsOn ?? null;
          if (effectiveCompletionReview.nextAgentTemplate && AGENT_REGISTRY[effectiveCompletionReview.nextAgentTemplate]) {
            templateName = effectiveCompletionReview.nextAgentTemplate;
          }
          nextModelOverride = effectiveCompletionReview.nextModel || undefined;
          await this.bus.publish(`task.${taskId}.started`, {
            kind: "status",
            from: "orchestrator",
            taskId,
            state: "working",
            note: `🔀 Adaptive handoff: next agent will use ${templateName}${nextModelOverride ? ` on ${nextModelOverride}` : ""}.`,
          });
          facts.push(`Subtask ${subtask.id} course-corrected after agent execution. Reason: ${completionReview.reason}`);
          agent.status = "exited";
          agent.finishedAt = new Date().toISOString();
          agent.summary = `Course correction requested: ${effectiveCompletionReview.reason}`;
          await this.recordAgentLifecycle(agent);
          await this.store.savePlan(taskId, plan);
          await this.bus.publish(`task.${taskId}.plan_updated`, plan);
          currentStep = allocateStep();
          continue;
        }

        if (effectiveCompletionReview.action === "fail") {
          subtaskStates[subtask.id] = "failed";
          subtask.state = "failed";
          subtask.result = summary;
          subtask.artifacts = resultArtifacts;
          facts.push(`Subtask ${subtask.id} failed supervisor validation after agent execution. ${effectiveCompletionReview.reason}`);
          agent.status = "failed";
          agent.finishedAt = new Date().toISOString();
          agent.summary = effectiveCompletionReview.reason;
          await this.recordAgentLifecycle(agent);
          await this.store.savePlan(taskId, plan);
          await this.bus.publish(`task.${taskId}.plan_updated`, plan);
          continue;
        }

        subtaskStates[subtask.id] = "completed";
        subtask.state = "completed";
        subtask.result = summary;
        subtask.artifacts = resultArtifacts;
        await this.store.savePlan(taskId, plan);
        await this.bus.publish(`task.${taskId}.plan_updated`, plan);
        facts.push(`Subtask ${subtask.id} finished. Summary: ${summary}`);
        completedOutputs.set(subtask.id, { id: subtask.id, title: subtask.title, summary, artifacts: resultArtifacts });
        agent.status = "completed";
        agent.finishedAt = new Date().toISOString();
        agent.summary = summary;
        await this.recordAgentLifecycle(agent);
        logOuter(taskId, "attempt completed", {
          subtaskId: subtask.id,
          attempt: attempts,
          agentId: agent.id,
          artifactCount: resultArtifacts.length,
          summaryChars: summary.length,
        });
      } catch (err: any) {
        // Out-of-funds is non-recoverable: abort the whole run immediately so
        // the caller can prompt the user to update their key / add credit,
        // rather than churning through every subtask with the same failure.
        // Rethrowing here rejects the enclosing `Promise.all`, tearing down the
        // whole run just as the serial version did.
        if (isInsufficientFundsError(err)) {
          throw err;
        }

        errorAttempts++;
        const fingerprint = getErrorFingerprint(err);
        identicalErrors = fingerprint === lastErrorFingerprint ? identicalErrors + 1 : 1;
        lastErrorFingerprint = fingerprint;
        lastErrorMessage = err.message;
        warnOuter(taskId, "attempt failed", {
          subtaskId: subtask.id,
          attempt: attempts,
          agentId: agent.id,
          error: err.message,
          fingerprint,
          identicalErrors,
          errorAttempts,
          maxAttempts,
        });

        const loopDetected = identicalErrors >= MAX_IDENTICAL_ERRORS;
        const terminalFailure = (loopDetected && differentApproachAttempted) || errorAttempts >= maxAttempts;
        // An attempt can fail while the subtask remains recoverable. Keep that
        // worker out of the FAILED state until YAAA has exhausted its bounded
        // correction/replacement policy.
        agent.status = terminalFailure ? "failed" : "exited";
        agent.finishedAt = new Date().toISOString();
        agent.summary = terminalFailure
          ? err.message
          : `Recoverable attempt error; YAAA is applying a correction before retrying: ${err.message}`;
        await this.recordAgentLifecycle(agent);
        console.error(`Subtask ${subtask.id} attempt ${attempts} failed:`, err);

        const correctiveSteps = loopDetected
          ? `Stop repeating the failed approach. YAAA will replace this attempt with a different approach after reviewing the repeated error.`
          : `Inspect the existing artifacts, verify the failing tool/model transcript, and retry with the corrected assignment context.`;
        // A worker failure is a conversation with YAAA, not a silent agent
        // death. Publish the worker's report first, then YAAA's explicit
        // decision so the UI shows who discovered the problem and who chose
        // the corrective action.
        await this.bus.publish(`task.${taskId}.agent_message`, {
          kind: "help_request",
          from: agent.id,
          to: "orchestrator",
          problem: `Execution error on attempt ${attempts}: ${err.message}`,
        });
        await this.bus.publish(`task.${taskId}.started`, {
          kind: "status",
          from: "orchestrator",
          taskId,
          state: "working",
          note: `@${agent.handle.replace(/^@/, "")} I received the failure report. Corrective steps: ${correctiveSteps}`,
        });
        await this.recordPlanCorrection(taskId, plan, {
          subtaskId: subtask.id,
          agentId: agent.id,
          action: loopDetected ? "different-approach" : "retry",
          reason: err.message,
        });

        // Transient/rate-limit backoff is intentionally NOT done here: the model
        // client already retries 5xx/429 with exponential backoff that honours
        // the provider's Retry-After header, so an extra hardcoded sleep would
        // only stack redundant, arbitrary waits on top of it.

        // A recurring identical failure means the agent is genuinely stuck, so
        // escalate to one fresh agent ordered to try a completely different
        // approach. If even that keeps failing — or an agent that fails a new
        // way every time never trips this and only the safety backstop stops it
        // — the subtask is declared failed.
        if (loopDetected && !differentApproachAttempted) {
          differentApproachAttempted = true;
          warnOuter(taskId, "kill switch activated, retrying with different approach", {
            subtaskId: subtask.id,
            identicalErrors,
            error: err.message,
          });
          await this.bus.publish(`task.${taskId}.started`, {
            kind: "status",
            from: "orchestrator",
            taskId,
            state: "working",
            note: `⛔ Kill switch: ${identicalErrors} identical failures on "${subtask.title}" (${err.message}). Killing the agent and spawning a replacement with a different approach.`,
          });
          currentStep = allocateStep();
          continue;
        }
        if (loopDetected || differentApproachAttempted || errorAttempts >= maxAttempts) {
          subtaskStates[subtask.id] = "failed";
          subtask.state = "failed";
          warnOuter(taskId, "subtask marked failed", {
            subtaskId: subtask.id,
            attempts,
            loopDetected,
            differentApproachAttempted,
            error: err.message,
          });
          await this.store.savePlan(taskId, plan);
          await this.bus.publish(`task.${taskId}.plan_updated`, plan);
          facts.push(`Subtask ${subtask.id} failed. Error: ${err.message}`);
        }
      }
      currentStep = allocateStep();
    }
    logOuter(taskId, "subtask finished loop", {
      subtaskId: subtask.id,
      state: subtaskStates[subtask.id],
      attempts,
    });
  }

  async run(taskId: string, plan: TaskPlan): Promise<void> {
    await this.store.savePlan(taskId, plan);

    // Recover structured checkpoint evidence before creating any new agent.
    // The workspace and handoff files remain the source of truth for concrete
    // work; this directive gives the replacement agent the durable reason and
    // next action without replaying the entire chat transcript.
    const persistedMessages = (await this.store.getMessages(taskId)) ?? [];
    const checkpointMessages = persistedMessages.filter(
      (message): message is Extract<typeof message, { kind: "result" }> =>
        message.kind === "result" && message.incomplete === true,
    );
    const statusMessages = persistedMessages.filter((m) => m.kind === "status");
    const lastFailedStatus = [...statusMessages]
      .reverse()
      .find((m: any) => m.note?.includes("failed") || m.note?.includes("Failed") || m.state === "blocked") as any;

    let resumeDirective: string | undefined = undefined;
    if (checkpointMessages.length > 0) {
      resumeDirective = `A previous process stopped after saving an incomplete checkpoint. Resume the existing mission from its durable evidence; do not claim the mission is complete and do not discard existing artifacts.\n\n${checkpointMessages.map((message) => `Checkpoint from ${message.from}: ${message.summary}\nArtifacts: ${message.artifacts.map((artifact) => `${artifact.path} (${artifact.description})`).join("; ") || "none recorded"}`).join("\n\n")}`;
    } else if (lastFailedStatus) {
      resumeDirective = `A previous attempt to execute this mission failed or was interrupted with the following message:\n"${lastFailedStatus.note || lastFailedStatus.summary || "Unknown error"}"\n\nResume the existing mission, inspect the working directory for any existing files/artifacts from the previous attempt, and continue or fix them to satisfy the goal. Do not restart from scratch unless necessary.`;
    }

    const subtasks = [...plan.subtasks];
    const subtaskStates: Record<string, "pending" | "running" | "completed" | "failed"> = {};
    for (const st of subtasks) {
      subtaskStates[st.id] = st.state === "completed" ? "completed" : "pending";
      if (st.state !== "completed") st.state = "pending";
    }

    const facts: string[] = [];
    const assumptions: string[] = [];
    // Structured results keyed by subtask id, threaded into each dependent
    // agent's brief so siblings actually see what prior steps produced.
    const completedOutputs = new Map<string, DependencyOutput>();
    for (const st of subtasks) {
      if (st.state === "completed") {
        completedOutputs.set(st.id, {
          id: st.id,
          title: st.title,
          summary: st.result ?? "",
          artifacts: st.artifacts ?? [],
        });
        facts.push(`Resumed with completed subtask ${st.id}: ${st.result ?? "(no prior summary)"}`);
      }
    }

    // `step` numbers ledger entries and agent ids. Now that sibling subtasks
    // run concurrently, several `runSubtask` calls draw from this counter with
    // their awaits interleaved. `allocateStep` does a synchronous
    // read-then-increment: because JS is single-threaded and there is no
    // `await` between reading `step` and bumping it, each call is guaranteed a
    // unique number — two concurrent subtasks can never silently share a step.
    const priorLedger = (await this.store.getLedgerEntries(taskId)) ?? [];
    let step = Math.max(0, ...priorLedger.map((entry) => entry.step)) + 1;
    const allocateStep = (): number => step++;
    // Warm Mesh's catalog once up front so the first agent does not pay the
    // lookup latency, and so an unreachable catalog is reported before any
    // subtask starts rather than mid-run.
    if (this.modelResolver) await this.resolveModel(taskId, undefined);

    // Outer plan loop
    while (subtasks.some((st) => subtaskStates[st.id] !== "completed" && subtaskStates[st.id] !== "failed")) {
      await this.processQueuedMessages(taskId);
      const readySubtasks = subtasks.filter(
        (st) =>
          subtaskStates[st.id] === "pending" &&
          st.dependsOn.every((depId) => subtaskStates[depId] === "completed")
      );

      if (readySubtasks.length === 0) {
        // Check for deadlock/failures
        const incomplete = subtasks.filter((st) => subtaskStates[st.id] !== "completed");
        if (incomplete.some((st) => subtaskStates[st.id] === "failed")) {
          throw new Error("Task execution failed due to subtask failure.");
        }
        throw new Error("Deadlock detected in subtask execution dependency graph.");
      }

      // Run every currently-ready subtask concurrently. This batch is mutually
      // independent by construction: a subtask only becomes "ready" once all of
      // its `dependsOn` are already "completed", so nothing here depends on a
      // sibling in the same batch. Dependents surface in a later outer
      // iteration, once their dependencies' outputs have already been recorded.
      // An insufficient-funds error from any subtask rejects this `Promise.all`
      // and propagates out of the whole run.
      let polling = true;
      const eventLoop = (async () => {
        while (polling) {
          try {
            await this.processQueuedMessages(taskId);
          } catch (error) {
            warnOuter(taskId, "event-loop tick failed; will retry", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          if (this.durableQueue) await this.durableQueue.waitForWork(taskId, 250);
          else await new Promise((resolve) => setTimeout(resolve, 250));
        }
      })();
      try {
        // Run independent work in bounded waves. Promise.all over the whole
        // ready set previously created an API burst and caused intermittent
        // provider rate-limit failures.
        const maxParallel = resolveMaxParallelAgents();
        for (let offset = 0; offset < readySubtasks.length; offset += maxParallel) {
          const wave = readySubtasks.slice(offset, offset + maxParallel);
          await Promise.all(
            wave.map((subtask) =>
              this.runSubtask(taskId, plan, subtask, {
                subtaskStates,
                facts,
                assumptions,
                completedOutputs,
                allocateStep,
                resumeDirective,
              }),
            ),
          );
        }
      } finally {
        polling = false;
        await eventLoop;
      }
    }

    const failedTasks = subtasks.filter((st) => subtaskStates[st.id] === "failed");
    if (failedTasks.length > 0) {
      throw new Error("Task execution failed due to subtask failure.");
    }

    // The run can finish between two event-loop ticks. Drain once more so a
    // message posted during that race cannot remain in the mailbox forever.
    await this.processQueuedMessages(taskId, true);

    const finalLedger: LedgerEntry = {
      timestamp: new Date().toISOString(),
      step,
      facts,
      assumptions,
      subtaskStates,
      nextStepStrategy: "Synthesis and completion."
    };
    await this.store.saveLedgerEntry(taskId, finalLedger);
  }
}
