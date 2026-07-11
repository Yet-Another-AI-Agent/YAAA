import { Annotation } from "@langchain/langgraph";
import type { ChatMessage } from "@yaaa/interfaces";
import type { Subtask } from "@yaaa/shared";

export const AgentState = Annotation.Root({
  messages: Annotation<ChatMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  taskId: Annotation<string>(),
  agentId: Annotation<string>(),
  templateName: Annotation<string>(),
  instruction: Annotation<string>(),
  retryDirective: Annotation<string | undefined>(),
  currentStep: Annotation<number>(),
  errors: Annotation<string[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  result: Annotation<any>({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
  status: Annotation<"working" | "completed" | "failed">({
    reducer: (x, y) => y ?? x,
    default: () => "working",
  }),
});

export type AgentStateType = typeof AgentState.State;
