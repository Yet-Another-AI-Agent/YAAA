import { useState } from "react";

export interface UILog {
  id: string;
  time: string;
  source: "orchestrator" | "agent" | "system";
  content: string;
}

export function useLogState() {
  const [logs, setLogs] = useState<UILog[]>([]);

  const addLog = (source: UILog["source"], content: string) => {
    setLogs((prev) => [
      ...prev,
      {
        id: Math.random().toString(),
        time: new Date().toLocaleTimeString(),
        source,
        content,
      },
    ]);
  };

  const clearLogs = () => {
    setLogs([]);
  };

  return {
    logs,
    addLog,
    clearLogs,
  };
}
