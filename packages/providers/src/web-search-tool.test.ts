import { describe, expect, it, vi } from "vitest";
import { WebSearchTool } from "./web-search-tool.js";

describe("WebSearchTool", () => {
  it("returns normalized UI search results", async () => {
    const uiSearch = vi.fn().mockResolvedValue([
      { title: "NASA Solar System", url: "https://science.nasa.gov/solar-system/", description: "Overview" },
      { title: "NASA Solar System duplicate", url: "https://science.nasa.gov/solar-system/?utm=x", description: "Duplicate" },
    ]);
    const tool = new WebSearchTool([uiSearch]);

    await expect(tool.search("solar system", { limit: 5 })).resolves.toEqual([
      { title: "NASA Solar System", url: "https://science.nasa.gov/solar-system/", description: "Overview" },
    ]);
    expect(uiSearch).toHaveBeenCalledWith("solar system", {
      limit: 5,
      safeSearch: undefined,
      time: undefined,
      timeoutMs: 20_000,
    });
  });

  it("tries the next UI searcher when one fails", async () => {
    const failingUiSearch = vi.fn().mockRejectedValue(new Error("browser search unavailable"));
    const succeedingUiSearch = vi.fn().mockResolvedValue([
      { title: "Solar System Exploration", url: "https://science.nasa.gov/solar-system/", description: "NASA overview" },
    ]);
    const tool = new WebSearchTool([failingUiSearch, succeedingUiSearch]);

    await expect(tool.search("NASA solar system facts overview sun")).resolves.toEqual([
      { title: "Solar System Exploration", url: "https://science.nasa.gov/solar-system/", description: "NASA overview" },
    ]);
    expect(succeedingUiSearch).toHaveBeenCalledWith("NASA solar system facts overview sun", {
      limit: 10,
      safeSearch: undefined,
      time: undefined,
      timeoutMs: 20_000,
    });
  });

  it("preserves the search-page screenshot path while normalizing results", async () => {
    const results = [
      { title: "Search result", url: "https://example.com", description: "Example" },
    ] as Array<{ title: string; url: string; description: string }> & { screenshotPath?: string };
    Object.defineProperty(results, "screenshotPath", {
      value: "/tmp/yaaa-tool-previews/search.png",
      enumerable: false,
    });
    const tool = new WebSearchTool([vi.fn().mockResolvedValue(results)]);

    const normalized = await tool.search("example");

    expect((normalized as typeof results).screenshotPath).toBe("/tmp/yaaa-tool-previews/search.png");
  });
});
