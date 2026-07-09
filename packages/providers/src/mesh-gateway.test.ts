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
    expect(response).toContain("goal");
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
    expect(response).toBe("the answer");
    expect(onReasoning).toHaveBeenCalledWith("let me think...");
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
    expect(response).toBe("real-gateway-reply");
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

  it("should throw error if OpenAI call fails", async () => {
    const gateway = new MeshGateway({ apiKey: "some-key" });
    mockCreate.mockRejectedValue(new Error("API Error"));

    await expect(
      gateway.chat([{ role: "user", content: "hello" }], { modelRole: "planner" })
    ).rejects.toThrow("API Error");
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
