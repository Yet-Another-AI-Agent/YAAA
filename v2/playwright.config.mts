import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "storybook.screenshot.ts",
  snapshotPathTemplate: "{testDir}/storybook.screenshot.ts-snapshots/{arg}{ext}",
  use: { baseURL: "http://127.0.0.1:6006", colorScheme: "dark" },
  webServer: { command: "npm run storybook:v2 -- --ci", url: "http://127.0.0.1:6006", reuseExistingServer: true, timeout: 120_000 },
});
