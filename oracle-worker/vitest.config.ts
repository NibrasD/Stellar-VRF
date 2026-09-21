import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run the TypeScript sources. Without this, vitest also picks up the
    // compiled copies under dist/ and reports every test twice.
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
