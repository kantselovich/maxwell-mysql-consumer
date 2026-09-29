import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink, readdir} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {setTimeout as delay} from "node:timers/promises";
import {watchArtifacts} from "../reporting/watch.ts";
import {importArtifacts} from "../reporting/importer.ts";
import {exportSnapshot, selectRuns} from "../reporting/export.ts";

async function until(check:()=>Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Condition timed out"); await delay(25); }
}
test("watcher detects reruns, publishes atomically and preserves last report on refresh errors", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dashboard-watch-")), root = join(workspace,"artifacts"), output = join(workspace,"report.json"), status = join(workspace,"status.json");
  await mkdir(root);
  const watcher = await watchArtifacts({root,output,status,intervalMs:30,debounceMs:60,maxWaitMs:150});
  try {
    const run = join(root,"maxwell-e2e-new"); await mkdir(run);
    await writeFile(join(run,"run-metadata.json"), JSON.stringify({schemaVersion:1, runId:"maxwell-e2e-new", phase:3, kind:"run", state:"started", startedAt:"2026-09-28T23:00:00Z"}));
    await until(async () => JSON.parse(await readFile(output,"utf8")).runs.some((run:{id:string})=>run.id==="maxwell-e2e-new"));
    let report = JSON.parse(await readFile(output,"utf8")); assert.notEqual(report.runs[0].verdict,"passed");
    await writeFile(join(run,"host-result.json"), '{"phase":3,"exitCode":1,"harnessExitCode":-1}');
    await until(async () => JSON.parse(await readFile(output,"utf8")).runs[0].verdict === "failed");
    report = JSON.parse(await readFile(output,"utf8")); const revision = report.runs[0].evidenceRevision;
    await writeFile(join(run,"crud-records-rows.json"), '{"source":[],"target":[]}');
    await until(async () => JSON.parse(await readFile(output,"utf8")).runs[0].evidenceRevision !== revision);
    const last = await readFile(output,"utf8");
    await rename(root, join(workspace,"offline"));
    await until(async () => !!JSON.parse(await readFile(status,"utf8")).error);
    assert.equal(await readFile(output,"utf8"),last);
    await rename(join(workspace,"offline"),root);
    await until(async () => !JSON.parse(await readFile(status,"utf8")).error);
    assert.equal((await readdir(workspace)).filter(name=>name.endsWith(".tmp")).length,0);
  } finally { await watcher.close(); await rm(workspace,{recursive:true,force:true}); }
});
test("watcher rejects outputs in artifacts, including an aliased output directory", async () => {
  const workspace = await mkdtemp(join(tmpdir(),"dashboard-watch-boundary-")), root=join(workspace,"artifacts"); await mkdir(root);
  try {
    await symlink(root,join(workspace,"alias"));
    await assert.rejects(watchArtifacts({root,output:join(workspace,"alias/report.json"),status:join(workspace,"status.json")}));
    await assert.rejects(watchArtifacts({root,output:join(workspace,"report.json"),status:join(root,"status.json")}));
  } finally {await rm(workspace,{recursive:true,force:true});}
});
test("static export selects explicit runs, keeps safe checks and samples, and strips private evidence", async () => {
  const workspace=await mkdtemp(join(tmpdir(),"dashboard-export-")), artifacts=join(workspace,"artifacts"), site=join(workspace,"site"), output=join(workspace,"snapshots");
  await mkdir(artifacts); await mkdir(site);
  try {
    await writeFile(join(site,"index.html"), '<html><head></head><body><a href="/basics">Read</a></body></html>');
    const fixtures=JSON.parse(await readFile("test/fixtures/runs.json","utf8"));
    for (const id of ["maxwell-e2e-positive", "maxwell-e2e-startup"]) {
      const fixture=fixtures.find((f:{directory:string})=>f.directory===id), dir=join(artifacts,id); await mkdir(dir);
      for (const [name,value] of Object.entries(fixture.files)) await writeFile(join(dir,name),JSON.stringify(value));
    }
    const dir=join(artifacts,"maxwell-e2e-positive");
    await writeFile(join(dir,"memory-samples.log"), '2026-09-28T23:00:00Z\n{"Name":"secret-host-consumer-1","MemUsage":"6MiB / 8GiB","secret":"TOP_SECRET"}\n');
    await writeFile(join(dir,"latency-samples-seconds.json"), '[0,1.25]');
    await writeFile(join(dir,"crud-plan.json"), '{"secret":"TOP_SECRET"}');
    await writeFile(join(dir,"compose.log"), 'password=TOP_SECRET');
    const report=await importArtifacts(artifacts,"2026-09-28T23:00:00Z"), run=report.runs.find(run=>run.id==="maxwell-e2e-positive")!;
    run.configuration.value={password:"TOP_SECRET"}; run.issues.push("TOP_SECRET");
    run.assertions.push({id:"scenario-TOP_SECRET",status:"failed",description:"TOP_SECRET",evidence:[]});
    assert.throws(()=>selectRuns(report,["unknown"]));
    const exported=await exportSnapshot({report,artifacts,site,output,runIds:[run.id],generatedAt:"2026-09-28T23:00:00Z"});
    const manifest=JSON.parse(await readFile(join(exported,"snapshot.json"),"utf8")); assert.deepEqual(manifest.runIds,[run.id]);
    const saved=JSON.parse(await readFile(join(exported,"data/report.json"),"utf8"));
    assert.equal(saved.runs.length,1); assert.equal(saved.runs[0].counts.appliedEvents.value,2);
    assert.equal(saved.runs[0].issues.length,1); assert.equal(saved.runs[0].assertions.at(-1).status,"failed");
    assert.deepEqual(JSON.parse(await readFile(join(exported,`evidence/${run.id}/latency-samples-seconds.json`),"utf8")),[0,1.25]);
    async function inspect(directory:string) {
      for (const entry of await readdir(directory,{withFileTypes:true})) {
        if (entry.isDirectory()) await inspect(join(directory,entry.name));
        else { const text=await readFile(join(directory,entry.name),"utf8"); assert.doesNotMatch(text,/TOP_SECRET|secret-host|crud-plan|compose\.log/); }
      }
    }
    await inspect(exported);
    assert.match(await readFile(join(exported,"index.html"),"utf8"),/dashboard-snapshot/);
    assert.match(await readFile(join(exported,"index.html"),"utf8"),/href="\.\/basics.html"/);
    assert.equal(await readFile(join(exported,".nojekyll"),"utf8"), "");
    const dataOnly=await exportSnapshot({report,artifacts,output,runIds:[run.id]});
    assert.deepEqual((await readdir(dataOnly)).sort(), [".nojekyll","data","evidence","snapshot.json"]);
    await assert.rejects(exportSnapshot({report,artifacts,site,output:join(artifacts,"bad")}));
    await symlink(join(site,"index.html"),join(site,"unsafe.html"));
    await assert.rejects(exportSnapshot({report,artifacts,site,output}));
    assert.equal((await readdir(output)).filter(name=>name.startsWith(".snapshot-")).length,0);
  } finally {await rm(workspace,{recursive:true,force:true});}
});
