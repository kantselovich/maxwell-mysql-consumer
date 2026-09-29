import {test, expect} from "@playwright/test";
import {mkdtemp, mkdir, readFile, writeFile, rm, rename} from "node:fs/promises";
import {join, resolve} from "node:path";
import {tmpdir} from "node:os";
import type {Server} from "node:http";
import {watchArtifacts} from "../../reporting/watch.ts";
import {viewer} from "../../viewer/server.ts";
import {staticViewer} from "../../viewer/static.ts";
import {importArtifacts} from "../../reporting/importer.ts";
import {exportSnapshot} from "../../reporting/export.ts";

async function listen(server:Server) {
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const address=server.address(); if (!address || typeof address === "string") throw new Error("Server unavailable");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server:Server) { await new Promise<void>((resolve,reject) => {server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();}); }
async function fixture(root:string, template:string, id:string, hour:number) {
  const fixtures=JSON.parse(await readFile("test/fixtures/runs.json","utf8")), chosen=fixtures.find((f:{directory:string})=>f.directory===template);
  const directory=join(root,id); await mkdir(directory);
  for (const [name,content] of Object.entries(chosen.files)) await writeFile(join(directory,name),JSON.stringify(content));
  await writeFile(join(directory,"run-metadata.json"),JSON.stringify({schemaVersion:1,runId:id,phase:chosen.expected.phase,kind:"run",state:"finished",startedAt:`2026-09-28T${hour}:00:00Z`,finishedAt:`2026-09-28T${hour}:01:00Z`}));
}
test("watcher refreshes runs without reload, follows newer failures and preserves historical selection", async ({page}) => {
  test.setTimeout(60_000);
  const workspace=await mkdtemp(join(tmpdir(),"browser-refresh-")), artifacts=join(workspace,"artifacts"), report=join(workspace,"report.json"), status=join(workspace,"status.json");
  await mkdir(artifacts);
  await fixture(artifacts,"maxwell-e2e-positive","maxwell-e2e-first",10);
  const watcher=await watchArtifacts({root:artifacts,output:report,status,intervalMs:100,debounceMs:100,maxWaitMs:500});
  const server=viewer({artifacts,report,watchStatus:status,site:resolve(".generated/site"),repository:resolve("..")});
  const errors:string[]=[]; page.on("pageerror",error=>errors.push(error.message));
  try {
    await page.goto(`${await listen(server)}/basics`);
    await expect(page.getByLabel("Test run",{exact:true})).toHaveValue("maxwell-e2e-first");
    await expect(page.getByLabel("Follow latest",{exact:true})).toBeChecked();
    await page.evaluate(() => { (window as unknown as {samePage:boolean}).samePage=true; });
    await fixture(artifacts,"maxwell-e2e-negative","maxwell-e2e-negative-new",11);
    await expect(page.getByLabel("Test run",{exact:true})).toHaveValue("maxwell-e2e-negative-new",{timeout:15_000});
    await expect(page.locator(".run-result .badge")).toHaveText("passed");
    await expect(page.getByText(/The verifier detected the deliberately introduced error/)).toBeVisible();
    await page.getByLabel("Test run",{exact:true}).selectOption("maxwell-e2e-first");
    await expect(page.getByLabel("Follow latest",{exact:true})).not.toBeChecked();
    await fixture(artifacts,"maxwell-e2e-startup","maxwell-e2e-failed-new",12);
    await expect(page.getByLabel("Test run",{exact:true}).locator('option[value="maxwell-e2e-failed-new"]')).toHaveCount(1,{timeout:15_000});
    await expect(page.getByLabel("Test run",{exact:true})).toHaveValue("maxwell-e2e-first");
    await page.getByLabel("Follow latest",{exact:true}).check();
    await expect(page.getByLabel("Test run",{exact:true})).toHaveValue("maxwell-e2e-failed-new");
    await expect(page.locator(".run-result .badge")).toHaveText("failed");
    const interrupted=join(artifacts,"maxwell-e2e-interrupted-new"); await mkdir(interrupted);
    await writeFile(join(interrupted,"run-metadata.json"),JSON.stringify({schemaVersion:1,runId:"maxwell-e2e-interrupted-new",phase:3,kind:"run",state:"started",startedAt:"2026-09-28T13:00:00Z"}));
    await expect(page.getByLabel("Test run",{exact:true})).toHaveValue("maxwell-e2e-interrupted-new",{timeout:15_000});
    await expect(page.locator(".run-result .badge")).not.toHaveText(/passed|running/);
    await writeFile(join(interrupted,"host-result.json"),'{"phase":3,"exitCode":143,"harnessExitCode":-1}');
    await expect(page.locator(".run-result .badge")).toHaveText("failed",{timeout:15_000});
    expect(await page.evaluate(() => (window as unknown as {samePage:boolean}).samePage)).toBe(true);
    await rename(artifacts,join(workspace,"offline"));
    await expect(page.getByRole("status")).toContainText("Reporting refresh failed",{timeout:15_000});
    await expect(page.locator(".run-result .badge")).toHaveText("failed");
    await rename(join(workspace,"offline"),artifacts);
    await expect(page.getByRole("status")).toContainText("Automatic refresh active",{timeout:15_000});
    expect(errors).toEqual([]);
  } finally {await page.close(); await watcher.close(); await close(server); await rm(workspace,{recursive:true,force:true});}
});
test("static snapshot works separately with exported checks and numeric charts", async ({page, request}) => {
  const workspace=await mkdtemp(join(tmpdir(),"browser-static-")), artifacts=join(workspace,"artifacts"); await mkdir(artifacts);
  let server:Server|undefined;
  const errors:string[]=[]; page.on("pageerror",error=>errors.push(error.message)); page.on("requestfailed",r=>errors.push(r.url())); page.on("response",r=>{if(r.status()>=400)errors.push(r.url());});
  try {
    await fixture(artifacts,"maxwell-e2e-positive","maxwell-e2e-static",10);
    await fixture(artifacts,"maxwell-phase5-workload-fixture","maxwell-phase5-static",11);
    const load=join(artifacts,"maxwell-phase5-static");
    await writeFile(join(load,"memory-samples.log"),'2026-09-28T11:00:00Z\n{"Name":"private-consumer-1","MemUsage":"6MiB / 8GiB"}\n{"Name":"private-maxwell-1","MemUsage":"220MiB / 8GiB"}\n');
    await writeFile(join(load,"latency-samples-seconds.json"),'[1,1.8]');
    const report=await importArtifacts(artifacts,"2026-09-28T23:30:00Z");
    const output=await exportSnapshot({report,artifacts,site:resolve(".generated/site"),output:join(workspace,"exports"),generatedAt:"2026-09-28T23:30:00Z",runIds:["maxwell-e2e-static","maxwell-phase5-static"]});
    await rm(artifacts,{recursive:true}); // The only remaining inputs are static files.
    server=staticViewer(output); const url=await listen(server);
    await page.goto(url);
    await expect(page.locator('.narrative[data-ready="true"]')).toBeVisible();
    await expect(page.getByText(/Snapshot generated 2026-09-28T23:30:00Z/)).toBeVisible();
    await page.locator(".test-chapters").getByRole("link",{name:/Basic replication/}).click();
    await expect(page.getByLabel("Test run",{exact:true})).toHaveValue("maxwell-e2e-static");
    await expect(page.locator(".run-result .badge")).toHaveText("passed");
    await expect(page.getByRole("table",{name:"Recorded result counts"})).toContainText("2");
    await expect(page.getByLabel("Follow latest")).toHaveCount(0);
    await expect(page.locator('a[href^="/api/"]')).toHaveCount(0);
    const evidence=page.getByRole("link",{name:"Exported checks"}).first();
    const checks=await request.get(url + (await evidence.getAttribute("href"))!); expect(checks.status()).toBe(200);
    expect((await checks.json()).counts.appliedEvents.value).toBe(2);
    await page.getByRole("link",{name:"Failure handling and load",exact:true}).click();
    await expect(page.locator('[data-service="consumer"]')).toContainText("6 MiB");
    await expect(page.locator('[data-service="maxwell"]')).toContainText("220 MiB");
    await expect(page.getByRole("img",{name:/End-to-end latency distribution/})).toBeVisible();
    await expect(page.getByText("Local evidence",{exact:true}).first()).toBeVisible();
    const manifest=await (await request.get(url + "/snapshot.json")).json(); expect(manifest.runIds).toEqual(["maxwell-e2e-static","maxwell-phase5-static"]);
    for (const path of ["/api/report","/api/evidence?path=private","/evidence/maxwell-e2e-static/compose.log"]) expect((await request.get(url+path)).status()).toBe(404);
    expect(errors).toEqual([]);
  } finally {await page.close(); if(server) await close(server); await rm(workspace,{recursive:true,force:true});}
});
test("an empty workspace discovers its first passing run and refreshes changed row captures", async ({page}) => {
  const workspace=await mkdtemp(join(tmpdir(),"browser-first-run-")), artifacts=join(workspace,"artifacts"), report=join(workspace,"report.json"), status=join(workspace,"status.json");
  await mkdir(artifacts);
  const watcher=await watchArtifacts({root:artifacts,output:report,status,intervalMs:100,debounceMs:100,maxWaitMs:500});
  const server=viewer({artifacts,report,watchStatus:status,site:resolve(".generated/site")});
  try {
    await page.goto(`${await listen(server)}/basics`);
    await expect(page.getByText("No individual runs have been recorded for this test.")).toBeVisible();
    await fixture(artifacts,"maxwell-e2e-positive","maxwell-e2e-discovered",10);
    await expect(page.getByLabel("Test run",{exact:true})).toHaveValue("maxwell-e2e-discovered",{timeout:15_000});
    await expect(page.locator(".run-result .badge")).toHaveText("passed");
    const rows=join(artifacts,"maxwell-e2e-discovered/crud-records-rows.json");
    await writeFile(rows,JSON.stringify({source:[{id:"1",value:"first capture"}],target:[{id:"1",value:"first capture"}]}));
    await page.getByText("Explore database contents",{exact:true}).click({timeout:15_000});
    await expect(page.locator('[data-database="source"]')).toContainText("first capture");
    await writeFile(rows,JSON.stringify({source:[{id:"1",value:"changed capture"}],target:[{id:"1",value:"changed capture"}]}));
    await expect(page.locator(".database-view details[open]")).toHaveCount(0,{timeout:15_000});
    await page.getByText("Explore database contents",{exact:true}).click();
    await expect(page.locator('[data-database="source"]')).toContainText("changed capture");
  } finally {await page.close(); await watcher.close(); await close(server); await rm(workspace,{recursive:true,force:true});}
});
