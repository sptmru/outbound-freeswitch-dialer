import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "agent-desk-offers.spec.ts",
  fullyParallel: true,
  retries: 0,
  reporter: "list",
  outputDir: "/tmp/e03-browser-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4175",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "npx vite --config tests/fixtures/e03/vite.config.ts",
    url: "http://127.0.0.1:4175/tests/fixtures/e03/index.html",
    reuseExistingServer: false
  }
});
