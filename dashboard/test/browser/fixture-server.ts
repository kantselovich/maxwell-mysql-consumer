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
    await writeFile(join(dir, "run-metadata.json"), JSON.stringify({schemaVersion: 1, runId: fixture.directory, phase: fixture.expected.phase, kind: "run", state: "finished", startedAt: stamp, finishedAt: stamp, code: {commit: "1111111111111111111111111111111111111111", dirty: false}, parentSuiteId: null, gateId: null}));
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
