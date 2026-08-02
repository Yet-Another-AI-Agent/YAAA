import { expect, test } from "@playwright/test";

const stories = [
    ["file-opener", "v2-files-special-file-opener--presentation"],
  ["viewer", "v2-files-viewer--pdf-pages"],
  ["markdown", "v2-content-markdown-viewer--partial-document"],
  ["code-diff", "v2-code-viewer--diff"],
  ["commenter", "v2-content-markdown-commenter--review"],
    ["buttons", "v2-foundations-buttons--primary"],
  ["chat-shell", "v2-chat-shell--conversation"],
  ["bot-holder", "v2-chat-bot-holder--mission-team"],
  ["working-directory", "v2-right-panel-working-directory-card--agent-folders"],
  ["right-pane", "v2-right-panel-right-pane--workspace"],
  ["task-list", "v2-right-panel-task-list--nested-tasks"],
  ["side-panel", "v2-right-panel-side-panel--bot-details"],
  ["left-bar", "v2-navigation-left-bar--chat-navigation"],
  ["workspace-shell", "v2-workspace-workspace-shell--three-column-workspace"],
  ["splash-screen", "v2-loading-splash-screen--preparing"],
] as const;

for (const [name, storyId] of stories) {
  test(`v2 ${name} visual snapshot`, async ({ page }) => {
    await page.goto(`/iframe.html?id=${storyId}&viewMode=story`);
    await page.waitForTimeout(100);
    await expect(page).toHaveScreenshot(`v2-${name}.png`, { fullPage: true });
  });
}
