import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Parallel suites that each build the item database starve each other; a
    // 390ms build has been measured at 10s+ under that contention.
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
