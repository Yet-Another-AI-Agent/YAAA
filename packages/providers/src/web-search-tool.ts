import * as cheerio from "cheerio";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { renderTextScreenshot } from "./screenshot.js";

export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

export interface SearchOptions {
  limit?: number;
  safeSearch?: "strict" | "moderate" | "off";
  time?: "day" | "week" | "month" | "year";
}

interface UiSearchOptions extends Required<Pick<SearchOptions, "limit">> {
  safeSearch?: SearchOptions["safeSearch"];
  time?: SearchOptions["time"];
  timeoutMs: number;
}

type UiSearcher = (query: string, options: UiSearchOptions) => Promise<SearchResult[]>;

function attachScreenshotPath(results: SearchResult[], screenshotPath: string): SearchResult[] {
  Object.defineProperty(results, "screenshotPath", {
    value: screenshotPath,
    enumerable: false,
  });
  return results;
}

function normalizeResults(results: SearchResult[], limit: number): SearchResult[] {
  const seen = new Set<string>();
  return results
    .filter((result) => result.title && result.url)
    .filter((result) => {
      const key = result.url.replace(/[#?].*$/, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function bingSafeSearch(value: SearchOptions["safeSearch"]): string {
  if (value === "strict") return "strict";
  if (value === "off") return "off";
  return "moderate";
}

function bingFreshness(value: SearchOptions["time"]): string | undefined {
  if (value === "day") return 'ex1:"ez1"';
  if (value === "week") return 'ex1:"ez2"';
  if (value === "month") return 'ex1:"ez3"';
  return undefined;
}

async function searchBingBrowser(query: string, options: UiSearchOptions): Promise<SearchResult[]> {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("safeSearch", bingSafeSearch(options.safeSearch));
  const freshness = bingFreshness(options.time);
  if (freshness) url.searchParams.set("filters", freshness);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs,
    });
    const results = await page.locator("li.b_algo").evaluateAll((items) =>
      items.map((item) => {
        const node = item as any;
        const link = node.querySelector("h2 a");
        const caption = node.querySelector(".b_caption p");
        return {
          title: link?.textContent?.replace(/\s+/g, " ").trim() ?? "",
          url: link?.href ?? "",
          description: caption?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        };
      }),
    ) as SearchResult[];
    const normalized = normalizeResults(results, options.limit);
    try {
      const screenshotPath = path.join(os.tmpdir(), "yaaa-tool-previews", `web-search-${crypto.randomUUID()}.png`);
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: false });
      return attachScreenshotPath(normalized, screenshotPath);
    } catch {
      return normalized;
    }
  } finally {
    await browser.close();
  }
}

export class WebSearchTool {
  constructor(
    private readonly uiSearchers: UiSearcher[] = [searchBingBrowser],
  ) {}

  async search(query: string, options: SearchOptions = {}) {
    const limit = options.limit ?? 10;
    const errors: string[] = [];
    for (const uiSearcher of this.uiSearchers) {
      try {
        const results = await uiSearcher(query, {
          limit,
          safeSearch: options.safeSearch,
          time: options.time,
          timeoutMs: 20_000,
        });
        if (results.length > 0) return normalizeResults(results, limit);
        errors.push("UI search returned no results");
      } catch (error: any) {
        errors.push(error?.message ?? String(error));
      }
    }
    throw new Error(`UI search failed: ${errors.join(" | ")}`);
  }
  async fetch(url: string, options: { selector?: string; timeoutMs?: number; maxChars?: number } = {}) {
    const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 20_000), headers: { "user-agent": "YAAA-Agent/1.0" } });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const html = await response.text(); const $ = cheerio.load(html); $("script,style,noscript,svg").remove();
    const root = options.selector ? $(options.selector) : $("body");
    const text = root.text().replace(/\s+/g, " ").trim().slice(0, options.maxChars ?? 100_000);
    const links = root.find("a[href]").map((_, el) => {
      try { return { text: $(el).text().replace(/\s+/g, " ").trim(), url: new URL($(el).attr("href")!, response.url).href }; }
      catch { return undefined; }
    }).get().filter(Boolean);
    return { url: response.url, title: $("title").text().trim(), text, links };
  }
  async screenshot(results: unknown, outputPath: string) { return renderTextScreenshot(JSON.stringify(results, null, 2), outputPath, "Web search results"); }
}
