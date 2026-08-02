import { describe, it, expect, vi, beforeEach } from "vitest";
import { container } from "@yaaa/platform";
import type { IMeshGateway, IBus } from "@yaaa/interfaces";
import { Planner, getRequestedAgentCount, defaultModelForSubtask, MODEL_TIERS, PREFERENCE_MODEL_DEFAULTS } from "./planner.js";

describe("Planner", () => {
  let mockGateway: IMeshGateway;
  let mockBus: IBus;
  let planner: Planner;

  beforeEach(() => {
    container.clear();
    mockGateway = {
      chat: vi.fn(),
      chatStream: vi.fn(),
    };
    mockBus = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockReturnValue(() => {}),
    };
    container.register("IMeshGateway", mockGateway);
    container.register("IBus", mockBus);
    planner = new Planner();
  });

  // A hardcoded rubric of four ids is why every plan picked the same model,
  // however many hundreds the account could actually reach.
  describe("model rubric", () => {
    const planStub = `\`\`\`json
{"goal":"g","subtasks":[{"id":"task-1","title":"t","roles":["FilesAgent"],"capabilities":["files"],"dependsOn":[],"riskLevel":"low","successCriteria":"s","routingReason":"r","model":"anthropic/claude-haiku-4.5"}]}
\`\`\``;
    const systemPromptOf = () => (mockGateway.chat as any).mock.calls[0][0][0].content as string;

    beforeEach(() => {
      (mockGateway.chat as any).mockResolvedValue({ content: planStub });
    });

    it("offers the planner Mesh's live menu when the catalog is readable", async () => {
      container.register("modelMenuProvider", async () => '- "anthropic/claude-opus-4.8" ($30.00/1M tokens, 1000K context)');
      await new Planner().plan("do a thing");
      const prompt = systemPromptOf();
      expect(prompt).toContain("anthropic/claude-opus-4.8");
      expect(prompt).toContain("models this account can actually reach right now");
      // The static tier list must not leak in alongside the live menu.
      expect(prompt).not.toContain("(strongest, default)");
    });

    it("falls back to the static rubric when no catalog is wired up", async () => {
      await new Planner().plan("do a thing");
      expect(systemPromptOf()).toContain(MODEL_TIERS.complex);
    });

    it("falls back to the static rubric when the catalog is empty or unreadable", async () => {
      container.register("modelMenuProvider", async () => "");
      await new Planner().plan("do a thing");
      expect(systemPromptOf()).toContain(MODEL_TIERS.simple);

      (mockGateway.chat as any).mockClear();
      container.register("modelMenuProvider", async () => { throw new Error("Mesh down"); });
      await new Planner().plan("do a thing");
      expect(systemPromptOf()).toContain(MODEL_TIERS.simple);
    });
  });

  it("should successfully generate and validate a TaskPlan", async () => {
    const mockResponse = `\`\`\`json
{
  "goal": "Write report",
  "subtasks": [
    {
      "id": "task-1",
      "title": "Gather facts",
      "roles": ["ResearcherAgent"],
      "capabilities": ["files", "browser"],
      "dependsOn": [],
      "riskLevel": "low",
      "successCriteria": "facts.txt exists",
      "routingReason": "The work requires gathering and synthesizing facts.",
      "model": "google/gemini-2.5-flash"
    }
  ]
}
\`\`\``;

    (mockGateway.chat as any).mockResolvedValue({ content: mockResponse });

    const plan = await planner.plan("Write report");
    expect(plan.goal).toBe("Write report");
    expect(plan.subtasks.length).toBe(1);
    expect(plan.subtasks[0].id).toBe("task-1");
    expect(plan.planningAnalysis?.implementationGoal).toContain("Write report");
    expect(plan.planningAnalysis?.stepReviews[0].selectedRole).toBe("ResearcherAgent");
    expect(plan.subtasks[0].summary).toContain("Gather facts");
    expect(plan.executionContract?.targetWorkspace).toBe("task working directory");
    expect(plan.executionContract?.dependencyGraph).toEqual([{ subtaskId: "task-1", dependsOn: [] }]);
    expect(plan.executionContract?.actionQueue.maxActions).toBeGreaterThan(0);
    expect(plan.verification?.required).toBe(true);
    expect(plan.verification?.stages.map((stage) => stage.kind)).toContain("artifact");
    expect(plan.verification?.toolLimitations.join(" ")).toContain("rendered");
  });

  it("applies the selected model policy when a model is omitted", async () => {
    (mockGateway.chat as any).mockResolvedValue({
      content: '```json\n{"goal":"g","subtasks":[{"id":"task-1","title":"t","roles":["FilesAgent"],"capabilities":["files"],"dependsOn":[],"riskLevel":"low","successCriteria":"s","routingReason":"bounded file work"}]}\n```',
    });

    const sota = await planner.plan("g", undefined, { modelPreference: "sota" });
    expect(sota.subtasks[0].model).toBe(PREFERENCE_MODEL_DEFAULTS.sota);
    expect(sota.subtasks[0].modelReason).toContain("SOTA");

    const costEffective = await planner.plan("g", undefined, { modelPreference: "cost-effective" });
    expect(costEffective.subtasks[0].model).toBe(PREFERENCE_MODEL_DEFAULTS["cost-effective"]);
    expect(costEffective.subtasks[0].modelReason).toContain("Cost Effective");
  });

  it("normalizes a model's comma-separated capabilities to one routed primary capability", async () => {
    (mockGateway.chat as any).mockResolvedValue({
      content: `\`\`\`json
{"goal":"g","subtasks":[
  {"id":"files","title":"Create files and run supporting commands","roles":["FilesAgent"],"capabilities":["files","shell","browser"],"dependsOn":[],"riskLevel":"low","successCriteria":"the files exist","routingReason":"bounded composite file work","model":"google/gemini-2.5-flash"},
  {"id":"verify","title":"Verify files and inspect the browser output","roles":["QaTesterAgent"],"capabilities":["verify","files","browser"],"dependsOn":["files"],"riskLevel":"low","successCriteria":"verification passes","routingReason":"independent composite verification","model":"google/gemini-2.5-flash"}
]}
\`\`\``,
    });

    const plan = await planner.plan("Create and verify files");

    expect(plan.subtasks.map((subtask) => subtask.capabilities)).toEqual([["files", "shell", "browser"], ["verify", "files", "browser"]]);
  });

  it("normalizes model-authored shell tool aliases to runtime tool names", async () => {
    (mockGateway.chat as any).mockResolvedValue({
      content: `\`\`\`json
{"goal":"Create a deck","subtasks":[{"id":"task-1","title":"Create and run the deck generator","roles":["DocumentAgent"],"capabilities":["files","shell"],"dependsOn":[],"riskLevel":"low","successCriteria":"deck.pptx exists","routingReason":"presentation artifact work","model":"google/gemini-2.5-flash"}],"executionContract":{"contextPolicy":{"maxInputTokens":4000,"maxDependencyChars":1000,"maxHistoryTurns":2,"maxFileExcerptLines":80,"includeFullSkillDocs":false,"allowOnDemandReads":true,"allowedTools":["read_file","write_file","shell_exec"]},"requiredArtifacts":["deck.pptx"],"targetWorkspace":"task working directory","expectedNextActions":["execute the generator"],"dependencyGraph":[{"subtaskId":"task-1","dependsOn":[]}],"preflight":{"runOncePerAssignment":true,"targetPaths":[]},"completionSignals":["deck exists"],"noProgress":{"correctionAfter":1,"stopAfter":2},"actionQueue":{"useWhen":["related work"],"maxActions":4,"maxDepth":1,"stopOnError":true},"verificationSurface":"files"}}
\`\`\``,
    });

    const plan = await planner.plan("Create a deck");
    expect(plan.executionContract?.contextPolicy?.allowedTools).toEqual(["read_file", "write_file", "execute_command"]);
  });

  it("tells the planner to compose roles and permission-scoped capabilities", async () => {
    (mockGateway.chat as any).mockResolvedValue({ content: '```json\n{ "goal": "g", "subtasks": [] }\n```' });

    await planner.plan("Do a thing");

    const systemPrompt = (mockGateway.chat as any).mock.calls[0][0][0].content as string;
      expect(systemPrompt).toContain("complete set of cooperating agent roles");
      expect(systemPrompt).toContain("non-empty 'roles' and 'capabilities' arrays");
      expect(systemPrompt).toContain("union of permission-scoped tools");
    expect(systemPrompt).toContain("Verification is a first-class part of the plan");
    expect(systemPrompt).toContain("report the unproven claim as a bug/limitation to YAAA");
    expect(systemPrompt).toContain("VerifierAgent");
    expect(systemPrompt).toContain("read-only independent artifact/evidence verification");
  });

  it("should run the auto-repair loop once if the first planning attempt fails validation", async () => {
    let chatCount = 0;
    (mockGateway.chat as any).mockImplementation(async () => {
      chatCount++;
      if (chatCount === 1) {
        return { content: "invalid-json-output" };
      }
      return { content: `\`\`\`json
{
  "goal": "Write report",
  "subtasks": []
}
\`\`\`` };
    });

    const plan = await planner.plan("Write report");
    expect(plan.goal).toBe("Write report");
    expect(plan.subtasks.length).toBe(0);
    expect(chatCount).toBe(2); // Retried once!
  });

  it("should propagate parsing failure if both attempts are invalid JSON", async () => {
    (mockGateway.chat as any).mockResolvedValue({ content: "completely-invalid-output" });

    await expect(planner.plan("Write report")).rejects.toThrow(
      "No JSON code block found in model output."
    );
  });

  it("publishes planner reasoning as a thought when a taskId is given", async () => {
    (mockGateway.chat as any).mockImplementation(async (_msgs: any, opts: any) => {
      opts.onReasoning?.("decomposing the goal");
      return { content: '```json\n{ "goal": "g", "subtasks": [] }\n```' };
    });

    await planner.plan("Write report", "task-123");

    expect(mockBus.publish).toHaveBeenCalledWith(
      "task.task-123.agent.planner.thought",
      expect.objectContaining({ kind: "thought", from: "planner", content: "decomposing the goal" })
    );
  });

  it("threads the user profile and prior-mission summary into the planning prompt", async () => {
    let sentMessages: any[] = [];
    (mockGateway.chat as any).mockImplementation(async (msgs: any[]) => {
      sentMessages = msgs;
      return { content: '```json\n{ "goal": "g", "subtasks": [] }\n```' };
    });

    await planner.plan("Write report", "task-1", {
      userProfile: { name: "Krishnaraj", profession: "Engineer" },
      priorSummary: "Earlier we scaffolded the repo.",
    });

    const userMsg = sentMessages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("Krishnaraj");
    expect(userMsg).toContain("Engineer");
    expect(userMsg).toContain("Earlier we scaffolded the repo.");
    expect(userMsg).toContain('Create a task plan for this goal: "Write report"');
  });

  it("instructs PPT plans to produce real decks with pptxgenjs", async () => {
    let sentMessages: any[] = [];
    (mockGateway.chat as any).mockImplementation(async (msgs: any[]) => {
      sentMessages = msgs;
      return { content: '```json\n{ "goal": "g", "subtasks": [] }\n```' };
    });

    await planner.plan("Create a 5 slide solar system PPT");

    const systemMsg = sentMessages.find((m) => m.role === "system")?.content ?? "";
    expect(systemMsg).toContain("real .pptx artifact generated with pptxgenjs");
    expect(systemMsg).toContain("split slide research/content");
    expect(systemMsg).toContain("stitches the final deck with pptxgenjs");
  });

  it("does not publish reasoning when no taskId is given", async () => {
    (mockGateway.chat as any).mockImplementation(async (_msgs: any, opts: any) => {
      opts.onReasoning?.("thinking without a task");
      return { content: '```json\n{ "goal": "g", "subtasks": [] }\n```' };
    });

    await planner.plan("Write report");

    expect(mockBus.publish).not.toHaveBeenCalled();
  });

  it("recognizes explicit numeric and word-form agent counts", () => {
    expect(getRequestedAgentCount("spin 2 agents to code and test")).toBe(2);
    expect(getRequestedAgentCount("use two collaborating agents")).toBe(2);
    expect(getRequestedAgentCount("build and test this")).toBeNull();
  });

  it("retries a plan that would spawn more agents than explicitly requested", async () => {
    const makePlan = (count: number) => ({
      content: `\`\`\`json\n${JSON.stringify({
        goal: "Code and test",
        subtasks: Array.from({ length: count }, (_, index) => ({
          id: `subtask-${index + 1}`,
          title: index === 0 ? "Python developer" : "Python tester",
          roles: [index === 0 ? "PrincipalSweAgent" : "QaTesterAgent"],
          capabilities: [index === 0 ? "files" : "verify"],
          dependsOn: index === 0 ? [] : ["subtask-1"],
          riskLevel: "low",
          successCriteria: "Role assignment completed",
          routingReason: index === 0 ? "Implementation role selected by planner." : "Independent verification role selected by planner.",
          model: index === 0 ? "anthropic/claude-sonnet-4.5" : "anthropic/claude-haiku-4.5",
        })),
      })}\n\`\`\``,
    });
    (mockGateway.chat as any)
      .mockResolvedValueOnce(makePlan(6))
      .mockResolvedValueOnce(makePlan(2));

    const plan = await planner.plan(
      "spin 2 agents and one to write Python code and another to test",
    );

    expect(plan.subtasks).toHaveLength(2);
    expect(mockGateway.chat).toHaveBeenCalledTimes(2);
    const retryMessages = (mockGateway.chat as any).mock.calls[1][0];
    expect(retryMessages.at(-1).content).toContain(
      "Each subtask spawns one agent",
    );
  });
});

describe("defaultModelForSubtask", () => {
  it("routes simple file/verify work to the cheapest tier", () => {
    expect(defaultModelForSubtask({ roles: ["FilesAgent"], capabilities: ["files"], riskLevel: "low" })).toBe(MODEL_TIERS.simple);
    expect(defaultModelForSubtask({ roles: ["QaTesterAgent"], capabilities: ["verify"], riskLevel: "low" })).toBe(MODEL_TIERS.simple);
  });

  it("routes docs/browser work to the mid tier", () => {
    expect(defaultModelForSubtask({ roles: ["DocumentAgent"], capabilities: ["docs"], riskLevel: "low" })).toBe(MODEL_TIERS.medium);
    expect(defaultModelForSubtask({ roles: ["ResearcherAgent"], capabilities: ["browser"], riskLevel: "medium" })).toBe(MODEL_TIERS.medium);
  });

  it("routes engineering templates and high-risk work to the strongest tier", () => {
    expect(defaultModelForSubtask({ roles: ["PrincipalSweAgent"], capabilities: ["files"] })).toBe(MODEL_TIERS.complex);
    expect(defaultModelForSubtask({ roles: ["DocumentAgent"], capabilities: ["docs"], riskLevel: "high" })).toBe(MODEL_TIERS.complex);
    expect(defaultModelForSubtask({ roles: ["GraphicsEngineerAgent"], capabilities: ["files"] })).toBe(MODEL_TIERS.complex);
  });
});
