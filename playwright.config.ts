import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    channel: process.env.PW_CHANNEL || undefined,
    acceptDownloads: true,
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173/health",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
