import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "ui.spec.mjs",
  outputDir: "../coverage/ui-test-results",
  use: { locale: "en-US" },
});
