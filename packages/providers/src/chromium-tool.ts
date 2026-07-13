import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

interface BrowserSession { browser: Browser; context: BrowserContext; page: Page; }
export class ChromiumTool {
  private sessions = new Map<string, BrowserSession>();
  async open(options: { id?: string; headless?: boolean; viewport?: { width: number; height: number }; userAgent?: string } = {}) {
    const id = options.id ?? crypto.randomUUID(); const browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext({ viewport: options.viewport, userAgent: options.userAgent }); const page = await context.newPage(); this.sessions.set(id, { browser, context, page }); return { id };
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
  async evaluate(id: string, expression: string) { return this.get(id).page.evaluate(expression); }
  async waitFor(id: string, selector: string, timeoutMs = 30_000) { await this.get(id).page.locator(selector).waitFor({ timeout: timeoutMs }); }
  async screenshot(id: string, outputPath: string, options: { fullPage?: boolean; selector?: string } = {}) { const target = path.resolve(outputPath); await fs.mkdir(path.dirname(target), { recursive: true }); const page = this.get(id).page; if (options.selector) await page.locator(options.selector).screenshot({ path: target }); else await page.screenshot({ path: target, fullPage: options.fullPage ?? false }); return target; }
  async close(id: string) { await this.get(id).browser.close(); this.sessions.delete(id); }
  list() { return [...this.sessions.keys()]; }
  private async preview(id: string) {
    try {
      const target = path.join(os.tmpdir(), "yaaa-tool-previews", `browser-${id}-${crypto.randomUUID()}.png`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await this.get(id).page.screenshot({ path: target, fullPage: false });
      return target;
    } catch {
      return undefined;
    }
  }
  private get(id: string) { const s = this.sessions.get(id); if (!s) throw new Error(`Unknown browser session: ${id}`); return s; }
}
