import OpenAI from "openai";
import type { IMeshGateway, ChatMessage, ChatOptions, ModelRole, ChatResult, ToolDefinition } from "@yaaa/interfaces";
import { isInsufficientFundsError, INSUFFICIENT_FUNDS_CODE } from "@yaaa/shared";

/**
 * Normalize provider errors: if the failure means the account is out of
 * balance/credit, rethrow a clean, stably-coded error the UI can react to.
 */
function rethrowGatewayError(err: unknown): never {
  if (isInsufficientFundsError(err)) {
    const e = new Error(
      "Your Mesh API account has insufficient funds. Update your API key or add credit to continue.",
    ) as Error & { code?: string };
    e.code = INSUFFICIENT_FUNDS_CODE;
    throw e;
  }
  throw err as Error;
}

/**
 * Tool names are `capability:method` internally (e.g. "files:readFile"), but the
 * OpenAI-compatible API requires function names to match `^[a-zA-Z0-9_-]+$` — the
 * colon is rejected with a 400. Encode the colon to a double underscore on the
 * wire and decode it back when reading tool calls, keeping the internal
 * `capability:method` convention untouched everywhere else.
 */
const TOOL_NAME_WIRE_SEPARATOR = "__";
function encodeToolName(name: string): string {
  return name.replace(/:/g, TOOL_NAME_WIRE_SEPARATOR);
}
function decodeToolName(name: string): string {
  return name.replace(new RegExp(TOOL_NAME_WIRE_SEPARATOR, "g"), ":");
}

/** Some Bedrock-backed models reject the formerly valid temperature field. */
function rejectsTemperature(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err !== null && "message" in err
        ? String((err as { message?: unknown }).message)
        : String(err);
  return /temperature/i.test(message) && /deprecated|not supported|unsupported/i.test(message);
}

export interface MeshGatewayConfig {
  apiKey?: string;
  baseURL?: string;
  modelMapping?: Record<ModelRole, string>;
}

export class MeshGateway implements IMeshGateway {
  private openai: OpenAI;
  private modelMapping: Record<ModelRole, string>;
  private isMockMode: boolean;

  constructor(config: MeshGatewayConfig = {}) {
    const apiKey = config.apiKey || process.env.MESH_API_KEY;
    this.isMockMode = !apiKey;
    if (this.isMockMode) {
      console.log("ℹ️  [MeshGateway] MESH_API_KEY is not set. Running in MOCK Mode for testing.");
    }
    this.openai = new OpenAI({
      apiKey: apiKey || "dummy-key",
      baseURL: config.baseURL || "https://api.meshapi.ai/v1",
    });

    // Default Mesh API routing mapping for various agent roles. The planner is
    // the orchestrator's brain, so it always runs on the best available model.
    this.modelMapping = {
      planner: "anthropic/claude-sonnet-5",
      worker: "openai/gpt-4o",
      verifier: "google/gemini-3.1-pro", // genuine diversity to catch shared blindspots
      utility: "openai/gpt-4o-mini",
      ...config.modelMapping,
    };
  }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    if (this.isMockMode) {
      options.onReasoning?.(this.getMockReasoning(options.modelRole));
      const content = this.getMockResponse(messages, options.modelRole);
      
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
          if (parsed.call) {
            const tc = parsed.call;
            return {
              content,
              toolCalls: [{
                id: `mock-call-${Date.now()}`,
                name: `${tc.capability}:${tc.method}`,
                args: tc.args,
              }]
            };
          }
        } catch {
          // ignore
        }
      }
      return { content };
    }

    const model = this.modelMapping[options.modelRole];
    try {
      const oaiTools = options.tools?.map((t) => ({
        type: "function" as const,
        function: {
          name: encodeToolName(t.name),
          description: t.description,
          parameters: t.parameters,
        },
      }));

      const createCompletion = (includeTemperature: boolean) =>
        this.openai.chat.completions.create({
          model,
          messages,
          ...(includeTemperature ? { temperature: options.temperature ?? 0 } : {}),
          response_format: options.jsonMode ? { type: "json_object" } : undefined,
          tools: oaiTools,
        });

      let response;
      try {
        response = await createCompletion(true);
      } catch (err) {
        if (!rejectsTemperature(err)) throw err;
        response = await createCompletion(false);
      }

      const message = response.choices[0]?.message as
        | (typeof response.choices[0]["message"] & {
            reasoning_content?: string;
            reasoning?: string;
          })
        | undefined;

      const reasoning = message?.reasoning_content ?? message?.reasoning;
      if (reasoning) {
        options.onReasoning?.(reasoning);
      }

      const toolCalls = message?.tool_calls?.map((tc) => ({
        id: tc.id,
        name: decodeToolName(tc.function.name),
        args: JSON.parse(tc.function.arguments),
      }));

      return {
        content: message?.content || "",
        toolCalls,
      };
    } catch (err) {
      console.error(`Mesh API call failed using model ${model} for role ${options.modelRole}:`, err);
      rethrowGatewayError(err);
    }
  }

  async *chatStream(messages: ChatMessage[], options: ChatOptions): AsyncIterable<string> {
    if (this.isMockMode) {
      const response = this.getMockResponse(messages, options.modelRole);
      // Yield mock response in small chunks to simulate streaming
      const chunks = response.split(" ");
      for (const chunk of chunks) {
        yield `${chunk} `;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return;
    }

    const model = this.modelMapping[options.modelRole];
    try {
      const createStream = (includeTemperature: boolean) =>
        this.openai.chat.completions.create({
          model,
          messages,
          ...(includeTemperature ? { temperature: options.temperature ?? 0 } : {}),
          stream: true,
        });

      let stream;
      try {
        stream = await createStream(true);
      } catch (err) {
        if (!rejectsTemperature(err)) throw err;
        stream = await createStream(false);
      }

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta as
          | { content?: string; reasoning_content?: string; reasoning?: string }
          | undefined;
        const reasoning = delta?.reasoning_content ?? delta?.reasoning;
        if (reasoning) {
          options.onReasoning?.(reasoning);
        }
        const text = delta?.content || "";
        if (text) {
          yield text;
        }
      }
    } catch (err) {
      console.error(`Mesh API stream call failed using model ${model} for role ${options.modelRole}:`, err);
      rethrowGatewayError(err);
    }
  }

  /**
   * Sample reasoning text for MOCK mode so the UI "thinking" stream is
   * demoable without a real reasoning-capable model / API key.
   */
  private getMockReasoning(role: ModelRole): string {
    switch (role) {
      case "planner":
        return "The user's request needs to be decomposed. I'll create a file first, then add a verification pass so we can confirm the output is correct before reporting back.";
      case "worker":
        return "I have the subtask. The cleanest approach is a single file write with the required content, then hand the result back to the supervisor.";
      case "verifier":
        return "Checking the artifact exists and that its contents satisfy every success criterion in the plan before I pass this.";
      default:
        return "Working through the request step by step.";
    }
  }

  private getMockResponse(messages: ChatMessage[], role: ModelRole): string {
    if (role === "planner") {
      return `\`\`\`json
{
  "goal": "Create solid-state battery facts sheet",
  "subtasks": [
    {
      "id": "task-1",
      "title": "Create a file named summary.txt listing three facts about solid-state batteries",
      "capability": "files",
      "dependsOn": [],
      "riskLevel": "low",
      "successCriteria": "summary.txt contains three facts about solid-state batteries"
    },
    {
      "id": "task-2",
      "title": "Verify summary.txt facts and formatting",
      "capability": "verify",
      "dependsOn": ["task-1"],
      "riskLevel": "low",
      "successCriteria": "Verification pass completed"
    }
  ]
}
\`\`\``;
    }

    if (role === "worker") {
      console.log(`[MockGateway] messages length: ${messages.length}, messages: ${JSON.stringify(messages, null, 2)}`);
      const hasToolResult = messages.some(
        (m) => m.role === "user" && m.content.includes("Tool Execution Result")
      );
      if (!hasToolResult) {
        return `I will create the file summary.txt with three key facts about solid-state batteries.
\`\`\`json
{
  "call": {
    "capability": "files",
    "method": "writeFile",
    "args": {
      "path": "summary.txt",
      "content": "1. Solid-state batteries use solid electrolytes instead of liquid ones, significantly reducing fire risk.\\n2. They offer higher energy density, allowing longer range or runtime in the same physical size.\\n3. They support faster charging rates and have a longer overall lifecycle."
    }
  }
}
\`\`\``;
      }
      return `I have successfully created and verified the solid-state battery facts sheet in summary.txt.
\`\`\`json
{
  "result": {
    "artifacts": [
      { "path": "summary.txt", "mimeType": "text/plain", "description": "Solid-state battery facts" }
    ],
    "summary": "Created file summary.txt with three key facts about solid-state batteries."
  }
}
\`\`\``;
    }

    if (role === "utility") {
      const systemMsg = messages.find((m) => m.role === "system")?.content || "";
      if (systemMsg.includes("intent classifier")) {
        // Mock mode has no real NLP — report "task" and let the caller's
        // deterministic heuristics own the conversational path.
        return `{"intent": "task", "reply": ""}`;
      }
      if (systemMsg.includes("Team Lead")) {
        return "Hello! I'm the YAAA orchestrator. What are we building or working on today?";
      }
      if (systemMsg.includes("channel topic")) {
        const userMsg = messages.find((m) => m.role === "user")?.content || "mission";
        return userMsg
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 4)
          .join("-");
      }
    }

    if (role === "verifier") {
      const isFinalJudge = messages.some(
        (m) => m.role === "system" && m.content.includes("final synthesis and verification judge")
      );
      if (isFinalJudge) {
        return `\`\`\`json
{
  "passed": true,
  "summary": "Verified that summary.txt exists in the workspace and contains three distinct, correct facts about solid-state batteries."
}
\`\`\``;
      }
      return `\`\`\`json
{
  "verification": {
    "status": "passed",
    "reason": "Verified that summary.txt exists in the workspace and contains three distinct, correct facts about solid-state batteries."
  }
}
\`\`\``;
    }

    return "{}";
  }
}
