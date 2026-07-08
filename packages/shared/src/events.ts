export const EVENTS = {
  // Task topics
  taskStarted: (taskId: string) => `task.${taskId}.started`,
  taskPlanUpdated: (taskId: string) => `task.${taskId}.plan_updated`,
  taskCompleted: (taskId: string) => `task.${taskId}.completed`,
  taskFailed: (taskId: string) => `task.${taskId}.failed`,

  // Agent communication topics
  agentMessage: (taskId: string) => `task.${taskId}.agent_message`,
  agentThought: (agentId: string) => `agent.${agentId}.thought`,

  // Tool / Permission topics
  toolCallRequested: (taskId: string, agentId: string) => `task.${taskId}.agent.${agentId}.tool_requested`,
  toolCallExecuted: (taskId: string, agentId: string) => `task.${taskId}.agent.${agentId}.tool_executed`,
  approvalRequired: (taskId: string) => `task.${taskId}.approval_required`,
  approvalResolved: (taskId: string) => `task.${taskId}.approval_resolved`,
};

// Wildcard utility matcher helper
export function matchTopic(pattern: string, topic: string): boolean {
  const patternParts = pattern.split(".");
  const topicParts = topic.split(".");
  
  let pIdx = 0;
  let tIdx = 0;
  
  while (pIdx < patternParts.length && tIdx < topicParts.length) {
    const pPart = patternParts[pIdx];
    
    if (pPart === "#") {
      if (pIdx === patternParts.length - 1) {
        return true;
      }
      const restPattern = patternParts.slice(pIdx + 1).join(".");
      for (let i = tIdx; i <= topicParts.length; i++) {
        if (matchTopic(restPattern, topicParts.slice(i).join("."))) {
          return true;
        }
      }
      return false;
    }
    
    if (pPart === "*") {
      pIdx++;
      tIdx++;
      continue;
    }
    
    if (pPart !== topicParts[tIdx]) {
      return false;
    }
    
    pIdx++;
    tIdx++;
  }
  
  return pIdx === patternParts.length && tIdx === topicParts.length;
}
