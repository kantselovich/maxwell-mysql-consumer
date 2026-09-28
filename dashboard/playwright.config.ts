import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  workers: 2,
  retries: 0,
  updateSnapshots: "none", // Missing baselines fail too; only the explicit CLI update may write them.
  timeout: 30_000,
  expect: { toHaveScreenshot: { animations: "disabled", maxDiffPixels: 0 } },
  reporter: [["list"], ["html", {open: "never"}]],
  use: {baseURL: "http://127.0.0.1:4174", browserName: "chromium", locale: "en-US", timezoneId: "UTC", colorScheme: "light", reducedMotion: "reduce", trace: "retain-on-failure", screenshot: "only-on-failure"},
  projects: [
    {name: "desktop", use: {viewport: {width: 1440, height: 1000}, deviceScaleFactor: 1}},
    {name: "narrow", use: {viewport: {width: 390, height: 844}, deviceScaleFactor: 1}}
  ],
  webServer: {command: "node test/browser/fixture-server.ts", url: "http://127.0.0.1:4174/api/report", reuseExistingServer: false},
  snapshotPathTemplate: "{testDir}/snapshots/{projectName}/{arg}{ext}"
});
