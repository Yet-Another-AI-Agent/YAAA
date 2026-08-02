import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type { IBus, IMeshGateway, ChatMessage, ChatResult } from "@yaaa/interfaces";
import { type WALRecord, type CompactionCheckpoint, type ArtifactRef, type ModelRole, compactMessages } from "@yaaa/shared";
import { AGENT_REGISTRY } from "../registry.js";
import { DBEngine, AICallLoop } from "@yaaa/providers";
import { container, type Container, pauseController, agentControl } from "@yaaa/platform";
import { CanvasCommenterTool } from "../tools/canvas-commenter.js";
import { CodeReviewPreflightTool } from "../tools/code-review-preflight.js";
import { QACoverageTool } from "../tools/qa-coverage.js";
import { CVTesterTool } from "../tools/cv-tester-tool.js";

export interface CustomWorkerOptions {
  agentId: string;
  taskId: string;
  templateName: string;
  instruction: string;
  contextArtifacts?: string[];
  maxTurns?: number;
  model?: string;
  workspaceDir?: string;
}

export interface CustomWorkerResult {
  summary: string;
  artifacts: ArtifactRef[];
  completed: boolean;
  handsOnPath: string;
  handOffPath: string;
}

export class CustomInnerLoop {
  private bus: IBus;
  private meshGateway: IMeshGateway;
  private dbEngine: DBEngine;
  private aiCallLoop: AICallLoop;
  private canvasTool: CanvasCommenterTool;
  private graphTool: CodeReviewPreflightTool;
  private qaTool: QACoverageTool;
  private cvTool: CVTesterTool;

  constructor(scope: Container = container) {
    this.bus = scope.resolve<IBus>("IBus");
    this.meshGateway = scope.resolve<IMeshGateway>("IMeshGateway");
    this.dbEngine = scope.resolve<DBEngine>("DBEngine");
    this.aiCallLoop = new AICallLoop(this.meshGateway, this.dbEngine);
    this.canvasTool = new CanvasCommenterTool();
    this.graphTool = new CodeReviewPreflightTool();
    this.qaTool = new QACoverageTool();
    this.cvTool = new CVTesterTool();
  }

  async run(options: CustomWorkerOptions): Promise<CustomWorkerResult> {
    const { agentId, taskId, templateName, instruction, workspaceDir = `./.yaaa/tasks/${taskId}` } = options;
    const maxTurns = options.maxTurns ?? 20;

    const agentDb = this.dbEngine.getAgentDb(taskId, agentId);
    let sequence = this.dbEngine.getLastWALSequence(agentDb, agentId);

    // 1. Write HANDS_ON_[AGENT_NAME].md artifact
    const artifactsDir = path.join(workspaceDir, "Artifacts");
    if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });

    const safeName = templateName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const handsOnPath = path.join(artifactsDir, `HANDS_ON_${safeName}.md`);
    const handsOnContent = `# HANDS ON: ${templateName} (${agentId})\n\n**Task ID:** ${taskId}\n**Instruction:** ${instruction}\n**Spawned At:** ${new Date().toISOString()}\n\n---\n*Sub-agent active and executing ReAct loop with WAL logging.*`;
    fs.writeFileSync(handsOnPath, handsOnContent, "utf-8");

    sequence++;
    this.dbEngine.writeWALRecord(agentDb, {
      id: crypto.randomUUID(),
      entityId: agentId,
      sequence,
      type: "TURN_START",
      payload: { instruction, handsOnPath },
      timestamp: new Date().toISOString(),
    });

    let registryEntry = AGENT_REGISTRY[templateName as keyof typeof AGENT_REGISTRY];
    if (!registryEntry) {
      registryEntry = Object.values(AGENT_REGISTRY).find((a) => a.handle === templateName) || AGENT_REGISTRY.FilesAgent;
    }

    const systemPrompt = `${registryEntry.systemPrompt}\n\nYou are operating in an event-driven async ReAct loop with Write-Ahead Logging (WAL). Work step-by-step to fulfill the task instruction cleanly.`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: instruction },
    ];

    const artifacts: ArtifactRef[] = [
      { path: handsOnPath, mimeType: "text/markdown", description: `Hands-on initialization doc for ${templateName}` },
    ];

    let currentTurn = 0;
    let isFinished = false;
    let finalSummary = "";
    const toolCallCounts = new Map<string, number>();

    // 2. ReAct Event Loop
    while (currentTurn < maxTurns && !isFinished) {
      currentTurn++;
      await pauseController.waitIfPaused(taskId);
      await pauseController.waitIfPaused(agentId);
      if (agentControl.isStopped(agentId) || agentControl.isStopped(taskId)) {
        isFinished = true;
        finalSummary = "Stopped on request: terminal agent status";
        break;
      }

      for (const directive of agentControl.drain(agentId)) {
        if (directive.type === "switch_model" && directive.newModel) {
          options.model = directive.newModel;
          await this.bus.publish(`task.${taskId}.agent.${agentId}.thought`, {
            kind: "thought",
            from: agentId,
            content: `⚡ Dynamically upgraded model to '${directive.newModel}' on the fly.${directive.reason ? ` Rationale: ${directive.reason}` : ""}`,
          });
        } else if (directive.type === "redirect" && directive.handsOn) {
          messages.push({ role: "user", content: `[SUPERVISOR COURSE CORRECTION] ${directive.handsOn}` });
        } else if (directive.type === "stop") {
          isFinished = true;
          finalSummary = `Stopped on request: ${directive.reason || "User stop"}`;
          break;
        }
      }
      if (isFinished) break;

      const activeModel = options.model || registryEntry.modelRole;
      const totalChars = messages.reduce((acc, m) => acc + m.content.length, 0);
      if (totalChars > 20_000) {
        const compacted = compactMessages(messages, { keepLeading: 2, keepRecent: 4, minElideChars: 300 });
        messages.length = 0;
        messages.push(...compacted);
        const checkpoint: CompactionCheckpoint = {
          id: `compaction-${agentId}-${currentTurn}-${Date.now()}`,
          agentId,
          taskId,
          sequence,
          summary: `Turn ${currentTurn} compaction checkpoint: message history compacted past 20k token limit.`,
          factsExtracted: [`Compacted message history down to ${compacted.length} active messages.`],
          filesTouched: artifacts.map((a) => a.path),
          timestamp: new Date().toISOString(),
        };
        this.dbEngine.saveCompactionCheckpoint(agentDb, checkpoint);
      }
      const compactedMessages = compactMessages(messages, { keepLeading: 2, keepRecent: 4, minElideChars: 300 });
      const aiResult = await this.aiCallLoop.executeCall(
        taskId,
        agentId,
        activeModel as any,
        compactedMessages,
        { model: activeModel },
        "MEDIUM",
      );

      sequence++;
      this.dbEngine.writeWALRecord(agentDb, {
        id: crypto.randomUUID(),
        entityId: agentId,
        sequence,
        type: "AI_CALL_COMPLETED",
        payload: { contentPreview: aiResult.content.slice(0, 300) },
        timestamp: new Date().toISOString(),
      });

      messages.push({ role: "assistant", content: aiResult.content });

      if (currentTurn > 1 && currentTurn % 5 === 0) {
        const checkpointDocPath = `agent-workspaces/${agentId}/checkpoint.md`;
        try {
          const filesProvider = container.resolve<any>("capability:files");
          if (filesProvider) {
            const checkpointContent = `# Sub-Agent Periodic Checkpoint\n\n- **Agent**: ${agentId} (${templateName})\n- **Turn**: ${currentTurn} / ${maxTurns}\n- **Recent Output**: ${aiResult.content.slice(0, 300)}\n- **Timestamp**: ${new Date().toISOString()}\n`;
            await filesProvider.writeFile(checkpointDocPath, checkpointContent);
          }
        } catch {
          // DI capability not available in bare test scope
        }

        const summary = `Periodic turn ${currentTurn} checkpoint: ${aiResult.content.slice(0, 200)}`;
        await this.bus.publish(`task.${taskId}.agent.${agentId}.checkpoint`, {
          kind: "checkpoint",
          taskId,
          agentId,
          turn: currentTurn,
          checkpointPath: checkpointDocPath,
          summary,
        });
      }

      let effectiveToolCalls = aiResult.toolCalls || [];
      if (effectiveToolCalls.length === 0) {
        effectiveToolCalls = this.extractPseudoToolCalls(aiResult.content);
      }

      if (effectiveToolCalls.length > 0) {
        for (const toolCall of effectiveToolCalls) {
          const parts = toolCall.name.split(/[:._]/);
          const capability = parts[0] || toolCall.name;
          const method = parts[1] || "default";

          const callKey = `${capability}:${method}:${JSON.stringify(toolCall.args)}`;
          const count = (toolCallCounts.get(callKey) ?? 0) + 1;
          toolCallCounts.set(callKey, count);

          let observationResult = "";

          if (count > 3) {
            observationResult = `[REPEAT GUARD] Identical tool call executed ${count} times. Please change your approach or summarize final answer.`;
          } else {
            observationResult = await this.dispatchTool({ capability, method, args: toolCall.args });
          }

          if (observationResult.length > 20000) {
            observationResult = observationResult.slice(0, 20000) + "… [truncated oversized tool output]";
          }

          sequence++;
          this.dbEngine.writeWALRecord(agentDb, {
            id: crypto.randomUUID(),
            entityId: agentId,
            sequence,
            type: "TOOL_OBSERVATION",
            payload: { capability, method, result: observationResult.slice(0, 500) },
            timestamp: new Date().toISOString(),
          });

          messages.push({
            role: "user",
            content: `[Tool Observation for ${toolCall.name}]: ${observationResult}`,
          });
        }
      } else {
        isFinished = true;
        finalSummary = aiResult.content;
      }

      if (currentTurn % 10 === 0) {
        sequence++;
        const compaction: CompactionCheckpoint = {
          id: crypto.randomUUID(),
          agentId,
          taskId,
          sequence,
          summary: `Turn ${currentTurn} compaction summary: Agent processed ${messages.length} messages.`,
          factsExtracted: [`Executed ${currentTurn} turns.`, `Final answer status: ${isFinished}`],
          filesTouched: [handsOnPath],
          timestamp: new Date().toISOString(),
        };
        this.dbEngine.saveCompactionCheckpoint(agentDb, compaction);
      }
    }

    // 3. Write HANDS_OFF_[AGENT_NAME].md artifact
    const handOffPath = path.join(artifactsDir, `HANDS_OFF_${safeName}.md`);
    const handOffContent = `# HANDS OFF: ${templateName} (${agentId})\n\n**Task ID:** ${taskId}\n**Completed At:** ${new Date().toISOString()}\n**Total Turns:** ${currentTurn}\n\n## Final Handoff Summary\n${finalSummary || "Subtask completed successfully."}\n\n---\n*Sub-agent work completed and recorded in WAL database.*`;
    fs.writeFileSync(handOffPath, handOffContent, "utf-8");

    sequence++;
    this.dbEngine.writeWALRecord(agentDb, {
      id: crypto.randomUUID(),
      entityId: agentId,
      sequence,
      type: "SUBTASK_COMPLETED",
      payload: { handOffPath, turnsExecuted: currentTurn },
      timestamp: new Date().toISOString(),
    });

    artifacts.push({
      path: handOffPath,
      mimeType: "text/markdown",
      description: `Hands-off completion doc for ${templateName}`,
    });

    await this.bus.publish(`task.${taskId}.agent.${agentId}.result`, {
      kind: "result",
      from: agentId,
      taskId,
      artifacts,
      summary: finalSummary || "Subtask finished cleanly.",
    });

    return {
      summary: finalSummary || "Subtask finished cleanly.",
      artifacts,
      completed: true,
      handsOnPath,
      handOffPath,
    };
  }

  private extractPseudoToolCalls(content: string): Array<{ id: string; name: string; args: Record<string, any> }> {
    const calls: Array<{ id: string; name: string; args: Record<string, any> }> = [];
    if (!content || !content.trim()) return calls;

    const codeBlockRegex = /```(?:tool_code|python|json|javascript)?\s*([\s\S]*?)\s*```/gi;
    let match: RegExpExecArray | null;

    const parseSnippet = (snippet: string) => {
      const funcCallRegex = /([a-zA-Z0-9._]+)\s*\(\s*([^)]*)\s*\)/g;
      let fnMatch: RegExpExecArray | null;
      while ((fnMatch = funcCallRegex.exec(snippet)) !== null) {
        const fnName = fnMatch[1];
        const rawArgs = fnMatch[2];
        const args: Record<string, any> = {};
        if (rawArgs.trim()) {
          const kvRegex = /([a-zA-Z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g;
          let kvMatch: RegExpExecArray | null;
          while ((kvMatch = kvRegex.exec(rawArgs)) !== null) {
            const key = kvMatch[1];
            const val = kvMatch[2] ?? kvMatch[3] ?? kvMatch[4];
            args[key] = val;
          }
          if (Object.keys(args).length === 0 && !rawArgs.includes("=")) {
            const singleVal = rawArgs.replace(/^['"]|['"]$/g, "").trim();
            if (singleVal) {
              args["query"] = singleVal;
              args["path"] = singleVal;
              args["url"] = singleVal;
            }
          }
        }
        if (fnName && fnName.length > 2 && !["console.log", "print"].includes(fnName)) {
          calls.push({ id: `call-${crypto.randomUUID()}`, name: fnName, args });
        }
      }

      const yamlFuncRegex = /([a-zA-Z0-9._]+)\s*:\s*\n((?:\s+[a-zA-Z0-9_]+\s*:.*\n?)+)/g;
      let yamlMatch: RegExpExecArray | null;
      while ((yamlMatch = yamlFuncRegex.exec(snippet)) !== null) {
        const fnName = yamlMatch[1];
        const body = yamlMatch[2];
        const args: Record<string, any> = {};
        const lines = body.split("\n");
        for (const line of lines) {
          const parts = line.split(":");
          if (parts.length >= 2) {
            const k = parts[0].trim();
            const v = parts.slice(1).join(":").trim().replace(/^['"]|['"]$/g, "");
            if (k) args[k] = v;
          }
        }
        if (fnName && Object.keys(args).length > 0) {
          calls.push({ id: `call-${crypto.randomUUID()}`, name: fnName, args });
        }
      }
    };

    while ((match = codeBlockRegex.exec(content)) !== null) {
      parseSnippet(match[1]);
    }
    if (calls.length === 0) {
      parseSnippet(content);
    }
    return calls;
  }

  private async dispatchTool(call: { capability: string; method: string; args: Record<string, any> }): Promise<string> {
    const { capability, method, args } = call;
    try {
      if (capability === "canvas" || method === "parseAnnotations") {
        const res = await this.canvasTool.execute(args as any);
        return JSON.stringify(res);
      }
      if (capability === "graph" || method === "preflightCheck") {
        const res = await this.graphTool.execute(args as any);
        return JSON.stringify(res);
      }
      if (capability === "qa" || method === "checkCoverage") {
        const res = await this.qaTool.execute(args as any);
        return JSON.stringify(res);
      }
      if (capability === "cv" || method === "inspectAndInteract") {
        const res = await this.cvTool.execute(args as any);
        return JSON.stringify(res);
      }
      return `[Tool Execution Simulated]: Capability '${capability}', Method '${method}', Args: ${JSON.stringify(args)}`;
    } catch (err) {
      return `[Tool Error]: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
