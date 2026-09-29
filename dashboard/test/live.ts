import {chromium, expect} from "@playwright/test";
import {readFile, writeFile, access} from "node:fs/promises";
import {join} from "node:path";

const directory=process.env.LIVE_EVIDENCE ?? "/live", browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.tracing.start({screenshots:false,snapshots:true});
const page=await context.newPage(), errors:string[]=[];
const samples:{runId:string;captured:string;verdict:string;beforeResult:boolean;at:string}[]=[];
page.on("pageerror",error=>errors.push(error.message));
page.on("crash",()=>errors.push("Browser page crashed during the POC run"));
page.on("requestfailed",request=>errors.push(`Request failed: ${request.url()}`));
async function json(path:string) { return JSON.parse(await readFile(path,"utf8")); }
async function exists(path:string) { try {await access(path); return true;} catch {return false;} }
const counts=page.getByRole("table",{name:"Recorded result counts"});
const cell=(label:string)=>counts.getByRole("row").filter({has:page.getByText(label,{exact:true})}).getByRole("cell").nth(1);
try {
  await page.goto(`${process.env.DASHBOARD_URL ?? "http://viewer:4173"}/basics`);
  await expect(page.locator('.narrative[data-ready="true"]')).toBeVisible();
  // Fail if the documented command and the command executed by the host drift.
  const command="make test-basic-replication";
  await expect(page.getByRole("region",{name:"Run this test"}).locator("code")).toHaveText(command);
  await page.evaluate(()=>{(window as unknown as {liveProof:string}).liveProof="same-page";});
  const initial=(await (await page.request.get(`${process.env.DASHBOARD_URL ?? "http://viewer:4173"}/api/report`)).json()).runs.map((r:{id:string})=>r.id);
  await writeFile(join(directory,"ready.json"),JSON.stringify({command,at:new Date().toISOString()}));
  let completed:{exitCode:number}|undefined, capturedScreenshot=false;
  await expect.poll(async()=>{
    if(errors.length) throw new Error(errors.join("; "));
    const selected=page.getByLabel("Test run",{exact:true});
    if(await selected.count()) {
      const runId=await selected.inputValue();
      if(!initial.includes(runId) && /^maxwell-e2e-[0-9]+-[0-9]+$/.test(runId)) {
        const captured=await cell("Captured unique events").textContent().catch(()=>null);
        const verdict=await page.locator(".run-result .badge").textContent().catch(()=>null);
        if(captured!==null && verdict!==null) {
          const sample={runId,captured,verdict,beforeResult:!await exists(`/artifacts/${runId}/run-result.json`),at:new Date().toISOString()};
          samples.push(sample);
          if(sample.beforeResult && /^[1-9]/.test(captured) && !capturedScreenshot) {
            await page.screenshot({path:join(directory,"during-run.png"),fullPage:true}); capturedScreenshot=true;
          }
        }
      }
    }
    try {completed=await json(join(directory,"completed.json")); return true;} catch {return false;}
  },{timeout:1_800_000,intervals:[500]}).toBe(true);
  if(completed?.exitCode!==0) throw new Error(`Displayed command exited ${completed?.exitCode}`);
  const log=await readFile(join(directory,"harness.log"),"utf8");
  const runIds=[...log.matchAll(/^E2E exit=0; evidence: .*\/(maxwell-e2e-[0-9]+-[0-9]+)$/gm)].map(m=>m[1]);
  expect(runIds).toHaveLength(3);
  const runId=runIds[0], live=samples.filter(s=>s.runId===runId && s.beforeResult && /^\d/.test(s.captured));
  expect(new Set(live.map(s=>s.captured)).size,"Captured counts must change while the real smoke workload is running").toBeGreaterThanOrEqual(2);
  expect(live.every(s=>s.verdict!=="passed"),"Unfinished run must not appear passed").toBe(true);
  await expect(page.getByLabel("Test run",{exact:true})).toHaveValue(runIds[2],{timeout:30_000});
  await expect(page.locator(".run-result .badge")).toHaveText("passed",{timeout:30_000});
  await expect(page.getByRole("status")).toContainText("Automatic refresh active");
  const verified=[];
  for(const [index,id] of runIds.entries()) {
    await page.getByLabel("Test run",{exact:true}).selectOption(id);
    await expect(page.locator(".run-result .badge")).toHaveText("passed");
    const root=`/artifacts/${id}`, manifest=await json(`${root}/manifest.json`), observed=await json(`${root}/observations.json`), ledger=await json(`${root}/ledger.json`), result=await json(`${root}/run-result.json`), host=await json(`${root}/host-result.json`);
    for(const [label,value] of [["Expected events",manifest.length],["Captured unique events",new Set(observed.identities).size],["Applied events",ledger.length],["DLQ deliveries",0]] as const) await expect(cell(label)).toHaveText(value.toLocaleString("en-US"));
    expect(observed.dlq).toHaveLength(0); expect(host.exitCode).toBe(0);
    if(index===0) {
      expect(result.passed).toBe(true); expect(result.scenarios.map((s:{name:string})=>s.name)).toEqual(["append","crud","schema-change"]);
      expect(manifest.length).toBe(ledger.length); expect(new Set(observed.identities).size).toBe(manifest.length);
    } else {
      expect(result.failure.code).toBe(index===1 ? "event-manifest" : "row-mismatch");
      await expect(page.getByText(/The verifier detected the deliberately introduced error/)).toBeVisible();
    }
    await page.screenshot({path:join(directory,`completed-${index}.png`),fullPage:true});
    verified.push({runId:id,expectedEvents:manifest.length,capturedEvents:observed.identities.length,appliedEvents:ledger.length,dlqDeliveries:0});
  }
  expect(await page.evaluate(()=>(window as unknown as {liveProof:string}).liveProof)).toBe("same-page");
  expect(errors).toEqual([]);
  await writeFile(join(directory,"browser-result.json"),JSON.stringify({passed:true,command,verified,liveCountValues:[...new Set(live.map(s=>s.captured))],withoutReload:true,watcherPublished:true},null,2));
  console.log(`Live dashboard check passed: ${runIds.join(", ")}`);
} catch(error) {
  await writeFile(join(directory,"browser-result.json"),JSON.stringify({passed:false,errors,message:error instanceof Error ? error.message : String(error)},null,2));
  throw error;
} finally {
  await writeFile(join(directory,"live-samples.json"),JSON.stringify(samples,null,2));
  await context.tracing.stop({path:join(directory,"trace.zip")});
  await browser.close();
}
