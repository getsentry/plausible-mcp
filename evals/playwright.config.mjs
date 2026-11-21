import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "ui.spec.mjs",
  outputDir: "../coverage/ui-test-results",
  // A committed test.only would otherwise make CI run one test and pass.
  forbidOnly: !!process.env.CI,
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  use: { locale: "en-US" },
});
