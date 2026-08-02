import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildAgentBrief, SKILL_REGISTRY } from "@yaaa/shared";
import { InnerLoop } from "./inner-loop.js";
import { container, PermissionEngine } from "@yaaa/platform";
import type { IBus, IStore } from "@yaaa/interfaces";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

class TestChatModel extends BaseChatModel {
  constructor() {
    super({});
  }
  _llmType() {
    return "test-model";
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const msg = new AIMessage({ content: "Subtask execution complete with deliverable." });
    return { generations: [{ text: "Subtask execution complete with deliverable.", message: msg }] };
  }
  override bindTools(): any {
    return this;
  }
}

describe("Streamlined Workspace Lifecycle & Briefing Test Suite", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaaa-workspace-test-"));
  });

  it("1. Implementation Briefing cleanly states Agent Role, Referred Skills, and Tools without negative lists", () => {
    const brief = buildAgentBrief({
      missionGoal: "Develop interactive 3D Canvas Game",
      subtaskTitle: "Build 3D Canvas Game Engine with Chart Dashboard",
      successCriteria: "game.js and chart.png created",
      skills: [SKILL_REGISTRY["3d-graphics"], SKILL_REGISTRY.chart],
      handsOnPath: "agent-workspaces/worker-1/handsOn.md",
      handOffPath: "agent-workspaces/worker-1/handOff.md",
      subSubtasks: [
        { id: "1.1", title: "Initialize WebGL Canvas", state: "completed" },
        { id: "1.2", title: "Render 3D Mesh and Chart", state: "pending" },
      ],
    });

    // Check Role, Skills, and Micro-steps are cleanly listed
    expect(brief).toContain("## Mission goal");
    expect(brief).toContain("## Your subtask");
    expect(brief).toContain("## Provided Skills & Technical Documentation");
    expect(brief).toContain("3D Graphics Skill");
    expect(brief).toContain("Chart Generation Skill");
    expect(brief).toContain("## Sub-subtasks breakdown");
    expect(brief).toContain("- [x] 1.1: Initialize WebGL Canvas");

    // Negative lists or unused tool justifications should NOT be present
    expect(brief).not.toContain("not used because");
    expect(brief).not.toContain("Unused tools list");
  });

  it("2. Sub-agent workspace lifecycle: updates checkpoint.md mid-run, then deletes checkpoint.md and creates consolidated handOff.md on finish", async () => {
    const agentId = "lifecycle-worker-1";
    const taskId = "task-lifecycle-test";
    const agentWorkspace = path.join(tmpDir, "agent-workspaces", agentId);
    fs.mkdirSync(agentWorkspace, { recursive: true });

    const checkpointPath = path.join(agentWorkspace, "checkpoint.md");
    const handsOnPath = path.join(agentWorkspace, "handsOn.md");
    const handOffPath = path.join(agentWorkspace, "handOff.md");

    // Write initial handsOn and active checkpoint
    fs.writeFileSync(handsOnPath, "# Hands-On Assignment\n\n- Task details and micro-steps list\n");
    fs.writeFileSync(checkpointPath, "# Active Sub-Agent Checkpoint\n\n- Mid-run progress\n");

    expect(fs.existsSync(checkpointPath)).toBe(true);

    const mockBus: IBus = {
      publish: vi.fn(async () => {}),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    } as unknown as IBus;

    const mockStore: IStore = {
      savePlan: vi.fn(async () => {}),
      getPlan: vi.fn(async () => undefined),
      saveRun: vi.fn(async () => {}),
      getRun: vi.fn(async () => undefined),
      listRuns: vi.fn(async () => []),
      saveArtifact: vi.fn(async () => {}),
      listArtifacts: vi.fn(async () => []),
    } as unknown as IStore;

    const mockFilesProvider = {
      writeFile: vi.fn(async (filePath: string, content: string) => {
        const fullPath = path.resolve(tmpDir, filePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, "utf8");
      }),
      readFile: vi.fn(async () => "file content"),
    };

    container.clear();
    container.register("IBus", mockBus);
    container.register("IStore", mockStore);
    container.register("workingDir", tmpDir);
    container.register("capability:files", mockFilesProvider);
    container.register("PermissionEngine", new PermissionEngine());
    container.register("ChatModelFactory", () => new TestChatModel());

    const innerLoop = new InnerLoop(container);

    const result = await innerLoop.run({
      agentId,
      taskId,
      templateName: "FilesAgent",
      instruction: "Execute canvas build",
    });

    expect(result).toBeDefined();

    // Verify checkpoint.md was deleted upon finish
    expect(fs.existsSync(checkpointPath)).toBe(false);

    // Verify consolidated handOff.md was created
    expect(fs.existsSync(handOffPath)).toBe(true);
    const handOffContent = fs.readFileSync(handOffPath, "utf-8");

    expect(handOffContent).toContain("# Agent Handoff & Proof of Work");
    expect(handOffContent).toContain("## Work Done & Result Summary");
    expect(handOffContent).toContain("## Proof of Work & Tool Evidence");
    expect(handOffContent).toContain("## Asset Metadata & Artifact List");

    // Verify standalone proofOfWork.md was NOT created
    const standaloneProofPath = path.join(agentWorkspace, "proofOfWork.md");
    expect(fs.existsSync(standaloneProofPath)).toBe(false);
  });
});
