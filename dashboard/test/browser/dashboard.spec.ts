import { test as base, expect, type Page } from "@playwright/test";

const test = base.extend<{ browserErrors: void }>({
  browserErrors: [async ({page}, use) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("requestfailed", request => errors.push(`Request failed: ${request.url()}`));
    page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()}: ${response.url()}`); });
    await use();
    expect(errors, "No unexpected console, page or network errors").toEqual([]);
  }, {auto: true}]
});
async function open(page: Page, run?: string, view = "Overview") {
  await page.goto(run ? `/evidence?run=${run}&view=${view}` : "/evidence");
  await expect(page.locator('.dashboard[data-ready="true"]')).toBeVisible();
  if (view === "Performance") await expect(page.locator('[data-samples-ready="true"]')).toBeVisible();
}
async function metric(page: Page, id: string, value: string) { await expect(page.locator(`[data-metric="${id}"] strong`)).toHaveText(value); }

test("latest attempt is a failure, with unavailable counts, not the last pass", async ({page}) => {
  await open(page);
  await expect(page.getByRole("heading", {name: "maxwell-e2e-startup", exact: true})).toBeVisible();
  await expect(page.locator(".status-line .badge")).toHaveText("failed");
  await metric(page, "appliedEvents", "Unavailable");
  await expect(page.getByText("Failure: startup / Unavailable")).toBeVisible();
  await expect(page.getByText(/Report generated: 2026-09-28T23:30:00Z/)).toBeVisible();
});
test("selection, accurate counts, baseline pin, and safe evidence drill-down", async ({page, request}) => {
  await open(page, "maxwell-e2e-positive");
  for (const id of ["expectedEvents", "capturedEvents", "appliedEvents"]) await metric(page, id, "2");
  await metric(page, "dlqDeliveries", "0");
  await page.getByRole("button", {name: "Pin reviewed baseline", exact: true}).click();
  await page.goto("/evidence");
  await expect(page.getByRole("heading", {name: "maxwell-e2e-positive", exact: true})).toBeVisible();
  await page.getByRole("button", {name: "Recovery", exact: true}).click();
  const link = page.getByRole("link", {name: "Evidence maxwell-e2e-positive/source-rows.json", exact: true}).first();
  const popupPromise = page.waitForEvent("popup"); await link.click(); const popup = await popupPromise;
  await expect(popup.locator("body")).toContainText("<script>window.evidenceExecuted=true</script>");
  expect(await popup.evaluate(() => (window as unknown as {evidenceExecuted?: boolean}).evidenceExecuted)).toBeUndefined();
  expect((await request.get("/api/evidence?path=maxwell-e2e-positive/container-inspect.json")).status()).toBe(404);
  expect((await request.get("/api/evidence?path=../../package.json")).status()).toBe(404);
  await page.getByRole("button", {name: "Latest dated attempt"}).click();
  await expect(page.getByRole("heading", {name: "maxwell-e2e-startup", exact: true})).toBeVisible();
});
test("negative gate passes without hiding its failed assertion or raw exit", async ({page}) => {
  await open(page, "maxwell-e2e-negative", "Scenario");
  await expect(page.locator(".status-line .badge")).toHaveText("passed");
  await expect(page.getByText(/Expected failure verified/)).toBeVisible();
  await expect(page.getByText(/Raw host exit: 0; harness exit: 1/)).toBeVisible();
  await expect(page.getByRole("table", {name: "Assertions"})).toContainText("failed");
  await expect(page.getByText(/Failure:.*event-manifest/)).toBeVisible();
});
test("recovery distinguishes duplicate deliveries from expected quarantines", async ({page}) => {
  await open(page, "maxwell-phase4-fixture", "Recovery");
  const counts = page.getByRole("table", {name: "Event accounting"});
  for (const [label, value] of [["Expected events", "2"], ["Captured events", "2"], ["Applied events", "2"], ["DLQ deliveries", "3"], ["Unique quarantines", "2"], ["Expected quarantines", "2"]]) {
    await expect(counts.getByRole("row").filter({has: page.getByText(label, {exact: true})}).getByRole("cell").nth(1)).toHaveText(value);
  }
  await expect(page.locator(".sequence li")).toHaveCount(12);
  await expect(page.getByText(/Recorded order only/)).toBeVisible();
});
test("missing, corrupt, and suite evidence never become zero-valued successes", async ({page}) => {
  for (const [run, verdict] of [["maxwell-e2e-incomplete", "incomplete"], ["maxwell-e2e-corrupt", "unknown"], ["maxwell-phase5-suite-legacy", "passed"]]) {
    await open(page, run);
    await expect(page.locator(".status-line .badge")).toHaveText(verdict);
    await metric(page, "appliedEvents", "Unavailable");
  }
  await page.getByRole("button", {name: "Performance", exact: true}).click();
  await expect(page.getByText("Performance measurements unavailable for this run.")).toBeVisible();
});
test("performance values, units, sample charts, and comparison caveats", async ({page}) => {
  await open(page, "maxwell-phase5-workload-fixture", "Performance");
  const measurements = page.getByRole("table", {name: "Performance measurements"});
  for (const [id, value] of [["latencyP95Seconds", "1.8"], ["backlogRecoverySeconds", "2"], ["backlogEventsPerSecond", "0.5"]]) await expect(measurements.getByRole("row").filter({hasText: id}).getByRole("cell").nth(1)).toHaveText(value);
  await expect(page.getByRole("table", {name: "Observed processing rates"})).toContainText("events/second");
  await expect(page.getByText("2 latency samples; equal-width bins in seconds, final bin inclusive.")).toBeVisible();
  const memory = page.getByRole("table", {name: "Peak sampled memory"});
  await expect(memory.getByRole("row").filter({hasText: "consumer"})).toContainText("6");
  await expect(memory.getByRole("row").filter({hasText: "maxwell"})).toContainText("220");
  await expect(memory).toContainText("MiB");
  await page.getByRole("button", {name: "History", exact: true}).click();
  await page.getByLabel("Compare with", {exact: true}).selectOption("maxwell-e2e-positive");
  await expect(page.getByText(/configuration.*differs/)).toBeVisible();
  await expect(page.getByText(/Host environment is not fully recorded/)).toBeVisible();
  await expect(page.getByRole("table", {name: "Run comparison"})).toContainText("Unavailable");
});

test("linked suite references children without doubling their event counts", async ({page}) => {
  await open(page, "maxwell-phase5-suite-linked");
  await expect(page.locator(".status-line .badge")).toHaveText("passed");
  await metric(page, "expectedEvents", "Unavailable");
  await metric(page, "appliedEvents", "Unavailable");
  await page.getByRole("button", {name: "History", exact: true}).click();
  const members = page.locator('.view > .refs');
  await expect(members.getByRole("button")).toHaveCount(8);
  await members.getByRole("button", {name: "maxwell-phase4-linked", exact: true}).click();
  await expect(page.getByRole("heading", {name: "maxwell-phase4-linked", exact: true})).toBeVisible();
  await page.getByRole("button", {name: "Overview", exact: true}).click();
  await metric(page, "appliedEvents", "2");
});

for (const [view, run] of [["Overview", "maxwell-e2e-positive"], ["Scenario", "maxwell-e2e-negative"], ["Recovery", "maxwell-phase4-fixture"], ["Performance", "maxwell-phase5-workload-fixture"]]) {
  test(`visual ${view}`, async ({page}) => {
    await open(page, run, view);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page).toHaveScreenshot(`${view.toLowerCase()}.png`, {fullPage: true});
  });
}
