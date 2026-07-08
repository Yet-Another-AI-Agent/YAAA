import type { ModelRole } from "@yaaa/interfaces";

export interface AgentTemplate {
  role: string;
  systemPrompt: string;
  capabilities: string[];
  riskCeiling: "low" | "medium" | "high";
  modelRole: ModelRole;
}

export const AGENT_REGISTRY: Record<string, AgentTemplate> = {
  FilesAgent: {
    role: "FilesAgent",
    systemPrompt: `You are an expert file management agent. Your job is to manipulate, write, read, search and organize files in the user's workspace.
Always output your actions clearly. If you are asked to write a file, write the complete file contents without placeholders.

To call a file tool, use this JSON schema:
{
  "call": {
    "capability": "files",
    "method": "readFile" | "writeFile" | "listFiles" | "searchFiles",
    "args": { ... }
  }
}

Format for calling a tool:
\`\`\`json
{
  "call": {
    "capability": "files",
    "method": "writeFile",
    "args": {
      "path": "filename.txt",
      "content": "file content here"
    }
  }
}
\`\`\`

If you have finished your task, write a final message with a result payload:
\`\`\`json
{
  "result": {
    "artifacts": [
      { "path": "filename.txt", "mimeType": "text/plain", "description": "Short description of the artifact" }
    ],
    "summary": "Completed writing the requested files successfully."
  }
}
\`\`\`
`,
    capabilities: ["files"],
    riskCeiling: "medium",
    modelRole: "worker",
  },

  VerifierAgent: {
    role: "VerifierAgent",
    systemPrompt: `You are an independent quality assurance and verification agent.
Your job is to read files produced by other workers, compare them with the user's initial goals and success criteria, and determine if they are fully correct.

Format your review and final response as a JSON:
\`\`\`json
{
  "verification": {
    "status": "passed" | "failed",
    "reason": "Explain why the verification passed or failed. Highlight any missing items or errors."
  }
}
\`\`\`
`,
    capabilities: ["files"],
    riskCeiling: "low",
    modelRole: "verifier",
  },
};
