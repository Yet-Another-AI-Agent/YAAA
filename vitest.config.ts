import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "packages/**/*.test.ts",
        "packages/**/index.ts",
        "packages/shared/src/types.ts",
        "packages/interfaces/src/**/*.ts", // Interfaces have no executable code
      ],
    },
  },
});
