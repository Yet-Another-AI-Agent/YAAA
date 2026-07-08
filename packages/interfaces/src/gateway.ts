import type { AgentMessage } from "@yaaa/shared";

export type ModelRole = "planner" | "worker" | "verifier" | "utility";

export interface ChatOptions {
  modelRole: ModelRole;
  temperature?: number;
  jsonMode?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface IMeshGateway {
  chat(messages: ChatMessage[], options: ChatOptions): Promise<string>;
  chatStream(messages: ChatMessage[], options: ChatOptions): AsyncIterable<string>;
}
