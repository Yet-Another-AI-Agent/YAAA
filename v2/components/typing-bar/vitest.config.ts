import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["library/**/*.test.ts", "models/**/*.test.ts", "utils/**/*.test.ts", "**/*.test.tsx"],
    coverage: { provider: "v8", reporter: ["text", "json"], include: ["library/**/*.ts", "models/**/*.ts", "utils/**/*.ts"], thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 } },
  },
});
