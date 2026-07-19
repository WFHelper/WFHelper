import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // Retry the smoke test on CI: Electron cold-start can transiently exceed the
  // #app mount timeout on a loaded runner (flake, not a real failure). Local
  // runs keep retries at 0.
  retries: process.env.CI ? 2 : 0,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
});
