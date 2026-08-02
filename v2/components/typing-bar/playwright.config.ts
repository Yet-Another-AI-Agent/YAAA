import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.screenshot.ts",
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:4175" },
  webServer: { command: "npx vite --config vite.config.mts --host 127.0.0.1", url: "http://127.0.0.1:4175", reuseExistingServer: true, timeout: 120_000 },
});
