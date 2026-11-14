import { test as base, expect } from "@playwright/test";

// Anonymous UI harness: no network/API/provider dependency. Authenticated journeys
// install their own stateful routes or use an explicitly isolated real API.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (["/api/auth/me", "/api/agent/desk"].includes(path)) {
        await route.fulfill({ status: 401, json: { message: "Authentication required" } });
      } else {
        await route.abort("blockedbyclient");
      }
    });
    await use(page);
  }
});
export { expect };
