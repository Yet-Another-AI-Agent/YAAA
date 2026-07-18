import type { ChatMessage, ChatOptions, IMeshGateway } from "@yaaa/interfaces";
import { describe, expect, it, vi } from "vitest";
import { IntentRouter, detectConversationalHeuristic } from "./intent.js";

function makeGateway(
  responses: string[] | ((messages: ChatMessage[]) => string),
): IMeshGateway {
  const queue = Array.isArray(responses) ? [...responses] : null;
  return {
    chat: vi.fn(async (messages: ChatMessage[], _options: ChatOptions) => {
      const content = queue
        ? queue.shift() ?? ""
        : (responses as (messages: ChatMessage[]) => string)(messages);
      return { content };
    }),
    // biome-ignore lint/correctness/useYield: unused in these tests
    chatStream: vi.fn(async function* () {
      throw new Error("not used");
    }),
  } as unknown as IMeshGateway;
}

describe("detectConversationalHeuristic", () => {
  it.each([
    "hi",
    "Hi!",
    "hello there",
    "hey",
    "good morning",
    "thanks!",
    "what can you do?",
    "how are you",
    "ok",
    "bye",
    "",
  ])("treats %j as conversation", (message) => {
    expect(detectConversationalHeuristic(message)).toBe(true);
  });

  it.each([
    "Build me a landing page",
    "fix the login bug",
    "hi, please create a report on solid-state batteries",
    "Migrate the legacy database to Kafka microservices",
    "make a pamphlet for a dental clinic",
  ])("treats %j as work", (message) => {
    expect(detectConversationalHeuristic(message)).toBe(false);
  });
});

describe("IntentRouter", () => {
  it("classifies a greeting with the model before answering", async () => {
    const gateway = makeGateway([
      '{"intent":"conversation","reply":"Hello Ada! What are we building today?"}',
    ]);
    const router = new IntentRouter(gateway);

    const decision = await router.route("hi", { userName: "Ada" });

    expect(decision.intent).toBe("conversation");
    expect(decision.reply).toBe("Hello Ada! What are we building today?");
    // The classifier supplied a usable reply, so no second generation call.
    expect(gateway.chat).toHaveBeenCalledTimes(1);
  });

  it("falls back to a canned greeting when the reply model returns JSON noise", async () => {
    const gateway = makeGateway(["{}"]);
    const router = new IntentRouter(gateway);

    const decision = await router.route("hello");

    expect(decision.intent).toBe("conversation");
    expect(decision.reply).toContain("What are we building");
  });

  it("falls back to a canned greeting when the reply model throws", async () => {
    const gateway = {
      chat: vi.fn().mockRejectedValue(new Error("offline")),
      chatStream: vi.fn(),
    } as unknown as IMeshGateway;
    const router = new IntentRouter(gateway);

    const decision = await router.route("hey there");

    expect(decision.intent).toBe("conversation");
    expect(decision.reply).toContain("What are we building");
  });

  it("classifies ambiguous input with the model and uses its conversational reply", async () => {
    const gateway = makeGateway([
      '{"intent": "conversation", "reply": "Doing great — ready when you are!"}',
    ]);
    const router = new IntentRouter(gateway);

    const decision = await router.route("just checking in on the team vibes");

    expect(decision.intent).toBe("conversation");
    expect(decision.reply).toBe("Doing great — ready when you are!");
  });

  it("routes model-classified task intents to the planner path", async () => {
    const gateway = makeGateway(['{"intent": "task", "reply": ""}']);
    const router = new IntentRouter(gateway);

    const decision = await router.route(
      "quarterly report for the dental campaign",
    );

    expect(decision).toEqual({ intent: "task" });
  });

  it("defaults to task when the classifier output is unparseable", async () => {
    const gateway = makeGateway(["definitely not json"]);
    const router = new IntentRouter(gateway);

    const decision = await router.route(
      "something ambiguous about the project",
    );

    expect(decision).toEqual({ intent: "task" });
  });

  it("defaults to task when the classifier call fails", async () => {
    const gateway = {
      chat: vi.fn().mockRejectedValue(new Error("offline")),
      chatStream: vi.fn(),
    } as unknown as IMeshGateway;
    const router = new IntentRouter(gateway);

    const decision = await router.route(
      "something ambiguous about the project",
    );

    expect(decision).toEqual({ intent: "task" });
  });

  it("generates a fresh reply when the classifier says conversation but gives no usable reply", async () => {
    const gateway = makeGateway([
      '{"intent": "conversation", "reply": ""}',
      "Happy to chat! What would you like to work on?",
    ]);
    const router = new IntentRouter(gateway);

    const decision = await router.route("tell me about yourself and the firm");

    expect(decision.intent).toBe("conversation");
    expect(decision.reply).toBe(
      "Happy to chat! What would you like to work on?",
    );
  });

  it("never lets a work request with a greeting prefix stay conversational", async () => {
    const gateway = makeGateway(['{"intent": "task", "reply": ""}']);
    const router = new IntentRouter(gateway);

    const decision = await router.route("hi, build a 3D aligner viewer");

    expect(decision).toEqual({ intent: "task" });
  });

  it("truncates absurdly long conversational replies", async () => {
    const gateway = makeGateway([
      '{"intent":"conversation","reply":""}',
      "a".repeat(5000),
    ]);
    const router = new IntentRouter(gateway);

    const decision = await router.route("hi");

    const reply = decision.reply ?? "";
    expect(reply.length).toBeLessThanOrEqual(1201);
    expect(reply.endsWith("…")).toBe(true);
  });

  it.each([
    ['{"intent":"approve"}', "Yes, go ahead and execute the plan."],
    ['{"intent":"reject"}', "No, do not start this plan."],
    ['{"intent":"feedback"}', "Can you simplify the second step?"],
  ])("classifies plan review response %j", async (response, message) => {
    const router = new IntentRouter(makeGateway([response]));
    await expect(router.classifyPlanReview(message)).resolves.toBe(JSON.parse(response).intent);
  });

  it("conservatively treats invalid plan review output as feedback", async () => {
    const router = new IntentRouter(makeGateway(["not json"]));
    await expect(router.classifyPlanReview("what is happening?")).resolves.toBe("feedback");
  });

  it("uses the model to distinguish resume from a mission correction", async () => {
    const resumeRouter = new IntentRouter(makeGateway(['{"intent":"resume"}']));
    const correctionRouter = new IntentRouter(makeGateway(['{"intent":"correction"}']));
    await expect(resumeRouter.classifyMissionFollowup("continue from where you left off")).resolves.toBe("resume");
    await expect(correctionRouter.classifyMissionFollowup("I am in India, use Amazon India")).resolves.toBe("correction");
  });
});
