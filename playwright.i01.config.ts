import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "inbound-integrated.spec.mts",
  workers: 1,
  retries: 0,
  timeout: 45_000,
  outputDir: process.env.I01_BROWSER_ARTIFACTS ?? "./logs/i01-browser-results",
  use: {
    ...devices["Desktop Chrome"],
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  }
});
