import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  // This fixture needs its own Vite entry; it is outside the built preview.
  testIgnore: ["**/agent-desk-offers.spec.ts"],
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.WEB_E2E_URL ?? "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: process.env.WEB_E2E_URL
    ? undefined
    : {
        command: "npm --workspace @outbound-dialer/web run preview",
        url: "http://127.0.0.1:4173",
        reuseExistingServer: !process.env.CI
      }
});
