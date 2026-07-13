import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

export async function renderTextScreenshot(text: string, outputPath: string, title = "Agent tool output"): Promise<string> {
  const target = path.resolve(outputPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent("<title></title><style>body{margin:0;background:#111827;color:#e5e7eb;font:14px/1.5 ui-monospace,monospace}header{padding:14px 20px;background:#1f2937;font-weight:700}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:20px;margin:0}</style><header></header><pre></pre>");
    await page.locator("header").evaluate((el: any, value) => { el.textContent = value; }, title);
    await page.locator("pre").evaluate((el: any, value) => { el.textContent = value; }, text);
    await page.screenshot({ path: target, fullPage: true });
  } finally { await browser.close(); }
  return target;
}
