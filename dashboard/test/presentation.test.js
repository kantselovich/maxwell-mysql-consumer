import assert from "node:assert/strict";
import {test} from "node:test";
import {shown, orderedRuns, latencyBins, memorySamples, comparisonWarnings} from "../src/components/data.js";

test("presentation preserves missing values, zero, and newer failed attempts", () => {
  assert.equal(shown(null), "Unavailable"); assert.equal(shown(0), "0");
  const runs = [{id: "old-pass", verdict: "passed", startedAt: {value: "2026-09-28T10:00:00Z"}}, {id: "new-fail", verdict: "failed", startedAt: {value: "2026-09-28T11:00:00Z"}}, {id: "unknown", startedAt: {value: null}}];
  assert.deepEqual(orderedRuns(runs).map(r => r.id), ["new-fail", "old-pass", "unknown"]);
});
test("latency bins preserve sample totals including zero and upper boundary", () => {
  const bins = latencyBins([0, 1, 8]);
  assert.equal(bins.reduce((sum, b) => sum + b.value, 0), 3);
  assert.equal(bins[7].value, 1); assert.equal(latencyBins([0])[0].value, 1);
  for (const values of [[], [null], [-1], [Infinity]]) assert.throws(() => latencyBins(values));
});
test("memory parsing converts units, keeps actual timestamps and rejects unrecorded values", () => {
  const text = '2026-09-28T09:00:00Z\n{"Name":"poc-consumer-1","MemUsage":"1024KiB / 1GiB"}\n{"Name":"poc-maxwell-1","MemUsage":"1GiB / 2GiB"}\n';
  assert.deepEqual(memorySamples(text).map(s => s.value), [1, 1024]);
  assert.equal(memorySamples(text)[0].timestamp, "2026-09-28T09:00:00Z");
  assert.throws(() => memorySamples(text.split("\n").slice(1).join("\n")));
  assert.throws(() => memorySamples(""));
});
test("comparison never asserts compatible hardware from missing metadata", () => {
  const a = {phase: 5, scenarioIds: ["transactions-load"], expectedOutcome: "replication-success", configuration: {value: {rows: 2}}, versions: {value: null}, images: {value: null}, code: {value: null}};
  const b = {...a, configuration: {value: {rows: 1000}}};
  assert(comparisonWarnings(a, b).some(w => w.includes("configuration") && w.includes("differs")));
  assert(comparisonWarnings(a, a).some(w => w.includes("versions: unavailable")));
});
