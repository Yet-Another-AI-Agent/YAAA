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
});
