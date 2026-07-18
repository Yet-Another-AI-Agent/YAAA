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

const MIN_API_ATTEMPTS = 3;

function retryDelay(attempt: number): number {
  const configured = Number(process.env.YAAA_API_RETRY_DELAY_MS);
  const base = Number.isFinite(configured) && configured >= 0 ? configured : 250;
  return base * 2 ** (attempt - 1);
}

async function retryApiCall<T>(label: string, operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= MIN_API_ATTEMPTS; attempt++) {
    attemptsMade = attempt;
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      // Deterministic request/schema errors will not improve on retry. API
      // availability failures (timeouts, transport, 429/5xx) still receive
      // the required three attempts.
      if (isInsufficientFundsError(err) || /validationexception|bad request|\b400\b/i.test(message) || attempt === MIN_API_ATTEMPTS) break;
      console.warn(`[MeshGateway] ${label} failed; retrying`, {
        attempt,
        nextAttempt: attempt + 1,
        error: err instanceof Error ? err.message : String(err),
        delayMs: retryDelay(attempt),
      });
      await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
    }
  }
  console.error(`[MeshGateway] ${label} exhausted ${attemptsMade} API attempt(s)`, {
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
  throw lastError;
}

export interface MeshGatewayConfig {
  apiKey?: string;
  baseURL?: string;
  modelMapping?: Record<ModelRole, string>;
  timeout?: number;
  maxRetries?: number;
}

export interface MeshModelCatalogEntry {
  id: string;
  /** Human-facing name, e.g. "Anthropic: Claude Sonnet 4.5". */
  name?: string;
  /** Vendor slug, e.g. "anthropic". Mirrors the id's prefix. */
  brand?: string;
  /** Context window in tokens. */
  context_length?: number;
  model_type?: string;
  supports_tools?: boolean;
  supports_completions_api?: boolean;
  pricing?: {
    prompt_usd_per_1k?: number;
    completion_usd_per_1k?: number;
    prompt_usd_per_1m?: number;
    completion_usd_per_1m?: number;
  };
  is_free?: boolean;
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
    const timeout = config.timeout ?? (process.env.YAAA_TIMEOUT ? Number(process.env.YAAA_TIMEOUT) : (process.env.MESH_TIMEOUT ? Number(process.env.MESH_TIMEOUT) : 60000));
    const maxRetries = config.maxRetries ?? (process.env.YAAA_MAX_RETRIES ? Number(process.env.YAAA_MAX_RETRIES) : (process.env.MESH_MAX_RETRIES ? Number(process.env.MESH_MAX_RETRIES) : 3));

    this.openai = new OpenAI({
      apiKey: apiKey || "dummy-key",
      baseURL: config.baseURL || "https://api.meshapi.ai/v1",
      timeout,
      maxRetries,
    });

    // Default Mesh API routing mapping for various agent roles. The planner can
    // assign any supported provider/company model per subtask, while these are
    // only fallback role mappings when no explicit model was selected.
    this.modelMapping = {
      planner: "google/gemini-2.5-pro",
      worker: "google/gemini-2.5-flash",
      verifier: "google/gemini-2.5-flash",
      utility: "google/gemini-2.5-flash",
      ...config.modelMapping,
    };
  }

  /** Read Mesh's live, cross-provider catalog. Pricing and availability are
   * intentionally not duplicated in YAAA; Mesh is the source of truth.
   *
   * This deliberately does not go through the OpenAI SDK's `models.list()`.
   * Mesh answers `GET /models` with a **bare JSON array**, not OpenAI's
   * `{object: "list", data: [...]}` envelope, so the SDK finds no `data` and
   * yields an empty catalog — silently, which made every catalog-driven
   * decision fall back to its hardcoded default. Both shapes are accepted here
   * so the gateway keeps working if Mesh ever adopts the envelope.
   */
  async listModels(): Promise<MeshModelCatalogEntry[]> {
    if (this.isMockMode) return [];
    const payload = await retryApiCall("models.list", async () => {
      const response = await this.openai.get("/models", {}) as unknown;
      return response;
    });
    return MeshGateway.parseModelCatalog(payload);
  }

  /** Accept either a bare array or an OpenAI-style `{data: [...]}` envelope. */
  static parseModelCatalog(payload: unknown): MeshModelCatalogEntry[] {
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { data?: unknown })?.data)
        ? (payload as { data: unknown[] }).data
        : [];
    return (list as MeshModelCatalogEntry[]).filter((model) => Boolean(model?.id));
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

      const response = await retryApiCall(`chat(${options.modelRole})`, async () => {
        try {
          return await createCompletion(true);
        } catch (err) {
          if (!rejectsTemperature(err)) throw err;
          return await createCompletion(false);
        }
      });

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

      const stream = await retryApiCall(`chatStream(${options.modelRole})`, async () => {
        try {
          return await createStream(true);
        } catch (err) {
          if (!rejectsTemperature(err)) throw err;
          return await createStream(false);
        }
      });

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

  async generateImage(prompt: string, options: { model?: string } = {}): Promise<string> {
    if (this.isMockMode) {
      return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    }
    // Image model is operator-configurable so a deployment can point at whatever
    // image endpoint Mesh exposes without a code change; defaults to imagen-3.
    const model = options.model || process.env.YAAA_IMAGE_MODEL?.trim() || "google/imagen-3";
    try {
      const response = await retryApiCall(`generateImage(${model})`, () =>
        this.openai.images.generate({
          model,
          prompt,
          n: 1,
          size: "1024x1024",
        }),
      );
      const item = response.data?.[0];
      if (!item) {
        throw new Error("No image data returned from Mesh API.");
      }
      const url = item.url || "";
      if (url.startsWith("data:image/png;base64,")) {
        return url.split(",")[1];
      }
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      return Buffer.from(buf).toString("base64");
    } catch (err) {
      console.error(`Mesh API image generation failed using model ${model}:`, err);
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
      "successCriteria": "summary.txt contains three facts about solid-state batteries",
      "agentTemplate": "ResearcherAgent",
      "routingReason": "This work requires factual research and synthesis."
    },
    {
      "id": "task-2",
      "title": "Verify summary.txt facts and formatting",
      "capability": "verify",
      "dependsOn": ["task-1"],
      "riskLevel": "low",
      "successCriteria": "Verification pass completed",
      "agentTemplate": "QaTesterAgent",
      "routingReason": "This work independently verifies factual and formatting requirements."
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
        const userMsg = messages.find((m) => m.role === "user")?.content || "";
        const isGreeting = /^(hi+|hii+|hello+|hey+|heya|yo|sup|howdy|hola|namaste)\b[\s!.,?]*$/i.test(userMsg.trim());
        if (isGreeting) {
          return `{"intent": "conversation", "reply": "Hello!"}`;
        }
        return `{"intent": "task", "reply": ""}`;
      }
      if (systemMsg.includes("Team Lead")) {
        console.log("Mock Gateway Team Lead messages: ", JSON.stringify(messages, null, 2));
        const hasNotes = messages.some((m) => m.content && m.content.includes("notes.txt"));
        if (hasNotes) {
          return "I created notes.txt with your note earlier. Anything else?";
        }
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
