import {readFile, writeFile, mkdir, mkdtemp, readdir, rename, rm} from "node:fs/promises";
import {join, resolve, dirname} from "node:path";
import {pathToFileURL} from "node:url";
import {safeFile} from "../viewer/server.ts";
import {outputOutsideArtifacts} from "./publish.ts";
import {fact} from "./model.ts";
import type {Report, Run, EvidenceRef} from "./model.ts";
import {memorySamples} from "../src/components/data.js";
import {safeID} from "./evidence.ts";

const local: EvidenceRef = {path:"local-evidence", pointer:"", access:"local-only", label:"Local evidence"};
const sorted = (runs: Run[]) => [...runs].sort((a,b) => (Date.parse(b.startedAt.value ?? "") || 0) - (Date.parse(a.startedAt.value ?? "") || 0) || a.id.localeCompare(b.id));
export function selectRuns(report: Report, ids: string[]) {
  const chosen = ids.length ? ids.map(id => report.runs.find(run => run.id === id)) : [3,4,5].map(phase => sorted(report.runs.filter(run => run.kind === "run" && run.phase === phase))[0]).filter(Boolean);
  if (!chosen.length || chosen.some(run => !run || !safeID(run.id) || run.kind !== "run" || ![3,4,5].includes(run.phase ?? 0))) throw new Error("Select existing individual runs from phases 3–5");
  return [...new Map((chosen as Run[]).map(run => [run.id, run])).values()];
}
// Export an explicit structured allowlist. No spread of the source run: raw
// configs, versions, identifiers in SQL, diagnostics and environment stay local.
export function publicRun(run: Run): Run {
  const countFacts = Object.fromEntries(Object.entries(run.counts).map(([key, value]) => [key, fact(value.value, [local])]));
  const cleanFact = <T>(value: T | null) => fact(value, [local]);
  return {
    schemaVersion:1, id:run.id, artifactDirectory:"", phase:run.phase, kind:run.kind, verdict:run.verdict, expectedOutcome:run.expectedOutcome,
    failureKind:run.failureKind, failureCode:fact(), verdictEvidence:[local],
    startedAt:cleanFact(run.startedAt.value), finishedAt:cleanFact(run.finishedAt.value),
    rawExitCodes:{host:cleanFact(run.rawExitCodes.host.value), harness:cleanFact(run.rawExitCodes.harness.value)},
    code:fact(), configuration:fact(), versions:fact(), images:fact(),
    relationships:{parentSuiteId:fact(), gateId:fact(), children:fact()},
    scenarioIds:run.scenarioIds.filter(id => ["append", "crud", "schema-change", "missing-event", "wrong-value", "crash-outage-repair", "emulator-loss", "malformed", "unsupported", "transactions-load"].includes(id)),
    assertions:run.assertions.map((assertion, i) => ({id:`check-${i+1}`, status:assertion.status, description:assertion.id.startsWith("scenario-") ? "Recorded scenario outcome." : assertion.description, evidence:[local]})),
    counts:countFacts as Run["counts"], measurements:run.measurements.map(m => ({id:m.id, value:m.value, unit:m.unit, definition:m.definition, evidence:[local]})),
    sequence:[], evidence:[], issues:run.issues.length ? [`Reporting recorded ${run.issues.length} evidence issues for this run. Review the local evidence.`] : [], limitations:[],
    presentation:{tables:[], containers:[], issues:[], events:run.presentation?.events ? {
      rowChanges:run.presentation.events.rowChanges, schemaChanges:run.presentation.events.schemaChanges, otherEvents:run.presentation.events.otherEvents,
      invalidPayloads:run.presentation.events.invalidPayloads, source:"local-evidence", basis:run.presentation.events.basis === "Observed audit payloads" ? "Observed audit payloads" : "Expected workload events"
    } : null}
  };
}
export async function exportSnapshot(options:{report:Report; artifacts:string; site:string; output:string; runIds?:string[]; generatedAt?:string}) {
  const {report, artifacts, site} = options, output = resolve(options.output);
  await outputOutsideArtifacts(artifacts, join(output, "snapshot"));
  const selected = selectRuns(report, options.runIds ?? []);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  await mkdir(output, {recursive:true});
  const staging = await mkdtemp(join(output, ".snapshot-"));
  const name = `snapshot-${generatedAt.replace(/[^0-9]/g, "")}-${staging.split("-").at(-1)}`;
  const manifest = {schemaVersion:1, generatedAt, runIds:selected.map(run => run.id), evidencePolicy:"Recorded checks and sanitized numeric samples; raw artifacts remain local."};
  try {
    async function copy(directory: string, prefix = "") {
      for (const entry of await readdir(directory, {withFileTypes:true})) {
        const path = prefix + entry.name;
        if (entry.isSymbolicLink()) throw new Error("Static site contains a symlink");
        if (entry.isDirectory()) { await mkdir(join(staging, path), {recursive:true}); await copy(join(directory, entry.name), path + "/"); }
        else if (entry.isFile()) {
          const file = await safeFile(site, path);
          let bytes = await readFile(file);
          if (path.endsWith(".html")) bytes = Buffer.from(bytes.toString().replace(/href="\/(basics|recovery|failures)"/g, 'href="/$1.html"').replace("</head>", `<script id="dashboard-snapshot" type="application/json">${JSON.stringify(manifest).replaceAll("<", "\\u003c")}</script></head>`));
          await writeFile(join(staging, path), bytes, {flag:"wx"});
        }
      }
    }
    await copy(site);
    const runs:Run[] = [];
    for (const source of selected) {
      const run = publicRun(source), directory = `evidence/${run.id}`;
      await mkdir(join(staging, directory), {recursive:true});
      const checks = {runId:run.id, verdict:run.verdict, expectedOutcome:run.expectedOutcome, counts:run.counts, assertions:run.assertions, rawExitCodes:run.rawExitCodes, measurements:run.measurements};
      await writeFile(join(staging, directory, "checks.json"), JSON.stringify(checks, null, 2));
      const checksRef:EvidenceRef = {path:`${directory}/checks.json`, pointer:"", access:"snapshot", label:"Exported checks"};
      for (const value of Object.values(run.counts)) value.evidence = [checksRef];
      for (const assertion of run.assertions) assertion.evidence = [checksRef];
      for (const m of run.measurements) m.evidence = [checksRef];
      run.evidence.push(checksRef);
      for (const file of ["latency-samples-seconds.json", "memory-samples.log"]) {
        const ref = source.evidence.find(ref => ref.path.endsWith(`/${file}`));
        if (!ref) continue;
        try {
          const text = await readFile(await safeFile(artifacts, ref.path), "utf8");
          let safe: string;
          if (file.endsWith(".json")) {
            const values:unknown = JSON.parse(text);
            if (!Array.isArray(values) || values.some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0)) throw new Error("Invalid numeric samples");
            safe = JSON.stringify(values);
          } else safe = memorySamples(text).map(sample => `${new Date(sample.timestamp).toISOString()}\n${JSON.stringify({Name:`snapshot-${sample.service}-1`, MemUsage:`${sample.value}MiB / 0MiB`})}`).join("\n") + "\n";
          await writeFile(join(staging, directory, file), safe);
          run.evidence.push({path:`${directory}/${file}`, pointer:"", access:"snapshot"});
        } catch { run.issues.push(`The ${file === "memory-samples.log" ? "memory" : "latency"} samples could not be included. Review the local evidence.`); }
      }
      runs.push(run);
    }
    const summary:Report["summary"] = {runs:runs.length, suites:0, verdicts:{passed:0, failed:0, incomplete:0, unknown:0}};
    for (const run of runs) summary.verdicts[run.verdict]++;
    await mkdir(join(staging, "data"));
    await writeFile(join(staging, "data/report.json"), JSON.stringify({schemaVersion:1, generatedAt, catalog:report.catalog, runs, discoveryIssues:[], summary} satisfies Report));
    await writeFile(join(staging, "snapshot.json"), JSON.stringify(manifest, null, 2));
    await rename(staging, join(output, name));
    return join(output, name);
  } catch (error) { await rm(staging, {recursive:true, force:true}); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [artifacts, report, output] = process.argv.slice(2);
  if (!artifacts || !report || !output) throw new Error("Usage: node reporting/export.ts ARTIFACT_ROOT REPORT_JSON OUTPUT_DIRECTORY");
  const path = await exportSnapshot({artifacts:resolve(artifacts), report:JSON.parse(await readFile(report, "utf8")), site:resolve(".generated/site"), output:resolve(output), runIds:(process.env.RUN_IDS ?? "").split(",").filter(Boolean)});
  console.log(`Static snapshot: ${path}`);
}
