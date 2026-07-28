import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../output/playwright/test-results",
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:4178",
    colorScheme: "dark",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 4178",
    url: "http://127.0.0.1:4178",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
