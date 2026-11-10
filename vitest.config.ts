import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/browser/**"],
    testTimeout: 20000,
    hookTimeout: 20000,
    maxWorkers: 2,
  },
});
