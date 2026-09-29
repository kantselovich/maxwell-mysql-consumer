import {test, expect} from "@playwright/test";
import {execFile} from "node:child_process";
import {promisify, stripVTControlCharacters} from "node:util";
import {mkdtemp, mkdir, readFile, writeFile, rm, readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import type {Server} from "node:http";
import {staticViewer} from "../../viewer/static.ts";

const exec = promisify(execFile);
test("npm build packages Observable pages and selected results for GitHub project Pages", async ({page, request}) => {
  test.setTimeout(120_000);
  const workspace = await mkdtemp(join(tmpdir(), "dashboard-npm-build-")), artifacts = join(workspace, "artifacts");
  await mkdir(artifacts);
  let server:Server|undefined;
  const selected = ["maxwell-e2e-positive", "maxwell-phase4-fixture", "maxwell-phase5-malformed-fixture", "maxwell-phase5-unsupported-fixture", "maxwell-phase5-workload-fixture"];
  const errors:string[] = [], requests:string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("requestfailed", req => errors.push(req.url()));
  page.on("response", res => { if (res.status() >= 400) errors.push(`${res.status()} ${res.url()}`); });
  page.on("request", req => requests.push(req.url()));
  async function commands(expected:string[]) {
    const section = page.getByRole("region", {name:"Run this test"});
    await expect(section).toBeVisible();
    expect((await section.locator("pre code").innerText()).split("\n").filter(line => line.startsWith("make "))).toEqual(expected);
    await expect(section).toContainText("Run these commands locally from a clone of the repository with Docker running.");
    await expect(section).not.toContainText("new results appear automatically");
    expect(await section.evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector(".run-controls")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  }
  try {
    const fixtures = JSON.parse(await readFile("test/fixtures/runs.json", "utf8"));
    for (const id of [...selected, "maxwell-e2e-startup"]) {
      const fixture = fixtures.find((f:{directory:string}) => f.directory === id), directory = join(artifacts, id);
      await mkdir(directory);
      for (const [name, value] of Object.entries(fixture.files)) await writeFile(join(directory, name), JSON.stringify(value));
      await writeFile(join(directory,"compose.log"), "PRIVATE_BUILD_INPUT");
    }
    const load = join(artifacts, "maxwell-phase5-workload-fixture");
    await writeFile(join(load,"memory-samples.log"), '2026-09-28T11:00:00Z\n{"Name":"private-consumer-1","MemUsage":"6MiB / 8GiB"}\n{"Name":"private-maxwell-1","MemUsage":"220MiB / 8GiB"}\n');
    await writeFile(join(load,"latency-samples-seconds.json"), "[1,1.8]");
    // Framework must clear previously published runs when rebuilding dist.
    await mkdir("dist/evidence/stale-run", {recursive:true});
    await writeFile("dist/evidence/stale-run/checks.json", "PRIVATE_BUILD_INPUT");
    const build = await exec("npm", ["run", "snapshot"], {env:{...process.env, ARTIFACT_ROOT:artifacts, RUN_IDS:selected.join(",")}, maxBuffer:8*1024*1024});
    expect(stripVTControlCharacters(build.stdout)).toContain("built 4 pages");
    expect(await readFile("dist/.nojekyll", "utf8")).toBe("");
    expect((await readdir("dist/evidence")).sort()).toEqual([...selected].sort());
    const manifest = JSON.parse(await readFile("dist/snapshot.json", "utf8"));
    expect(manifest.runIds).toEqual(selected);
    async function inspect(directory:string) {
      for (const entry of await readdir(directory, {withFileTypes:true})) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await inspect(path);
        else expect(await readFile(path, "utf8")).not.toContain("PRIVATE_BUILD_INPUT");
      }
    }
    await inspect("dist");
    await rm(artifacts, {recursive:true}); // Published site has no local evidence to fall back on.
    // Fresh clones use the saved snapshot; CI selects it explicitly. Both
    // preserve all selected Phase 5 runs and the original capture timestamp.
    for (const env of [{...process.env}, {...process.env, SNAPSHOT_ROOT:"published"}]) {
      await exec("npm", ["run", "build"], {env, maxBuffer:8*1024*1024});
      expect(JSON.parse(await readFile("dist/snapshot.json","utf8"))).toEqual(manifest);
      expect((await readdir("dist/evidence")).sort()).toEqual([...selected].sort());
    }
    await inspect("dist");
    server = staticViewer(resolve("dist"), "/maxwell-mysql-consumer/");
    await new Promise<void>(done => server!.listen(0,"127.0.0.1",done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No server");
    const origin = `http://127.0.0.1:${address.port}`, base = origin + "/maxwell-mysql-consumer/";
    await page.goto(base.slice(0,-1)); // Directory redirect preserves the requested repository path.
    await expect(page).toHaveURL(base);
    await expect(page.locator('.narrative[data-ready="true"]')).toBeVisible();
    await expect(page.getByRole("img", {name:/POC architecture/})).toBeVisible();
    expect(await page.locator(".story-nav").evaluate(node => getComputedStyle(node).display)).toBe("flex");
    const nav = page.getByRole("navigation", {name:"POC pages"});
    await nav.getByRole("link", {name:"Basic replication",exact:true}).click();
    await expect(page).toHaveURL(new RegExp("/maxwell-mysql-consumer/basics\\.html"));
    await expect(page.getByLabel("Test run", {exact:true})).toHaveValue(selected[0]);
    await commands(["make test-basic-replication"]);
    await expect(page.locator(".run-result .badge")).toHaveText("passed");
    await expect(page.locator(".dlq-card")).toContainText("0");
    const checksURL = await page.getByRole("link", {name:"Exported checks"}).first().evaluate((a:HTMLAnchorElement) => a.href);
    expect(checksURL.startsWith(base + "evidence/")).toBe(true);
    expect((await (await request.get(checksURL)).json()).counts.appliedEvents.value).toBe(2);
    await nav.getByRole("link", {name:"Recovery",exact:true}).click();
    await expect(page.getByLabel("Test run", {exact:true})).toHaveValue(selected[1]);
    await commands(["make test-recovery"]);
    await expect(page.locator(".dlq-card")).toContainText("3");
    // Direct URLs, query parameters and reload work without a routing server.
    await page.goto(base + "failures.html?run=" + selected[4]);
    await page.reload();
    await expect(page.getByLabel("Test run", {exact:true})).toHaveValue(selected[4]);
    await commands(["make test-invalid-json", "make test-unsupported-schema", "make test-load"]);
    await expect(page.locator('[data-service="consumer"]')).toContainText("6 MiB");
    await expect(page.locator('[data-service="maxwell"]')).toContainText("220 MiB");
    await expect(page.getByRole("img", {name:/End-to-end latency distribution/})).toBeVisible();
    for (const id of selected.slice(2,4)) {
      await page.getByLabel("Test run", {exact:true}).selectOption(id);
      await expect(page.locator(".run-result .badge")).toHaveText("passed");
    }
    await expect(page.getByLabel("Follow latest")).toHaveCount(0);
    await expect(page.locator(".compose-configuration")).toHaveCount(0);
    await nav.getByRole("link", {name:"Introduction",exact:true}).click();
    await expect(page).toHaveURL(base);
    await expect(page.locator('.narrative[data-ready="true"]')).toBeVisible();
    expect(requests.every(url => url === base.slice(0,-1) || url.startsWith(base))).toBe(true);
    expect(requests.some(url => url.includes("/api/"))).toBe(false);
    for (const path of ["/data/report.json", "/api/report", "/maxwell-mysql-consumer/api/report", "/maxwell-mysql-consumer/compose.yaml"]) expect((await request.get(origin+path)).status()).toBe(404);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    if (server) await new Promise<void>((done,fail) => { server!.close(error => error ? fail(error) : done()); server!.closeAllConnections(); });
    await rm(workspace, {recursive:true,force:true});
  }
});
