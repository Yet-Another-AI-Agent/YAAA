import type { AgentMessage } from "@yaaa/shared";

export type ModelRole = "planner" | "worker" | "verifier" | "utility";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface ChatOptions {
  modelRole: ModelRole;
  /** Optional exact Mesh model id; takes precedence over the role mapping. */
  model?: string;
  temperature?: number;
  jsonMode?: boolean;
  tools?: ToolDefinition[];
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

export interface ChatResult {
  content: string;
  toolCalls?: {
    id: string;
    name: string;
    args: Record<string, any>;
  }[];
}

/** Outcome of resolving a requested model against Mesh's live catalog. */
export interface ModelResolution {
  /** Concrete model id to run with, or undefined when nothing could be chosen. */
  model?: string;
  /** Human-readable rationale, surfaced to the user next to the agent. */
  reason: string;
}

/**
 * Resolves the model an agent should run with. YAAA loads Mesh's catalog once
 * per runtime and answers every request from that snapshot, so the planner's
 * choice is honoured whenever Mesh actually offers it.
 */
export type ModelResolver = (requested?: string) => Promise<ModelResolution>;

export interface IMeshGateway {
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult>;
  chatStream(messages: ChatMessage[], options: ChatOptions): AsyncIterable<string>;
  generateImage?(prompt: string, options?: { model?: string; background?: "transparent" | "opaque" | "auto" }): Promise<string>;
}
