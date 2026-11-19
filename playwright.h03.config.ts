import { defineConfig } from "@playwright/test";
import offers from "./playwright.e03.config";
export default defineConfig({
  ...offers,
  testMatch: "inbound-history.spec.ts",
  outputDir: "./logs/h03-browser-results"
});
