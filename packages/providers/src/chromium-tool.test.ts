import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChromiumTool } from "./chromium-tool.js";

vi.mock("playwright", () => {
  const mockPage = {
    goto: vi.fn(async (url: string) => ({ status: () => 200 })),
    reload: vi.fn(async () => ({ status: () => 200 })),
    goBack: vi.fn(async () => ({ status: () => 200 })),
    goForward: vi.fn(async () => ({ status: () => 200 })),
    url: vi.fn(() => "https://example.com/test"),
    title: vi.fn(async () => "Test Page"),
    screenshot: vi.fn(async () => {}),
    locator: vi.fn(() => ({
      waitFor: vi.fn(async () => {}),
      click: vi.fn(async () => {}),
      innerText: vi.fn(async () => "Page content"),
    })),
    on: vi.fn(),
    evaluate: vi.fn(async () => "complete"),
  };

  const mockContext = {
    newPage: vi.fn(async () => mockPage),
  };

  const mockBrowser = {
    newContext: vi.fn(async () => mockContext),
    close: vi.fn(async () => {}),
  };

  return {
    chromium: {
      launch: vi.fn(async () => mockBrowser),
    },
  };
});

describe("ChromiumTool Browser Enhancement Methods Test Suite", () => {
  let tool: ChromiumTool;
  let sessionId: string;

  beforeEach(async () => {
    tool = new ChromiumTool();
    const res = await tool.open({ headless: true });
    sessionId = res.id;
  });

  it("1. refresh (alias for reload) reloads page and returns preview path", async () => {
    const res = await tool.refresh(sessionId);
    expect(res).toBeDefined();
    expect(res.url).toBe("https://example.com/test");
    expect(res.title).toBe("Test Page");
  });

  it("2. navigateAndWait navigates to URL and waits for selector / network idle", async () => {
    const res = await tool.navigateAndWait(sessionId, "https://example.com/dashboard", {
      waitForSelector: "#dashboard-container",
      waitUntil: "networkidle",
    });

    expect(res).toBeDefined();
    expect(res.status).toBe(200);
    expect(res.url).toBe("https://example.com/test");
  });

  it("3. goBack and goBackTimes step back in browser history", async () => {
    const backSingle = await tool.goBack(sessionId);
    expect(backSingle).toBeDefined();
    expect(backSingle.url).toBe("https://example.com/test");

    const backTimes = await tool.goBackTimes(sessionId, 3);
    expect(backTimes).toBeDefined();
    expect(backTimes.stepsBack).toBe(3);
  });

  it("4. goFront and goFrontTimes step forward in browser history", async () => {
    const frontSingle = await tool.goFront(sessionId);
    expect(frontSingle).toBeDefined();
    expect(frontSingle.url).toBe("https://example.com/test");

    const frontTimes = await tool.goFrontTimes(sessionId, 2);
    expect(frontTimes).toBeDefined();
    expect(frontTimes.stepsFront).toBe(2);
  });

  it("5. multi executes actions sequentially from index 0 and supports recursive multi calls", async () => {
    const res = await tool.multi(sessionId, [
      { action: "navigate", params: { url: "https://example.com/login" } },
      { action: "refresh" },
      {
        action: "multi",
        actions: [
          { action: "go_back" },
          { action: "go_front_times", params: { times: 2 } },
        ],
      },
    ]);

    expect(res).toBeDefined();
    expect(res.id).toBe(sessionId);
    expect(res.results).toHaveLength(3);

    // Verify 0th index execution order
    expect(res.results[0].action).toBe("navigate");
    expect(res.results[1].action).toBe("refresh");
    expect(res.results[2].action).toBe("multi");

    // Verify recursive multi results
    const recursiveResults = res.results[2].result.results;
    expect(recursiveResults).toHaveLength(2);
    expect(recursiveResults[0].action).toBe("go_back");
    expect(recursiveResults[1].action).toBe("go_front_times");
  });
});
