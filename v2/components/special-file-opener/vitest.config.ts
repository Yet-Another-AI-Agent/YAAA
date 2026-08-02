import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node", include: ["**/*.test.tsx", "models/**/*.test.ts"], coverage: { provider: "v8", reporter: ["text", "json"], include: ["models/**/*.ts"] } } });
