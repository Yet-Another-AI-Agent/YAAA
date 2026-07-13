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

    const systemPrompt = `You are a final synthesis and verification judge, and a RECONCILER of the verification pass.
Your goal is to look at the initial user request, the plan, all steps executed, and the artifacts generated to decide if the task succeeded.
You must run a strict verification pass. Ensure there are no errors, incomplete responses, or missing files.

Reconciliation duties (important):
- Verifier agents may DISAGREE about the same deliverable. Do not simply take the most negative verdict. Weigh each verifier's concrete evidence, and side with the verdict best supported by the actual artifacts and criteria.
- Watch for a verifier failing on an over-literal or ambiguous reading of a success criterion (e.g. treating "15 minutes per slide" as a hard 2000-word-per-slide rule). Judge against the user's evident intent and a reasonable interpretation, not a pedantic one, and say so in your summary.
- Only fail the task for a genuine, evidence-backed defect (missing/empty deliverable, factual error, unmet core requirement) — not for a disagreement that the evidence resolves in the work's favor.

Format your output as a JSON block:
\`\`\`json
{
  "passed": true | false,
  "summary": "Detailed summary: the reconciled verdict, how you resolved any verifier disagreement, what was achieved, and the key artifacts."
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

    const responseRes = await this.gateway.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      {
        modelRole: "verifier",
        temperature: 0.1,
      }
    );
    const response = responseRes.content;

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
