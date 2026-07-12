import { describe, it, expect, vi, beforeEach } from "vitest";
import { MeshGateway } from "./mesh-gateway.js";

// Mock the openai package
const mockCreate = vi.fn();
const mockCreateStream = vi.fn();

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: (args: any) => {
            if (args.stream) {
              return mockCreateStream(args);
            }
            return mockCreate(args);
          },
        },
      };
    },
  };
});

describe("MeshGateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should run in Mock Mode if no API key is provided", async () => {
    const gateway = new MeshGateway({ apiKey: "" });
    const response = await gateway.chat(
      [{ role: "user", content: "test" }],
      { modelRole: "planner" }
    );
    expect(response.content).toContain("goal");
  });

  it("should yield mock streaming chunks when in Mock Mode", async () => {
    const gateway = new MeshGateway({ apiKey: "" });
    const stream = gateway.chatStream(
      [{ role: "user", content: "test" }],
      { modelRole: "verifier" }
    );
    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toContain("verification");
  });

  it("should emit sample reasoning via onReasoning in Mock Mode", async () => {
    const gateway = new MeshGateway({ apiKey: "" });
    const onReasoning = vi.fn();
    await gateway.chat(
      [{ role: "user", content: "test" }],
      { modelRole: "planner", onReasoning }
    );
    expect(onReasoning).toHaveBeenCalledTimes(1);
    expect(onReasoning.mock.calls[0][0]).toEqual(expect.any(String));
    expect((onReasoning.mock.calls[0][0] as string).length).toBeGreaterThan(0);
  });

  it("should forward provider reasoning_content to onReasoning", async () => {
    const gateway = new MeshGateway({ apiKey: "some-key" });
    mockCreate.mockResolvedValue({
      choices: [
        { message: { content: "the answer", reasoning_content: "let me think..." } },
      ],
    });
    const onReasoning = vi.fn();
    const response = await gateway.chat(
      [{ role: "user", content: "hello" }],
      { modelRole: "planner", onReasoning }
    );
    expect(response.content).toBe("the answer");
    expect(onReasoning).toHaveBeenCalledWith("let me think...");
  });

  it("sends API-safe tool names (colon → __) and decodes tool calls back", async () => {
    const gateway = new MeshGateway({ apiKey: "some-key" });
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              { id: "call-1", function: { name: "files__readFile", arguments: '{"path":"a.txt"}' } },
            ],
          },
        },
      ],
    });
    const response = await gateway.chat(
      [{ role: "user", content: "read a file" }],
      {
        modelRole: "worker",
        tools: [
          { name: "files:readFile", description: "Read a file.", parameters: { type: "object", properties: {} } },
        ],
      },
    );
    // Wire name must satisfy the provider's ^[a-zA-Z0-9_-]+$ constraint.
    const sentName = mockCreate.mock.calls[0][0].tools[0].function.name;
    expect(sentName).toBe("files__readFile");
    expect(sentName).toMatch(/^[a-zA-Z0-9_-]+$/);
    // The returned tool call is decoded back to the internal capability:method form.
    expect(response.toolCalls?.[0].name).toBe("files:readFile");
  });

  it("should not call onReasoning when the provider returns no reasoning", async () => {
    const gateway = new MeshGateway({ apiKey: "some-key" });
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "plain answer" } }],
    });
    const onReasoning = vi.fn();
    await gateway.chat(
      [{ role: "user", content: "hello" }],
      { modelRole: "planner", onReasoning }
    );
    expect(onReasoning).not.toHaveBeenCalled();
  });

  it("should cover each deterministic mock role response", async () => {
    const gateway = new MeshGateway({ apiKey: "" });

    const firstWorkerReply = await gateway.chat(
      [{ role: "user", content: "start work" }],
      { modelRole: "worker" },
    );
    expect(firstWorkerReply.content).toContain('"call"');

    const completedWorkerReply = await gateway.chat(
      [{ role: "user", content: "Tool Execution Result: success" }],
      { modelRole: "worker" },
    );
    expect(completedWorkerReply.content).toContain('"result"');

    const topic = await gateway.chat(
      [
        { role: "system", content: "Generate a channel topic" },
        { role: "user", content: "Ship the Release!" },
      ],
      { modelRole: "utility" },
    );
    expect(topic.content).toBe("ship-the-release");

    const finalVerification = await gateway.chat(
      [{ role: "system", content: "Act as the final synthesis and verification judge" }],
      { modelRole: "verifier" },
    );
    expect(finalVerification.content).toContain('"passed": true');

    await expect(
      gateway.chat([{ role: "user", content: "fallback" }], { modelRole: "utility" }),
    ).resolves.toMatchObject({ content: "{}" });
  });

  it("should make a real OpenAI call if API key is provided", async () => {
    const gateway = new MeshGateway({ apiKey: "some-key" });
    
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "real-gateway-reply" } }],
    });

    const response = await gateway.chat(
      [{ role: "user", content: "hello" }],
      { modelRole: "planner" }
    );

    expect(mockCreate).toHaveBeenCalled();
    expect(response.content).toBe("real-gateway-reply");
  });

  it("retries without temperature when a Bedrock-backed model deprecates it", async () => {
    const gateway = new MeshGateway({ apiKey: "some-key" });
    mockCreate
      .mockRejectedValueOnce(
        new Error("ValidationException: `temperature` is deprecated for this model"),
      )
      .mockResolvedValueOnce({
        choices: [{ message: { content: "continued older chat" } }],
      });

    await expect(
      gateway.chat(
        [{ role: "user", content: "continue" }],
        { modelRole: "utility", temperature: 0.3 },
      ),
    ).resolves.toMatchObject({ content: "continued older chat" });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0]).toHaveProperty("temperature", 0.3);
    expect(mockCreate.mock.calls[1][0]).not.toHaveProperty("temperature");
  });

  it("does not hide unrelated provider validation failures", async () => {
    const gateway = new MeshGateway({ apiKey: "some-key" });
    const error = new Error("ValidationException: malformed messages");
    mockCreate.mockRejectedValueOnce(error);

    await expect(
      gateway.chat([{ role: "user", content: "continue" }], { modelRole: "utility" }),
    ).rejects.toBe(error);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("should return an empty string when a real response has no content", async () => {
    const gateway = new MeshGateway({ apiKey: "some-key" });
    mockCreate.mockResolvedValue({ choices: [] });

    await expect(
      gateway.chat([{ role: "user", content: "hello" }], { modelRole: "planner", jsonMode: true }),
    ).resolves.toMatchObject({ content: "" });
  });

  it("should support real stream responses if API key is provided", async () => {
    const gateway = new MeshGateway({ apiKey: "some-key" });

    // Mock stream iterator
    const mockStream = {
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "part1" } }] };
        yield { choices: [{ delta: { content: "part2" } }] };
      },
    };
    mockCreateStream.mockResolvedValue(mockStream);

    const stream = gateway.chatStream(
      [{ role: "user", content: "hello" }],
      { modelRole: "planner" }
    );

    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(mockCreateStream).toHaveBeenCalled();
    expect(chunks).toEqual(["part1", "part2"]);
  });

  it("retries streaming without temperature when the selected model rejects it", async () => {
    const gateway = new MeshGateway({ apiKey: "some-key" });
    const fallbackStream = {
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "recovered" } }] };
      },
    };
    mockCreateStream
      .mockRejectedValueOnce(new Error("temperature is unsupported for this model"))
      .mockResolvedValueOnce(fallbackStream);

    const chunks: string[] = [];
    for await (const chunk of gateway.chatStream(
      [{ role: "user", content: "continue" }],
      { modelRole: "planner", temperature: 0.1 },
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["recovered"]);
    expect(mockCreateStream).toHaveBeenCalledTimes(2);
    expect(mockCreateStream.mock.calls[1][0]).not.toHaveProperty("temperature");
  });

  it("should skip empty real stream chunks", async () => {
    const gateway = new MeshGateway({ apiKey: "some-key" });
    mockCreateStream.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { choices: [] };
        yield { choices: [{ delta: { content: "" } }] };
        yield { choices: [{ delta: { content: "visible" } }] };
      },
    });

    const chunks: string[] = [];
    for await (const chunk of gateway.chatStream(
      [{ role: "user", content: "hello" }],
      { modelRole: "planner" },
    )) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["visible"]);
  });

  it("should throw error if OpenAI call fails", async () => {
    const gateway = new MeshGateway({ apiKey: "some-key" });
    mockCreate.mockRejectedValue(new Error("API Error"));

    await expect(
      gateway.chat([{ role: "user", content: "hello" }], { modelRole: "planner" })
    ).rejects.toThrow("API Error");
  });

  it("should normalize insufficient-funds errors from real calls", async () => {
    const gateway = new MeshGateway({ apiKey: "some-key" });
    mockCreate.mockRejectedValue({ status: 402 });

    await expect(
      gateway.chat([{ role: "user", content: "hello" }], { modelRole: "planner" }),
    ).rejects.toMatchObject({
      code: "insufficient_funds",
      message: expect.stringContaining("insufficient funds"),
    });
  });

  it("should propagate error during stream initialization", async () => {
    const gateway = new MeshGateway({ apiKey: "some-key" });
    mockCreateStream.mockRejectedValue(new Error("Stream Error"));

    const stream = gateway.chatStream(
      [{ role: "user", content: "hello" }],
      { modelRole: "planner" }
    );

    await expect(async () => {
      for await (const chunk of stream) {
        // no-op
      }
    }).rejects.toThrow("Stream Error");
  });
});
