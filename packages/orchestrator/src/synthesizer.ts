import type { IMeshGateway, IStore } from "@yaaa/interfaces";
import { container, type Container } from "@yaaa/platform";
import type { TaskPlan } from "@yaaa/shared";

export class Synthesizer {
  private gateway: IMeshGateway;
  private store: IStore;

  constructor(scope: Container = container) {
    this.gateway = scope.resolve<IMeshGateway>("IMeshGateway");
    this.store = scope.resolve<IStore>("IStore");
  }

  async synthesize(taskId: string, plan: TaskPlan): Promise<{ passed: boolean; summary: string }> {
    const messages = await this.store.getMessages(taskId);
    const ledger = await this.store.getLedgerEntries(taskId);

    const factLog = ledger.flatMap((entry) => entry.facts).join("\n");
    const resultMessages = messages.filter((m) => m.kind === "result");
    const artifactsSummary = resultMessages
      .map((r: any) => `Artifacts from ${r.from}: ${JSON.stringify(r.artifacts)}\nSummary: ${r.summary}`)
      .join("\n\n");

    const systemPrompt = `You are a final synthesis and verification judge.
Your goal is to look at the initial user request, the plan, all steps executed, and the artifacts generated to decide if the task succeeded.
You must run a strict verification pass. Ensure there are no errors, incomplete responses, or missing files.

Format your output as a JSON block:
\`\`\`json
{
  "passed": true | false,
  "summary": "Detailed summary explaining why it passed, what was achieved, and list of key artifacts."
}
\`\`\`
`;

    const userPrompt = `
Initial Goal: "${plan.goal}"
Subtask plan:
${plan.subtasks.map((s) => `- [${s.id}] ${s.title} (Success criteria: ${s.successCriteria})`).join("\n")}

Execution facts:
${factLog}

Generated Artifacts:
${artifactsSummary}

Evaluate and return the verification JSON.
`;

    const response = await this.gateway.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      {
        modelRole: "verifier",
        temperature: 0.1,
      }
    );

    try {
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in synthesizer response.");
      }
      const rawJson = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      return {
        passed: Boolean(rawJson.passed),
        summary: String(rawJson.summary || "No summary provided.")
      };
    } catch (err: any) {
      console.error("Synthesizer response parsing failed:", err.message, "Response:", response);
      return {
        passed: false,
        summary: `Verification failed to compile: ${err.message}`
      };
    }
  }
}
