import { defineConfig } from "@playwright/test";
import offers from "./playwright.e03.config";
export default defineConfig({
  ...offers,
  testMatch: "agent-desk-transfers.spec.ts",
  outputDir: "/tmp/g03-browser-results"
});
