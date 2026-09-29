import {test as base, expect, type Page} from "@playwright/test";
const test = base.extend<{errors: void}>({errors: [async ({page}, use) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => {if (m.type() === "error") errors.push(m.text());});
  page.on("requestfailed", r => errors.push(r.url()));
  page.on("response", r => {if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);});
  await use(); expect(errors).toEqual([]);
}, {auto: true}]});
async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('.narrative[data-ready="true"]')).toBeVisible();
}
const dlq = (page: Page) => page.locator('[data-component="dlq"]');
async function dlqCount(page: Page, label: string, expected: string) {
  await expect(dlq(page).locator(".node-stat").filter({has: page.getByText(label, {exact: true})}).locator("strong")).toHaveText(expected);
}
test("introduction explains the experiment and includes harness, evidence and DLQ in Mermaid", async ({page}) => {
  await open(page, "/");
  await expect(page.getByRole("heading", {name: "MySQL Third-Party Replication POC", exact: true})).toBeVisible();
  await expect(page.locator("#architecture-diagram svg")).toBeVisible();
  await expect(page.locator("#architecture-diagram")).toContainText("Pub/Sub dead-letter queue - DLQ");
  await expect(page.locator("#architecture-diagram")).toContainText("Failure diagnostics");
  // SVG line wrapping splits labels across tspans; compare their joined text.
  const diagramText = (await page.locator("#architecture-diagram svg").textContent())!.replace(/\s/g, "");
  for (const label of ["Swift test harness - e2e container", "Writes source / checks target", "Audit events / DLQ diagnostics", "Saves results", "artifacts/"]) expect(diagramText).toContain(label.replace(/\s/g, ""));
  await expect(page.locator('a[href^="/evidence"]')).toHaveCount(0);
  await expect(page.getByRole("heading", {name: "How the POC is tested"})).toBeVisible();
  await expect(page.getByText(/Maxwell's daemon.*is a background process/)).toBeVisible();
  await expect(page.getByText(/Google Cloud Pub\/Sub.*is a messaging service/)).toBeVisible();
  await expect(page.getByText(/Publishers send messages to a topic, and subscribers receive them through subscriptions/)).toBeVisible();
  await expect(page.getByRole("heading", {name: /Next steps?/i})).toHaveCount(0);
  await expect(page.locator('[id="next-step"], a[href*="next-step"]')).toHaveCount(0);
  await expect(page.getByRole("heading", {name: "What this POC can establish"})).toHaveCount(0);
  await expect(page.getByText("From source to proof.", {exact: true})).toHaveCount(0);
  await page.locator(".test-chapters").getByRole("link", {name: /Basic replication/}).click();
  await expect(page.getByRole("heading", {name: "Basic replication", exact: true})).toBeVisible();
});
test("test pages omit Git housekeeping and repeated coverage while retaining results", async ({page, request}) => {
  const report = await (await request.get("/api/report")).json();
  const original = report.runs.find((run: {id: string}) => run.id === "maxwell-e2e-positive");
  expect(original.code.value.dirty).toBe(true);
  expect(original.limitations.join(" ")).toContain("uncommitted diff");
  for (const path of ["/basics?run=maxwell-e2e-positive", "/recovery?run=maxwell-phase4-fixture", "/failures?run=maxwell-phase5-workload-fixture"]) {
    await open(page, path);
    // textContent also checks the text inside closed disclosures.
    const text = await page.locator(".narrative").textContent();
    expect(text).not.toMatch(/uncommitted diff|dirty worktree|code revision|base commit|1111111111111111111111111111111111111111/i);
    await expect(page.getByText("Run details and limitations", {exact: true})).toHaveCount(0);
    await expect(page.getByRole("heading", {name: "Test coverage", exact: true})).toHaveCount(0);
    await expect(page.locator('a[href*="next-step"]')).toHaveCount(0);
    await expect(page.getByRole("table", {name: "Recorded result counts"})).toBeVisible();
    await expect(dlq(page)).toBeVisible();
  }
});
test("latest run is phase-scoped, failed attempts stay visible, and missing DLQ is not zero", async ({page}) => {
  await open(page, "/basics");
  await expect(page.getByLabel("Test run", {exact: true})).toHaveValue("maxwell-e2e-startup");
  await expect(page.locator(".run-result .badge")).toHaveText("failed");
  await dlqCount(page, "DLQ deliveries", "Not recorded");
  await expect(page.getByLabel("Test run").locator("option").filter({hasText: "maxwell-phase4"})).toHaveCount(0);
  await page.getByLabel("Test run").selectOption("maxwell-e2e-positive");
  await expect(page.locator('.narrative[data-ready="true"]')).toBeVisible();
  await dlqCount(page, "DLQ deliveries", "0");
  await page.getByRole("button", {name: "Pin this run", exact: true}).click();
  await open(page, "/basics");
  await expect(page.getByLabel("Test run")).toHaveValue("maxwell-e2e-positive");
  await page.getByRole("link", {name: "Next: Recovery →"}).click();
  await expect(page.getByLabel("Test run")).toHaveValue("maxwell-phase4-fixture");
});
test("component counts, container details, service logs and source links use safe evidence", async ({page, request}) => {
  await open(page, "/basics?run=maxwell-e2e-positive");
  await expect(page.locator(".event-breakdown")).toContainText("Observed audit payloads");
  for (const label of ["Row-change events", "Schema-change events"]) await expect(page.locator(".event-breakdown .node-stat").filter({hasText: label}).locator("strong")).toHaveText("1");
  const consumer = page.locator('[data-service="consumer"]');
  await consumer.getByText("Container details", {exact: true}).click();
  await expect(consumer).toContainText("fixture/consumer:1");
  const log = await request.get((await consumer.getByRole("link", {name: "Service log"}).getAttribute("href"))!);
  expect(await log.text()).toBe("consumer-1 | applied event a");
  expect(log.headers()["content-type"]).toContain("text/plain");
  expect(await (await request.get("/api/report")).text()).not.toContain("never-publish");
  expect((await request.get("/api/evidence?path=maxwell-e2e-positive/consumer-container.json")).status()).toBe(404);
  expect((await request.get("/api/source?path=.env")).status()).toBe(404);
  await page.getByText("Test script and harness code", {exact: true}).click();
  for (const a of await page.locator('a[href^="/api/source"]').all()) expect((await request.get((await a.getAttribute("href"))!)).status()).toBe(200);
  await expect(page.locator('[data-service="mysql57"]')).toContainText("cdc_meta");
  await expect(page.locator('[data-service="mysql57"]')).toContainText("poc.records");
  await expect(page.locator(".harness-strip")).toContainText("artifacts/maxwell-e2e-positive/");
});
test("recovery and poison runs show nonzero DLQ without conflating deliveries and failures", async ({page}) => {
  await open(page, "/recovery?run=maxwell-phase4-fixture");
  await dlqCount(page, "DLQ deliveries", "3"); await dlqCount(page, "Unique failures", "2"); await dlqCount(page, "Expected failures", "2");
  await expect(page.getByText(/final emulator-loss check confirmed/)).toBeVisible();
  await open(page, "/failures?run=maxwell-phase5-malformed-fixture");
  await dlqCount(page, "DLQ deliveries", "1"); await dlqCount(page, "Unique failures", "1");
  await expect(page.getByText(/Applying that event requires a repair/)).toBeVisible();
  await expect(page.getByLabel("Test run").locator("option").filter({hasText: "suite"})).toHaveCount(0);
});
for (const [path, commands] of [["/basics", ["make e2e", "make e2e-checks"]], ["/recovery", ["make phase4"]], ["/failures", ["bash scripts/phase5.sh malformed", "bash scripts/phase5.sh unsupported", "make e2e-load"]]] as const) {
  test(`${path} provides rerun commands before run selection`, async ({page}) => {
    await open(page, path);
    const block = page.locator(".run-command pre code");
    for (const command of commands) await expect(block).toContainText(command);
    expect(await block.evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector('.run-controls')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await expect(page.locator(".run-command")).toContainText("make dashboard-data");
    await expect(page.locator('a[href^="/evidence"]')).toHaveCount(0);
  });
}
test("counts and negative-test assertions remain available on the test page", async ({page}) => {
  await open(page, "/basics?run=maxwell-e2e-positive");
  const counts = page.getByRole("table", {name: "Recorded result counts"});
  for (const label of ["Expected events", "Captured unique events", "Applied events"]) await expect(counts.getByRole("row").filter({has: page.getByText(label, {exact: true})}).getByRole("cell").nth(1)).toHaveText("2");
  await open(page, "/basics?run=maxwell-e2e-negative");
  await expect(page.locator(".run-result .badge")).toHaveText("passed");
  await expect(page.getByText(/The verifier detected the deliberately introduced error/)).toBeVisible();
  await page.getByText("Recorded assertions and raw exit codes", {exact: true}).click();
  await expect(page.getByText(/Host exit: 0; harness exit: 1; failure code: event-manifest/)).toBeVisible();
  await expect(page.getByRole("table", {name: "Recorded assertions", exact: true})).toContainText("failed");
});
test("missing and corrupt results stay distinct from success", async ({page}) => {
  for (const [id, verdict] of [["maxwell-e2e-incomplete", "incomplete"], ["maxwell-e2e-corrupt", "unknown"]]) {
    await open(page, `/basics?run=${id}`);
    await expect(page.locator(".run-result .badge")).toHaveText(verdict);
    const row = page.getByRole("table", {name: "Recorded result counts"}).getByRole("row").filter({has: page.getByText("Applied events", {exact: true})});
    await expect(row.getByRole("cell").nth(1)).toHaveText("Not recorded");
  }
});
test("load memory is only Maxwell and consumer, latency is end-to-end, DLQ is zero", async ({page}) => {
  await open(page, "/failures?run=maxwell-phase5-workload-fixture");
  await dlqCount(page, "DLQ deliveries", "0");
  await expect(page.locator('[data-service="maxwell"]')).toContainText("220 MiB");
  await expect(page.locator('[data-service="consumer"]')).toContainText("6 MiB");
  for (const service of ["mysql84", "mysql57", "pubsub"]) await expect(page.locator(`[data-service="${service}"]`)).not.toContainText("memory");
  await expect(page.locator(".timing-strip")).toContainText("95th percentile latency: 1.8 seconds");
  await expect(page.getByText("2 recorded samples; ranges are seconds. The final range includes its upper boundary.")).toBeVisible();
});
for (const [name, path] of [["introduction", "/"], ["basics", "/basics?run=maxwell-e2e-positive"], ["recovery-story", "/recovery?run=maxwell-phase4-fixture"], ["failure-story", "/failures?run=maxwell-phase5-workload-fixture"]]) {
  test(`visual ${name}`, async ({page}) => {
    await open(page, path); await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page).toHaveScreenshot(`${name}.png`, {fullPage: true});
  });
}
