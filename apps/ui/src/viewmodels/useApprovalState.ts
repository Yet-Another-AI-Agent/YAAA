import { useState } from "react";
import { TaskModel } from "../models/TaskModel";
import type { ToolCall } from "@yaaa/shared";

export function useApprovalState(
  taskId: string | null,
  addLog: (source: "system", content: string) => void
) {
  const [pendingApproval, setPendingApproval] = useState<{
    agentId: string;
    toolCall: ToolCall;
  } | null>(null);

  const resolveApproval = async (approved: boolean) => {
    if (!pendingApproval || !taskId) return;

    const { toolCall } = pendingApproval;
    setPendingApproval(null);
    addLog("system", `Sending approval resolution: ${approved ? "APPROVED" : "REJECTED"}`);

    try {
      await TaskModel.resolveApproval(toolCall.id, approved);
    } catch (err: any) {
      addLog("system", `Failed to send approval: ${err.message}`);
    }
  };

  return {
    pendingApproval,
    setPendingApproval,
    resolveApproval,
  };
}
