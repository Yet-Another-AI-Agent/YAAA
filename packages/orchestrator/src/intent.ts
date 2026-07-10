import type { ChatMessage, IMeshGateway } from "@yaaa/interfaces";

/**
 * The orchestrator's conversational NLP layer. Every user message is classified
 * BEFORE any task machinery runs: greetings and small talk get a conversational
 * reply from the "Team Lead" persona, and only genuine work requests reach the
 * TaskPlanner. This is what keeps "hi" from producing a task folder, a raw
 * UUID channel, and a frozen "Awaiting plan..." UI.
 */
export type MessageIntent = "conversation" | "task";

export interface IntentDecision {
  intent: MessageIntent;
  /** Present when intent is "conversation" — the orchestrator's chat reply. */
  reply?: string;
}

export interface IntentRouterContext {
  userName?: string;
}

const FALLBACK_GREETING =
  "Hello! I'm the YAAA orchestrator. What are we building or working on today?";

/**
 * Deterministic small-talk detector. These inputs must never reach the
 * planner, with or without an LLM available, so the check is pure regex —
 * greetings, thanks, farewells, and short capability questions.
 */
const CONVERSATIONAL_PATTERNS: RegExp[] = [
  /^(hi+|hii+|hello+|hey+|heya|yo|sup|howdy|hola|namaste)\b[\s!.,?]*$/i,
  /^good\s+(morning|afternoon|evening|night)\b[\s!.,?]*$/i,
  /^(hi|hello|hey)\s+(there|team|everyone|yaaa|orchestrator)\b[\s!.,?]*$/i,
  /^(thanks|thank you|thx|ty|cheers)\b.{0,40}$/i,
  /^(bye|goodbye|see you|later|good night)\b[\s!.,?]*$/i,
  /^(how are you|how's it going|what's up|wassup|hows it going)\b.{0,20}$/i,
  /^(who are you|what are you|what can you do|what do you do|help|help me)\b.{0,30}$/i,
  /^(ok|okay|cool|nice|great|awesome|sounds good|got it|hmm+)\b[\s!.,?]*$/i,
  /^(test|testing|ping)[\s!.,?]*$/i,
];

/** Words that strongly signal actionable work even in a short message. */
const TASK_SIGNALS =
  /\b(build|create|write|make|fix|debug|refactor|implement|design|deploy|migrate|analyze|analyse|generate|research|test|review|scrape|draft|plan|setup|set up|install|convert|translate|summarize|summarise|update|delete|rename|optimi[sz]e|search|find|list|compare|run)\b/i;

export function detectConversationalHeuristic(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return true;
  if (TASK_SIGNALS.test(trimmed)) return false;
  return CONVERSATIONAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** A usable reply is non-empty plain prose, not JSON/code the mock gateway emits. */
function sanitizeReply(raw: string | undefined | null): string | null {
  const reply = (raw ?? "").trim();
  if (!reply) return null;
  if (
    reply.startsWith("{") ||
    reply.startsWith("[") ||
    reply.startsWith("```")
  ) {
    return null;
  }
  return reply.length > 1200 ? `${reply.slice(0, 1200)}…` : reply;
}

export class IntentRouter {
  constructor(private readonly gateway: IMeshGateway) {}

  async route(
    message: string,
    context: IntentRouterContext = {},
  ): Promise<IntentDecision> {
    if (detectConversationalHeuristic(message)) {
      return {
        intent: "conversation",
        reply: await this.generateReply(message, context),
      };
    }

    const classification = await this.classifyWithModel(message);
    if (classification.intent === "conversation") {
      return {
        intent: "conversation",
        reply:
          sanitizeReply(classification.reply) ??
          (await this.generateReply(message, context)),
      };
    }
    return { intent: "task" };
  }

  /**
   * LLM classification for messages the heuristic can't decide. Any failure —
   * network, malformed JSON, mock-mode placeholder output — defaults to "task"
   * so a real work request is never silently swallowed.
   */
  private async classifyWithModel(message: string): Promise<IntentDecision> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `You are the intent classifier for YAAA's orchestrator.
Decide whether the user's message is casual conversation or an actionable work request.
"conversation": greetings, small talk, questions about you, acknowledgements, chit-chat.
"task": anything that asks for work — building, researching, writing, fixing, planning, designing.
Respond with ONLY a JSON object: {"intent": "conversation" | "task", "reply": "short friendly reply if conversation, else empty string"}`,
      },
      { role: "user", content: message },
    ];
    try {
      const raw = await this.gateway.chat(messages, {
        modelRole: "utility",
        temperature: 0,
        jsonMode: true,
      });
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return { intent: "task" };
      const parsed = JSON.parse(match[0]);
      if (parsed?.intent === "conversation") {
        return {
          intent: "conversation",
          reply: typeof parsed.reply === "string" ? parsed.reply : undefined,
        };
      }
      return { intent: "task" };
    } catch {
      return { intent: "task" };
    }
  }

  /** Team-Lead persona reply, with a canned fallback for mock mode/outages. */
  private async generateReply(
    message: string,
    context: IntentRouterContext,
  ): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `You are @orchestrator, the friendly Team Lead of YAAA, an AI professional firm.
The user is chatting casually — do NOT produce plans, lists of steps, or JSON.
Reply in 1-2 warm, concise sentences${context.userName ? ` (the user's name is ${context.userName})` : ""} and invite them to describe what they'd like to build or work on.`,
      },
      { role: "user", content: message },
    ];
    try {
      const raw = await this.gateway.chat(messages, {
        modelRole: "utility",
        temperature: 0.7,
      });
      return sanitizeReply(raw) ?? FALLBACK_GREETING;
    } catch {
      return FALLBACK_GREETING;
    }
  }
}
