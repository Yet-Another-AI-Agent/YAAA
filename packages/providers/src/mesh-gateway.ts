import OpenAI from "openai";
import type { IMeshGateway, ChatMessage, ChatOptions, ModelRole } from "@yaaa/interfaces";

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

    // Default Mesh API routing mapping for various agent roles.
    this.modelMapping = {
      planner: "openai/gpt-4o",
      worker: "openai/gpt-4o",
      verifier: "google/gemini-3.1-pro", // genuine diversity to catch shared blindspots
      utility: "openai/gpt-4o-mini",
      ...config.modelMapping,
    };
  }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<string> {
    if (this.isMockMode) {
      return this.getMockResponse(messages, options.modelRole);
    }

    const model = this.modelMapping[options.modelRole];
    try {
      const response = await this.openai.chat.completions.create({
        model,
        messages,
        temperature: options.temperature ?? 0,
        response_format: options.jsonMode ? { type: "json_object" } : undefined,
      });
      return response.choices[0]?.message?.content || "";
    } catch (err) {
      console.error(`Mesh API call failed using model ${model} for role ${options.modelRole}:`, err);
      throw err;
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
      const stream = await this.openai.chat.completions.create({
        model,
        messages,
        temperature: options.temperature ?? 0,
        stream: true,
      });

      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || "";
        if (text) {
          yield text;
        }
      }
    } catch (err) {
      console.error(`Mesh API stream call failed using model ${model} for role ${options.modelRole}:`, err);
      throw err;
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
