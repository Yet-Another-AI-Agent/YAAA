import { useState } from "react";

/**
 * How a log line should be presented in the chat:
 * - "thinking": model reasoning tokens, grouped into a collapsible panel.
 * - "activity": tool calls / side effects, shown as a subtle line.
 * - "response": the assistant's final answer, shown as a chat bubble.
 * - "system": lifecycle/status notes.
 */
export type UILogKind = "thinking" | "activity" | "response" | "system";

export interface UILog {
  id: string;
  time: string;
  source: "orchestrator" | "agent" | "system" | "user";
  content: string;
  kind: UILogKind;
}

export function useLogState() {
  const [logs, setLogs] = useState<UILog[]>([]);

  const addLog = (
    source: UILog["source"],
    content: string,
    kind: UILogKind = "system",
  ) => {
    setLogs((prev) => [
      ...prev,
      {
        id: Math.random().toString(),
        time: new Date().toLocaleTimeString(),
        source,
        content,
        kind,
      },
    ]);
  };

  const clearLogs = () => {
    setLogs([]);
  };

  const clearThoughts = () => {
    setLogs((prev) => prev.filter((log) => log.kind !== "thinking" && log.source !== "system"));
  };

  return {
    logs,
    addLog,
    clearLogs,
    clearThoughts,
  };
}
