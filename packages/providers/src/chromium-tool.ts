import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

interface BrowserSession { browser: Browser; context: BrowserContext; page: Page; detached: boolean; consoleErrors: string[]; networkFailures: string[]; sequence: number; workspaceDir?: string; agentId?: string; }
export class ChromiumTool {
  private sessions = new Map<string, BrowserSession>();
  constructor(private readonly workspaceDir?: string) {}
  async open(options: { id?: string; agentId?: string; headless?: boolean; viewport?: { width: number; height: number }; userAgent?: string } = {}) {
    const id = options.id ?? crypto.randomUUID(); const browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext({ viewport: options.viewport, userAgent: options.userAgent }); const page = await context.newPage();
    const session: BrowserSession = { browser, context, page, detached: false, consoleErrors: [], networkFailures: [], sequence: 0, workspaceDir: this.workspaceDir, agentId: options.agentId };
    page.on("console", (message) => { if (message.type() === "error") session.consoleErrors.push(message.text()); });
    page.on("requestfailed", (request) => { session.networkFailures.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "failed"}`); });
    this.sessions.set(id, session); return { id };
  }
  async navigate(id: string, url: string, timeoutMs = 30_000) { const session = this.get(id); const response = await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs }); return { url: session.page.url(), title: await session.page.title(), status: response?.status(), screenshotPath: await this.preview(id) }; }
  async click(id: string, selector: string) { await this.get(id).page.locator(selector).click(); return { clicked: selector, screenshotPath: await this.preview(id) }; }
  async type(id: string, selector: string, text: string, options: { clear?: boolean; submit?: boolean } = {}) { const loc = this.get(id).page.locator(selector); if (options.clear) await loc.fill(""); await loc.pressSequentially(text); if (options.submit) await loc.press("Enter"); return { selector, submitted: Boolean(options.submit), screenshotPath: await this.preview(id) }; }
  async fill(id: string, values: Record<string, string | boolean>) { for (const [selector, value] of Object.entries(values)) { const loc = this.get(id).page.locator(selector); if (typeof value === "boolean") await loc.setChecked(value); else await loc.fill(value); } return { filled: Object.keys(values), screenshotPath: await this.preview(id) }; }
  async select(id: string, selector: string, values: string | string[]) { const selected = await this.get(id).page.locator(selector).selectOption(values); return { selected, screenshotPath: await this.preview(id) }; }
  async press(id: string, selector: string, key: string) { await this.get(id).page.locator(selector).press(key); return { selector, key, screenshotPath: await this.preview(id) }; }
  async hover(id: string, selector: string) { await this.get(id).page.locator(selector).hover(); return { selector, screenshotPath: await this.preview(id) }; }
  async reload(id: string) { await this.get(id).page.reload({ waitUntil: "domcontentloaded" }); return { url: this.get(id).page.url(), title: await this.get(id).page.title(), screenshotPath: await this.preview(id) }; }
  async back(id: string) { await this.get(id).page.goBack({ waitUntil: "domcontentloaded" }); return { url: this.get(id).page.url(), title: await this.get(id).page.title(), screenshotPath: await this.preview(id) }; }
  async forward(id: string) { await this.get(id).page.goForward({ waitUntil: "domcontentloaded" }); return { url: this.get(id).page.url(), title: await this.get(id).page.title(), screenshotPath: await this.preview(id) }; }
  async content(id: string, selector = "body") { const loc = this.get(id).page.locator(selector); return { text: await loc.innerText(), html: await loc.innerHTML() }; }
  async observe(id: string) {
    const session = this.get(id);
    const text = await session.page.locator("body").innerText().catch(() => "");
    const controls = await session.page.locator("button, a, [role=button], input[type=submit], input[type=button]").evaluateAll((elements) =>
      elements.slice(0, 80).map((element, index) => {
        const node = element as any;
        const escapeSelector = (value: string) => value.replace(/([\\"'\[\]#.:])/g, "\\$1");
        const label = node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent?.replace(/\s+/g, " ").trim() || "";
        const id = node.id;
        const selector = id
          ? `#${escapeSelector(id)}`
          : node.getAttribute("data-testid")
            ? `[data-testid=\"${escapeSelector(node.getAttribute("data-testid"))}\"]`
            : `${node.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
        return {
          selector,
          tag: node.tagName.toLowerCase(),
          label: label.slice(0, 160),
          href: node.tagName.toLowerCase() === "a" ? node.href : undefined,
        };
      }),
    ).catch(() => []);
    const assetUrls = await session.page.locator("img[src], source[src], a[href]").evaluateAll((elements) => {
      const urls = elements.map((element) => {
        const node = element as any;
        const raw = node.src || node.href;
        return raw || "";
      }).filter((url) => /^https?:\/\//i.test(url) && /\.(?:png|jpe?g|webp|gif|svg|pdf)(?:[?#].*)?$/i.test(url));
      return [...new Set(urls)].slice(0, 80);
    }).catch(() => []);
    return {
      id,
      url: session.page.url(),
      title: await session.page.title().catch(() => ""),
      visibleText: text.slice(0, 12_000),
      controls,
      assetUrls,
      consoleErrors: session.consoleErrors.slice(-20),
      networkFailures: session.networkFailures.slice(-20),
      screenshotPath: await this.preview(id),
      readyState: await session.page.evaluate(() => (globalThis as any).document?.readyState ?? "unknown").catch(() => "unknown"),
      detached: session.detached,
    };
  }
  attachBrowser(id: string) { const session = this.get(id); session.detached = false; return { id, attached: true, url: session.page.url() }; }
  detachBrowser(id: string) { const session = this.get(id); session.detached = true; return { id, detached: true, url: session.page.url() }; }
  async captureBrowserScreenshot(id: string, outputPath: string) { return this.screenshot(id, outputPath); }
  async evaluate(id: string, expression: string) { return this.get(id).page.evaluate(expression); }
  async waitFor(id: string, selector: string, timeoutMs = 30_000) { await this.get(id).page.locator(selector).waitFor({ timeout: timeoutMs }); }
  async screenshot(id: string, outputPath: string, options: { fullPage?: boolean; selector?: string } = {}) { const target = path.resolve(outputPath); await fs.mkdir(path.dirname(target), { recursive: true }); const page = this.get(id).page; if (options.selector) await page.locator(options.selector).screenshot({ path: target }); else await page.screenshot({ path: target, fullPage: options.fullPage ?? false }); return target; }
  async close(id: string) { await this.get(id).browser.close(); this.sessions.delete(id); }
  list() { return [...this.sessions].map(([id, session]) => ({ id, detached: session.detached, url: session.page.url() })); }
  private async preview(id: string) {
    try {
      const session = this.get(id);
      session.sequence += 1;
      const target = session.workspaceDir
        ? path.join(session.workspaceDir, "agent-workspaces", session.agentId ?? "unknown-agent", "logs", "browser", id, `${session.sequence}.png`)
        : path.join(os.tmpdir(), "yaaa-tool-previews", `browser-${id}-${crypto.randomUUID()}.png`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await this.get(id).page.screenshot({ path: target, fullPage: false });
      return target;
    } catch {
      return undefined;
    }
  }
  private get(id: string) { const s = this.sessions.get(id); if (!s) throw new Error(`Unknown browser session: ${id}`); return s; }
}
