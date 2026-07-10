import type { UIAgent } from "../models/TaskModel";
import type { UILog } from "../viewmodels/useLogState";

/** Statuses that indicate an agent is still participating in a mission. */
export function isActiveAgent(agent: UIAgent): boolean {
  return ["planned", "working", "blocked"].includes(agent.status);
}

/**
 * Produces the concise, public status updates shown in the mission channel.
 * Returning null for an unchanged state prevents noisy duplicate notices when
 * the runtime republishes the same agent record.
 */
export function formatAgentLifecycleNotice(
  previous: UIAgent | undefined,
  agent: UIAgent,
): string | null {
  const name = agent.handle || agent.displayName;
  if (previous?.status === agent.status) return null;

  if (!previous) {
    return `🟢 ${name} joined the mission as ${agent.role}.`;
  }

  switch (agent.status) {
    case "working":
      return `🟢 ${name} started ${agent.subtaskId || "their assignment"}.`;
    case "blocked":
      return `⚠️ ${name} is blocked and asked the orchestrator for help.`;
    case "completed":
      return `✅ ${name} completed ${agent.subtaskId || "their assignment"}.`;
    case "exited":
      return `👋 ${name} is done and exited the mission.`;
    case "failed":
      return `❌ ${name} stopped after an error.`;
    default:
      return null;
  }
}

/** Associates stream activity with an agent without imposing a log schema on the runtime. */
export function getAgentActivity(agent: UIAgent, logs: UILog[]): UILog[] {
  const identifiers = [agent.id, agent.handle.replace(/^@/, "")]
    .filter(Boolean)
    .map((identifier) => identifier.toLowerCase());

  return logs.filter((log) =>
    log.source === "agent" && identifiers.some((identifier) => log.content.toLowerCase().includes(identifier)),
  );
}

export function getVisibleLogContent(content: string): string {
  return content.replace(/^\[agent-lifecycle\]\s*/, "");
}

export function isAgentLifecycleLog(log: UILog): boolean {
  return log.source === "system" && log.content.startsWith("[agent-lifecycle]");
}
