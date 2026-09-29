import { mkdir, mkdtemp, readFile, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { importArtifacts } from "../../reporting/importer.ts";
import { viewer } from "../../viewer/server.ts";

// Exercise the actual artifact importer. Never mock a normalized report or API.
const workspace = await mkdtemp(join(tmpdir(), "dashboard-browser-"));
const artifacts = join(workspace, "artifacts");
await mkdir(artifacts);
const fixtures = JSON.parse(await readFile("test/fixtures/runs.json", "utf8"));
for (const [index, fixture] of fixtures.entries()) {
  const dir = join(artifacts, fixture.directory); await mkdir(dir);
  for (const [name, content] of Object.entries(fixture.files)) await writeFile(join(dir, name), JSON.stringify(content));
  for (const [name, content] of Object.entries(fixture.rawFiles ?? {})) await writeFile(join(dir, name), String(content));
  if (!fixture.directory.includes("incomplete") && !fixture.directory.includes("legacy")) {
    // Give fixture attempts deterministic provenance. The startup failure is newest.
    const hour = fixture.directory === "maxwell-e2e-startup" ? 23 : index;
    const stamp = `2026-09-28T${String(hour).padStart(2, "0")}:00:00Z`;
    await writeFile(join(dir, "run-metadata.json"), JSON.stringify({schemaVersion: 1, runId: fixture.directory, phase: fixture.expected.phase, kind: "run", state: "finished", startedAt: stamp, finishedAt: stamp, code: {commit: "1111111111111111111111111111111111111111", dirty: fixture.directory === "maxwell-e2e-positive"}, parentSuiteId: null, gateId: null}));
  }
}
const workload = join(artifacts, "maxwell-phase5-workload-fixture");
await writeFile(join(workload, "latency-samples-seconds.json"), JSON.stringify([1, 1.8]));
// Browser fixture extends the minimal unit fixture with consistent sample metrics.
const metrics = JSON.parse(await readFile(join(workload, "load-metrics.json"), "utf8"));
Object.assign(metrics, {latencyP50Seconds: 1, latencyP95Seconds: 1.8, latencyP99Seconds: 1.8}); // nearest-rank, like the harness
await writeFile(join(workload, "load-metrics.json"), JSON.stringify(metrics));
await writeFile(join(workload, "memory-samples.log"), '2026-09-28T09:00:00Z\n{"Name":"fixture-consumer-1","MemUsage":"4MiB / 8GiB"}\n{"Name":"fixture-maxwell-1","MemUsage":"200MiB / 8GiB"}\n2026-09-28T09:00:04Z\n{"Name":"fixture-consumer-1","MemUsage":"6MiB / 8GiB"}\n{"Name":"fixture-maxwell-1","MemUsage":"220MiB / 8GiB"}\n');
await writeFile(join(artifacts, "maxwell-e2e-positive", "source-rows.json"), '[{"value":"<script>window.evidenceExecuted=true</script>"}]');
await writeFile(join(artifacts, "maxwell-e2e-positive", "diffs.json"), '[]');
const databaseSchema = {exists:true, engine:"InnoDB", collation:"utf8mb4_unicode_ci", columns:[{name:"id", type:"bigint unsigned", nullable:false}, {name:"value", type:"varchar(80)", nullable:true}], indexes:[{name:"PRIMARY", columns:["id"], unique:true}]};
const databaseRows = [{id:"18446744073709551615", value:"final 你好 🐘"}, {id:"2", value:"<script>window.evidenceExecuted=true</script>"}, {id:"3", value:""}, {id:"4", value:null}, {id:"5", value:"NULL"}, ...Array.from({length:23}, (_, i) => ({id:String(i + 6), value:`row ${i + 6}`}))];
const positive = join(artifacts, "maxwell-e2e-positive");
await writeFile(join(positive, "crud-records-schema.json"), JSON.stringify({source:databaseSchema, target:databaseSchema, expected:databaseSchema}));
// Numeric JSON tokens exercise the browser's lossless parser, not just string cells.
await writeFile(join(positive, "crud-records-rows.json"), JSON.stringify({source:databaseRows, target:databaseRows, expected:databaseRows}).replaceAll('"18446744073709551615"', '18446744073709551615'));
await writeFile(join(positive, "crud-plan.json"), JSON.stringify({name:"crud", steps:[{sql:"INSERT INTO poc.records (id, value) VALUES (?, ?)", bindings:["18446744073709551615", "final 你好 🐘"]}]}));
await writeFile(join(positive, "empty-records-rows.json"), '{"source":[],"target":[]}');
await writeFile(join(positive, "broken-records-rows.json"), '{broken');
await writeFile(join(artifacts, "maxwell-e2e-negative", "crud-records-rows.json"), JSON.stringify({source:[{id:"1",value:"source value"}], target:[{id:"1", value:"wrong value"}]}));
await writeFile(join(workload, "load_a-rows.json"), JSON.stringify({source:[{id:"1",value:"load value"}], target:[{id:"1",value:"load value"}]}));
await writeFile(join(artifacts, "maxwell-phase4-fixture", "recovery-rows.json"), JSON.stringify({source:[{id:"1",value:"recovered value"}], target:[{id:"1",value:"recovered value"}]}));
await writeFile(join(artifacts, "maxwell-e2e-positive", "container-inspect.json"), '{"Env":["SECRET=not-served"]}');
await writeFile(join(artifacts, "maxwell-e2e-positive", "observations.json"), JSON.stringify({identities: ["a", "b"], dlq: [], payloads: ['{"type":"insert","database":"poc","table":"records"}', '{"type":"table-create","database":"poc","table":"records"}']}));
for (const service of ["mysql84", "maxwell", "pubsub", "consumer", "mysql57"]) {
  await writeFile(join(artifacts, "maxwell-e2e-positive", `${service}-container.json`), JSON.stringify([{Name: `/fixture-${service}-1`, Config: {Image: `fixture/${service}:1`, Env: ["SECRET=never-publish"]}, State: {Status: "running"}, RestartCount: 0}]));
}
await writeFile(join(artifacts, "maxwell-e2e-positive", "compose.log"), "mysql84-1 | source ready\nconsumer-1 | applied event a\nmaxwell-1 | published event a\npubsub-1 | emulator ready\nmysql57-1 | target ready\n");
const suiteId = "maxwell-phase5-suite-linked";
const members = [
  ["scenario-assertions", "maxwell-e2e-positive", "maxwell-e2e-smoke-linked"],
  ["scenario-assertions", "maxwell-e2e-negative", "maxwell-e2e-missing-linked"],
  ["scenario-assertions", "maxwell-e2e-negative", "maxwell-e2e-wrong-linked"],
  ["types-keys-ddl", "maxwell-phase2-fixture", "maxwell-phase2-linked"],
  ["recovery", "maxwell-phase4-fixture", "maxwell-phase4-linked"],
  ["malformed", "maxwell-phase5-malformed-fixture", "maxwell-phase5-malformed-linked"],
  ["unsupported", "maxwell-phase5-unsupported-fixture", "maxwell-phase5-unsupported-linked"],
  ["transactions-load", "maxwell-phase5-workload-fixture", "maxwell-phase5-workload-linked"]
];
await cp(join(artifacts, "maxwell-phase5-suite-legacy"), join(artifacts, suiteId), {recursive: true});
await writeFile(join(artifacts, suiteId, "run-metadata.json"), JSON.stringify({schemaVersion: 1, runId: suiteId, phase: 5, kind: "suite", parentSuiteId: null, gateId: null}));
await writeFile(join(artifacts, suiteId, "suite-members.jsonl"), members.map(([gateId, , runId]) => JSON.stringify({gateId, runId})).join("\n"));
for (const [gateId, sourceId, runId] of members) {
  const dest = join(artifacts, runId);
  await cp(join(artifacts, sourceId), dest, {recursive: true});
  const phase = fixtures.find((f: {directory: string}) => f.directory === sourceId).expected.phase;
  await writeFile(join(dest, "run-metadata.json"), JSON.stringify({schemaVersion: 1, runId, phase, kind: "run", parentSuiteId: suiteId, gateId}));
  if (runId === "maxwell-e2e-smoke-linked") await writeFile(join(dest, "run-result.json"), JSON.stringify({passed: true, scenarios: ["append", "crud", "schema-change"].map(name => ({name, passed: true, failures: []}))}));
  if (runId === "maxwell-e2e-wrong-linked") {
    await writeFile(join(dest, "configuration.json"), JSON.stringify({scenario: "crud", fault: "wrong-value"}));
    await writeFile(join(dest, "run-result.json"), JSON.stringify({passed: false, failure: {code: "row-mismatch"}, scenarios: [{name: "crud", passed: false, failures: [{code: "row-mismatch"}]}]}));
  }
}
const report = join(workspace, "report.json");
await writeFile(report, JSON.stringify(await importArtifacts(artifacts, "2026-09-28T23:30:00Z")));
const server = viewer({artifacts, report, site: resolve(".generated/site"), repository: resolve("..")});
server.listen(4174, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => server.close(() => { void rm(workspace, {recursive: true, force: true}).then(() => process.exit()); }));
