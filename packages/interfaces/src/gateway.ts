import type { AgentMessage } from "@yaaa/shared";

export type ModelRole = "planner" | "worker" | "verifier" | "utility";

export interface ChatOptions {
  modelRole: ModelRole;
  temperature?: number;
  jsonMode?: boolean;
  /**
   * Invoked with the model's reasoning/thinking tokens when the provider
   * surfaces them separately from the answer (e.g. `reasoning_content`).
   * Callers that render a "thinking" stream pass this; others omit it.
   * For streaming calls it fires per reasoning delta; for a single `chat`
   * call it fires once with the full reasoning text.
   */
  onReasoning?: (reasoning: string) => void;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface IMeshGateway {
  chat(messages: ChatMessage[], options: ChatOptions): Promise<string>;
  chatStream(messages: ChatMessage[], options: ChatOptions): AsyncIterable<string>;
}
