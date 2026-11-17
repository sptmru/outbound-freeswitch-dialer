import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "inbound-admin.spec.ts",
  fullyParallel: true,
  retries: 0,
  reporter: "list",
  outputDir: "/tmp/f05-browser-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4176",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "npx vite --config tests/fixtures/f05/vite.config.ts",
    url: "http://127.0.0.1:4176/tests/fixtures/f05/index.html",
    reuseExistingServer: false
  }
});
