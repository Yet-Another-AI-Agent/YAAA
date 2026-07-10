import { defineConfig } from "@playwright/test";

/**
 * Headless-browser E2E + visual-QA pipeline (blueprint Part VI). Drives the
 * real renderer in Chromium with a stubbed Electron bridge, verifies GUI
 * integrity (no raw UUIDs, Slack layout, log encapsulation), and captures
 * screenshots as CV evidence under e2e/artifacts/.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  retries: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev --workspace=apps/ui",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
