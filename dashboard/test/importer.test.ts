import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { importArtifacts } from "../reporting/importer.ts";
import { exactPayload } from "../reporting/evidence.ts";
import type { Run } from "../reporting/model.ts";

type Fixture = { directory: string; files: Record<string, unknown>; rawFiles?: Record<string, string>; expected: Record<string, unknown> };
const fixtures: Fixture[] = JSON.parse(await readFile(new URL("fixtures/runs.json", import.meta.url), "utf8"));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const clone = (id: string) => structuredClone(fixtures.find(f => f.directory === id)!);
async function materialize(root: string, fixture: Fixture) {
  const dir = join(root, fixture.directory); await mkdir(dir, { recursive: true });
  for (const [name, value] of Object.entries(fixture.files)) await writeFile(join(dir, name), JSON.stringify(value));
  for (const [name, text] of Object.entries(fixture.rawFiles ?? {})) await writeFile(join(dir, name), text);
}
async function temporary(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "poc-report-test-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function value(run: Run, key: string): unknown {
  if (key in run.counts) return run.counts[key as keyof Run["counts"]].value;
  if (key === "startedAt" || key === "finishedAt") return run[key].value;
  if (key === "latencyP95Seconds") return run.measurements.find(m => m.id === key)?.value;
  return run[key as keyof Run];
}
for (const fixture of fixtures) test(`fixture: ${fixture.directory}`, () => temporary(async root => {
  await materialize(root, fixture);
  const before = await readFile(join(root, fixture.directory, Object.keys(fixture.files)[0]));
  const report = await importArtifacts(root, "2026-09-28T13:00:00Z");
  assert.equal(report.runs.length, 1);
  for (const [key, expected] of Object.entries(fixture.expected)) assert.deepEqual(value(report.runs[0], key), expected, key);
  assert.equal(report.runs[0].id, fixture.directory);
  for (const ref of report.runs[0].evidence) { assert(!ref.path.includes("..")); await readFile(join(root, ref.path)); }
  assert.deepEqual(await readFile(join(root, fixture.directory, Object.keys(fixture.files)[0])), before, "raw artifacts are unchanged");
}));

test("JSON replay comparison preserves numeric boundaries and ignores object key order", () => {
  assert.deepEqual(exactPayload('{"a":18446744073709551615,"b":null}'), exactPayload('{"b":null,"a":18446744073709551615}'));
  assert.notDeepEqual(exactPayload('18446744073709551615'), exactPayload('18446744073709551614'));
  assert.notDeepEqual(exactPayload('1'), exactPayload('"1"'));
  assert.notDeepEqual(exactPayload('1'), exactPayload('{"source":"1"}'));
});

test("UInt64 workload seeds are retained exactly, not rounded", () => temporary(async root => {
  const f = clone("maxwell-e2e-positive"); await materialize(root, f);
  await writeFile(join(root, f.directory, "configuration.json"), '{"scenario":"append","fault":"none","seed":18446744073709551615}');
  const run = (await importArtifacts(root)).runs[0];
  assert.equal(run.verdict, "passed"); assert.equal(run.configuration.value?.seed, "18446744073709551615");
}));

test("expected failures require the exact host and harness predicate", () => temporary(async root => {
  for (const mutation of ["wrong-code", "wrong-exit", "unexpected-success", "host-failure"]) {
    const f = clone("maxwell-e2e-negative");
    const host = f.files["host-result.json"] as Record<string, unknown>;
    const result = f.files["run-result.json"] as { passed: boolean; failure: { code: string } };
    if (mutation === "wrong-code") result.failure.code = "connection-error";
    if (mutation === "wrong-exit") host.harnessExitCode = 124;
    if (mutation === "unexpected-success") result.passed = true;
    if (mutation === "host-failure") host.exitCode = 1;
    await materialize(root, f);
    assert.equal((await importArtifacts(root)).runs[0].verdict, "failed", mutation);
  }
}));

test("a changed duplicate diagnostic or unresolved quarantine cannot pass", () => temporary(async root => {
  const f = clone("maxwell-phase4-fixture");
  const state = f.files["recovery-state.json"] as { dlq: { reason: string }[] };
  state.dlq[2].reason = "different bytes";
  await materialize(root, f);
  assert.equal((await importArtifacts(root)).runs[0].verdict, "unknown");
  const clean = clone("maxwell-phase4-fixture");
  (clean.files["recovery-quarantine.json"] as { resolved: string }[])[0].resolved = "0";
  await materialize(root, clean);
  assert.equal((await importArtifacts(root)).runs[0].verdict, "unknown");
}));

test("wrong ledger IDs, invalid metrics and missing terminal results are not passes", () => temporary(async root => {
  const f = clone("maxwell-phase5-workload-fixture");
  f.files["load-ledger.json"] = [{ event_id: "a" }, { event_id: "wrong" }];
  await materialize(root, f);
  assert.equal((await importArtifacts(root)).runs[0].verdict, "unknown");
  const clean = clone("maxwell-phase5-workload-fixture");
  (clean.files["load-metrics.json"] as Record<string, unknown>).latencyP95Seconds = -2;
  await materialize(root, clean);
  assert.equal((await importArtifacts(root)).runs[0].verdict, "unknown");
  await rm(join(root, f.directory, "host-result.json"));
  await rm(join(root, f.directory, "load-metrics.json"));
  await materialize(root, { directory: f.directory, files: { "load-ledger.json": [{ event_id: "a" }, { event_id: "b" }] }, expected: {} });
  assert.equal((await importArtifacts(root)).runs[0].verdict, "incomplete");
}));

test("logs alone, even PASS lines, never establish success", () => temporary(async root => {
  await materialize(root, { directory: "maxwell-phase4-log-only", files: {}, rawFiles: { "probe.log": "PASS everything" }, expected: {} });
  const run = (await importArtifacts(root)).runs[0];
  assert.equal(run.verdict, "incomplete"); assert.equal(run.counts.appliedEvents.value, null);
  assert.equal(run.startedAt.value, null); assert.equal(run.sequence.length, 0);
}));

test("no environment dumps, symlink escapes or unsafe identifiers enter reports", () => temporary(async root => {
  const f = clone("maxwell-e2e-positive");
  f.files["consumer-container.json"] = { Config: { Env: ["PASSWORD=never-export-this"] } };
  await materialize(root, f);
  await symlink(join(root, f.directory), join(root, "maxwell-e2e-linked"));
  await rm(join(root, f.directory, "ledger.json"));
  await symlink(join(root, f.directory, "consumer-container.json"), join(root, f.directory, "ledger.json"));
  const report = await importArtifacts(root);
  assert.equal(report.runs.length, 1); assert.equal(report.runs[0].verdict, "unknown");
  assert.equal(report.discoveryIssues.length, 1); assert(!JSON.stringify(report).includes("never-export-this"));
}));

test("CLI atomically writes deterministic data outside artifacts and rejects symlinked outputs into them", () => temporary(async root => {
  const artifacts = join(root, "artifacts"); await mkdir(artifacts);
  await materialize(artifacts, clone("maxwell-e2e-positive"));
  const cli = join(repo, "dashboard/reporting/cli.ts"), output = join(root, "generated/report.json");
  execFileSync(process.execPath, [cli, artifacts, output]);
  const report = JSON.parse(await readFile(output, "utf8")); assert.equal(report.runs[0].verdict, "passed");
  await symlink(artifacts, join(root, "alias"));
  assert.throws(() => execFileSync(process.execPath, [cli, artifacts, join(root, "alias/report.json")], { stdio: "pipe" }));
}));

test("explicit suites link all gates without summing suite and child events", () => temporary(async root => {
  const suiteID = "maxwell-phase5-suite-linked";
  const pairs = [
    ["scenario-assertions", "maxwell-e2e-positive"], ["scenario-assertions", "maxwell-e2e-negative"], ["scenario-assertions", "maxwell-e2e-wrong-value"],
    ["types-keys-ddl", "maxwell-phase2-fixture"],
    ["recovery", "maxwell-phase4-fixture"], ["malformed", "maxwell-phase5-malformed-fixture"],
    ["unsupported", "maxwell-phase5-unsupported-fixture"], ["transactions-load", "maxwell-phase5-workload-fixture"]
  ];
  const metadata = (runId: string, phase: number, kind = "run", gateId: string | null = null) => ({ schemaVersion: 1, runId, phase, kind, parentSuiteId: kind === "run" ? suiteID : null, gateId });
  const suite = clone("maxwell-phase5-suite-legacy"); suite.directory = suiteID;
  suite.files["run-metadata.json"] = metadata(suiteID, 5, "suite");
  suite.rawFiles = { "suite-members.jsonl": pairs.map(([gateId, runId]) => JSON.stringify({ gateId, runId })).join("\n") + "\n" };
  await materialize(root, suite);
  for (const [gateId, runId] of pairs) {
    const f = clone(runId === "maxwell-e2e-wrong-value" ? "maxwell-e2e-negative" : runId);
    f.directory = runId;
    if (runId === "maxwell-e2e-positive") {
      f.files["run-result.json"] = { passed: true, scenarios: ["append", "crud", "schema-change"].map(name => ({ name, passed: true, failures: [] })) };
    }
    if (runId === "maxwell-e2e-wrong-value") {
      f.files["configuration.json"] = { scenario: "crud", fault: "wrong-value" };
      f.files["run-result.json"] = { passed: false, failure: { code: "row-mismatch" }, scenarios: [{ name: "crud", passed: false, failures: [{ code: "row-mismatch" }] }] };
    }
    f.files["run-metadata.json"] = metadata(runId, Number(f.expected.phase), "run", gateId); await materialize(root, f);
  }
  let report = await importArtifacts(root); let summary = report.runs.find(r => r.id === suiteID)!;
  assert.equal(summary.verdict, "passed"); assert.equal(summary.relationships.children.value?.length, 8);
  assert.equal(summary.counts.appliedEvents.value, null); assert(!("appliedEvents" in report.summary));
  await rm(join(root, "maxwell-e2e-positive"), { recursive: true });
  report = await importArtifacts(root); summary = report.runs.find(r => r.id === suiteID)!;
  assert.equal(summary.verdict, "incomplete");
}));

test("metadata helper records immutable identities, explicit children, and does not change test exit codes", () => temporary(async root => {
  const suite = join(root, "maxwell-phase5-suite-meta"), child = join(root, "maxwell-e2e-meta");
  await mkdir(suite); await mkdir(child);
  const script = join(repo, "scripts/reporting-metadata.sh");
  execFileSync("bash", ["-c", 'set -euo pipefail; source "$1"; reporting_begin 3; reporting_finish', "metadata-test", script], {
    cwd: repo, env: { ...process.env, ARTIFACT_PATH: child, REPORT_SUITE_ID: "maxwell-phase5-suite-meta", REPORT_GATE_ID: "scenario-assertions" }
  });
  const meta = JSON.parse(await readFile(join(child, "run-metadata.json"), "utf8"));
  assert.equal(meta.state, "finished"); assert.equal(meta.runId, "maxwell-e2e-meta"); assert(meta.startedAt); assert(meta.finishedAt);
  assert.deepEqual(JSON.parse(await readFile(join(suite, "suite-members.jsonl"), "utf8")), { runId: "maxwell-e2e-meta", gateId: "scenario-assertions" });
  execFileSync("bash", ["-c", 'set -euo pipefail; source "$1"; reporting_begin 3; reporting_finish; exit 0', "metadata-test", script], {
    env: { ...process.env, ARTIFACT_PATH: join(root, "absent/maxwell-e2e-missing"), REPORT_SUITE_ID: "", REPORT_GATE_ID: "" }, stdio: "pipe"
  });
  assert.throws(() => execFileSync("bash", ["-c", 'set -euo pipefail; source "$1"; reporting_begin 3; trap \'code=$?; reporting_finish; exit "$code"\' EXIT; exit 13', "metadata-test", script], {
    env: { ...process.env, ARTIFACT_PATH: join(root, "absent/maxwell-e2e-missing"), REPORT_SUITE_ID: "", REPORT_GATE_ID: "" }, stdio: "pipe"
  }), (error: unknown) => (error as { status: number }).status === 13);
}));

test("Phase 1 host runner creates a new evidence directory and preserves legacy files", () => temporary(async root => {
  await mkdir(join(root, "scripts")); await mkdir(join(root, "bin")); await mkdir(join(root, "artifacts"));
  await writeFile(join(root, "artifacts/result.json"), "legacy-result");
  for (const name of ["phase1.sh", "reporting-metadata.sh"]) await copyFile(join(repo, "scripts", name), join(root, "scripts", name));
  await copyFile(new URL("fixtures/docker-phase1.sh", import.meta.url), join(root, "bin/docker"));
  await chmod(join(root, "bin/docker"), 0o755);
  execFileSync("bash", [join(root, "scripts/phase1.sh")], { env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, REPORT_SUITE_ID: "", REPORT_GATE_ID: "" }, stdio: "pipe" });
  const runs = (await readdir(join(root, "artifacts"))).filter(x => x.startsWith("maxwell-phase1-"));
  assert.equal(runs.length, 1);
  assert.equal(await readFile(join(root, "artifacts/result.json"), "utf8"), "legacy-result");
  const dir = join(root, "artifacts", runs[0]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "result.json"), "utf8")), { phase: 1, exitCode: 0 });
  assert.equal(JSON.parse(await readFile(join(dir, "run-metadata.json"), "utf8")).state, "finished");
  assert.equal(await readFile(join(dir, "replay-position.txt"), "utf8"), "binlog.000001:10:123\n");
}));
