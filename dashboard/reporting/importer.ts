import { readdir, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { catalog } from "./catalog.ts";
import { presentation } from "./presentation.ts";
import { Evidence, array, count, exactPayload, number, object, safeID, string, strings } from "./evidence.ts";
import type { JSONValue, ObjectValue } from "./evidence.ts";
import { fact } from "./model.ts";
import type { ExpectedOutcome, Report, Run, Verdict } from "./model.ts";

const hasChecks = (state: ObjectValue, checks: string[]) => {
  const found = strings(state.checks);
  return found === null ? null : checks.every(x => found.includes(x));
};
const idsFromLedger = (v: JSONValue | undefined): string[] | null => {
  const rows = array(v);
  if (!rows) return null;
  const ids = rows.map(x => string(object(x).event_id));
  return ids.every(x => x !== null) ? ids as string[] : null;
};
const sameIDs = (a: string[] | null, b: string[] | null): boolean | null => a === null || b === null ? null :
  new Set(a).size === a.length && new Set(b).size === b.length && isDeepStrictEqual([...a].sort(), [...b].sort());
const metricDefinitions: Record<string, ["seconds" | "events/second" | "events", string]> = {
  expectedEvents: ["events", "Expected unique DDL and committed DML events."],
  measuredDMLEvents: ["events", "DML events with source-submit and target-observation timestamps."],
  backlogEvents: ["events", "Initial unapplied committed DML; not a broker queue-depth metric."],
  backlogAtStreamStart: ["events", "Initial events still unapplied when continuing source writes start."],
  backlogRecoverySeconds: ["seconds", "Pre-restart marker to first observation that initial backlog applied; includes start/poll overhead."],
  backlogEventsPerSecond: ["events/second", "Initial backlog divided by observational recovery interval while writes continue."],
  streamEventsPerSecond: ["events/second", "Continuing writes divided by writing, convergence and drain time."],
  latencyP50Seconds: ["seconds", "Nearest-rank p50 of source pre-statement/pre-COMMIT to target-ledger observation, including backlog and polling."],
  latencyP95Seconds: ["seconds", "Nearest-rank p95 of source pre-statement/pre-COMMIT to target-ledger observation, including backlog and polling."],
  latencyP99Seconds: ["seconds", "Nearest-rank p99 of source pre-statement/pre-COMMIT to target-ledger observation, including backlog and polling."]
};

async function importRun(root: string, directory: string): Promise<Run> {
  const e = new Evidence(root, directory);
  const metadata = object(await e.read("run-metadata.json"));
  const hostFile = directory.includes("phase5-suite") || metadata.kind === "suite" ? "suite-result.json" :
    await e.read("host-result.json") !== undefined ? "host-result.json" : "result.json";
  const terminal = await e.read(hostFile), host = object(terminal);
  const phaseValue = count(host.phase) ?? count(metadata.phase) ?? (directory === "." ? 1 :
    directory.includes("-e2e-") ? 3 : Number(directory.match(/-phase([1-5])-/)?.[1]) || null);
  const phase = phaseValue !== null && phaseValue >= 1 && phaseValue <= 5 ? phaseValue : null;
  const kind = hostFile === "suite-result.json" ? "suite" : "run";
  const run: Run = {
    schemaVersion: 1, id: directory === "." ? "legacy-phase1" : directory, artifactDirectory: directory, phase, kind,
    verdict: "incomplete", expectedOutcome: "unknown", failureKind: null, failureCode: fact(), verdictEvidence: [],
    rawExitCodes: { host: fact(count(host.exitCode), terminal === undefined ? [] : [e.ref(hostFile, "/exitCode")]),
      harness: fact(number(host.harnessExitCode), host.harnessExitCode === undefined ? [] : [e.ref(hostFile, "/harnessExitCode")]) },
    startedAt: fact(), finishedAt: fact(), code: fact(), configuration: fact(), versions: fact(), images: fact(),
    relationships: { parentSuiteId: fact(), gateId: fact(), children: fact() },
    scenarioIds: [], assertions: [],
    counts: { expectedEvents: fact(), capturedEvents: fact(), appliedEvents: fact(), dlqDeliveries: fact(), uniqueQuarantines: fact(), expectedQuarantines: fact() },
    measurements: [], sequence: [], evidence: [], issues: e.issues, limitations: []
  };
  const check = (id: string, ok: boolean | null, description: string, files: string[]) => {
    run.assertions.push({ id, status: ok === null ? "incomplete" : ok ? "passed" : "unknown", description,
      evidence: files.filter(f => e.cache.get(f) !== undefined).map(f => e.ref(f)) });
  };
  const setCount = (name: keyof Run["counts"], value: number | null, file: string, pointer: string) => {
    run.counts[name] = fact(value, e.cache.get(file) === undefined ? [] : [e.ref(file, pointer)]);
  };
  const account = (state: ObjectValue, stateFile: string, ledger: JSONValue | undefined, ledgerFile: string) => {
    const expected = array(state.expected), ids = strings(state.identities), applied = idsFromLedger(ledger);
    setCount("expectedEvents", expected?.length ?? null, stateFile, "/expected");
    setCount("capturedEvents", ids ? new Set(ids).size : null, stateFile, "/identities");
    setCount("appliedEvents", applied ? new Set(applied).size : null, ledgerFile, "");
    check("event-accounting", expected && ids && applied ? expected.length > 0 && expected.length === ids.length && sameIDs(ids, applied) === true : null,
      "Independent expected, captured and applied unique-event accounting agrees.", [stateFile, ledgerFile]);
  };
  const diagnostics = (state: ObjectValue, file: string) => {
    const dlq = array(state.dlq);
    setCount("dlqDeliveries", dlq?.length ?? null, file, "/dlq");
    const groups = new Map<string, JSONValue>();
    let valid = true;
    for (const d of dlq ?? []) {
      const id = string(object(d).failureID);
      if (!id || (groups.has(id) && !isDeepStrictEqual(groups.get(id), d))) valid = false;
      else groups.set(id, d);
    }
    setCount("uniqueQuarantines", dlq && valid ? groups.size : null, file, "/dlq");
    check("diagnostic-identity", dlq === null ? null : valid, "Repeated diagnostic identities have identical contents.", [file]);
    return dlq;
  };
  if (Object.keys(metadata).length) {
    check("metadata", metadata.schemaVersion === 1 && metadata.runId === run.id && metadata.phase === phase && metadata.kind === kind,
      "Run metadata version and identity agree with the artifact directory and terminal result.", ["run-metadata.json", hostFile]);
    for (const key of ["startedAt", "finishedAt"] as const) {
      const value = string(metadata[key]);
      if (value && Number.isFinite(Date.parse(value))) run[key] = fact(value, [e.ref("run-metadata.json", `/${key}`)]);
      else if (metadata[key] != null) e.issues.push(`Invalid metadata ${key}`);
    }
    const code = object(metadata.code);
    run.code = fact({ commit: string(code.commit), dirty: typeof code.dirty === "boolean" ? code.dirty : null }, [e.ref("run-metadata.json", "/code")]);
    if (code.dirty === true) run.limitations.push("Run started from a dirty worktree: the base commit is recorded, but the uncommitted diff is not captured.");
    for (const key of ["parentSuiteId", "gateId"] as const) {
      if (metadata[key] != null && !safeID(metadata[key])) e.issues.push(`Invalid metadata ${key}`);
      if (safeID(metadata[key])) run.relationships[key] = fact(metadata[key], [e.ref("run-metadata.json", `/${key}`)]);
    }
  } else run.limitations.push("Legacy run: code revision and start/finish times are unavailable; file/directory times are not substituted.");
  if (directory === ".") run.limitations.push("Legacy Phase 1 files share a mutable directory; older overwritten attempts cannot be reconstructed.");
  let forceFailure = false;
  const result = phase === 3 ? object(await e.read("run-result.json")) : {};
  const configFile = await e.read("configuration.json");
  const configuration = object(configFile ?? result.configuration);
  if (Object.keys(configuration).length) {
    const safe: Record<string, string | number | boolean> = {};
    for (const key of ["scenario", "fault", "rows", "seed", "writeIntervalMS", "timeoutSeconds", "drainSeconds", "runID"]) {
      const value = configuration[key];
      // Avoid emitting silently rounded UInt64 seeds from JSON.parse.
      if (typeof value === "number" && !Number.isSafeInteger(value)) { e.issues.push(`Unsafe numeric configuration ${key}; raw evidence required`); continue; }
      if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") safe[key] = value;
    }
    run.configuration = fact(safe, [e.ref(configFile === undefined ? "run-result.json" : "configuration.json", configFile === undefined ? "/configuration" : "")]);
  }
  const versions = object(await e.read("versions.json"));
  if (Object.keys(versions).length) {
    const normalized: Record<string, string> = {};
    for (const key of ["source", "target"]) {
      const value = string(object(array(versions[key])?.[0]).version);
      if (value) normalized[key] = value;
    }
    run.versions = fact(normalized, [e.ref("versions.json")]);
  }
  const images = array(await e.read("images.json"));
  if (images) run.images = fact(images.flatMap(x => {
    const row = object(x), repository = string(row.Repository);
    return repository ? [{ repository, tag: string(row.Tag), id: string(row.ID), platform: string(row.Platform) }] : [];
  }), [e.ref("images.json")]);

  if (kind === "suite") {
    run.expectedOutcome = "suite"; run.scenarioIds = ["complete-suite"];
    check("required-gates", count(host.completedGates) === null || count(host.requiredGates) === null ? null :
      host.completedGates === 6 && host.requiredGates === 6, "All six required host gates completed.", [hostFile]);
    const members = await e.read("suite-members.jsonl", true);
    if (members !== undefined) {
      const ids: string[] = [];
      for (const value of array(members) ?? []) {
        const member = object(value);
        if (!safeID(member.runId) || !safeID(member.gateId) || ids.includes(member.runId)) e.issues.push("Invalid or duplicate suite member");
        else ids.push(member.runId);
      }
      run.relationships.children = fact(ids, [e.ref("suite-members.jsonl")]);
    } else {
      run.limitations.push("No explicit child manifest; legacy suite links are unavailable, not inferred from log text.");
      if (Object.keys(metadata).length) check("suite-members", null, "New suites require explicit child membership.", []);
    }
    run.limitations.push("Suite counts are intentionally unavailable: event counts belong to child runs.");
  } else if (phase === 1) {
    run.expectedOutcome = "capture-only"; run.scenarioIds = ["capture-replay"];
    const capture = object(await e.read("capture.json")), replay = strings(await e.read("replay.json"));
    const ids = strings(capture.identities), payloads = strings(capture.payloads);
    setCount("capturedEvents", ids ? new Set(ids).size : null, "capture.json", "/identities");
    let equal: boolean | null = null;
    if (ids && payloads && replay) {
      try { equal = ids.length > 0 && new Set(ids).size === ids.length && payloads.length === ids.length && isDeepStrictEqual(payloads.map(exactPayload), replay.map(exactPayload)); }
      catch { e.issues.push("Invalid captured/replayed JSON payload"); }
    }
    check("capture-replay", equal, "Captured events replay with identical exact JSON content (object-key order may differ); host compatibility assertions completed.", ["capture.json", "replay.json", hostFile]);
    const source = string(capture.sourceVersion), target = string(capture.targetVersion);
    if (source && target) run.versions = fact({ source, target }, [e.ref("capture.json")]);
    run.limitations.push("Capture-only gate: target applied-event and DLQ counts are not present in the legacy JSON.");
  } else if (phase === 2) {
    run.expectedOutcome = "replication-success"; run.scenarioIds = ["types-keys-ddl", "target-recovery"];
    const expected = array(await e.read("expected-events.json")), audit = array(await e.read("audit.json"));
    const ledger = idsFromLedger(await e.read("ledger.json"));
    const assertions = object(await e.read("assertions.json")), recovery = object(await e.read("recovery-assertions.json"));
    setCount("expectedEvents", expected?.length ?? null, "expected-events.json", "");
    setCount("capturedEvents", count(assertions.uniqueEvents), "assertions.json", "/uniqueEvents");
    setCount("appliedEvents", ledger ? new Set(ledger).size : null, "ledger.json", "");
    setCount("dlqDeliveries", count(assertions.dlqDeliveries), "assertions.json", "/dlqDeliveries");
    check("event-accounting", expected && audit && ledger && count(assertions.uniqueEvents) !== null ?
      expected.length === assertions.uniqueEvents && audit.length === expected.length && ledger.length === expected.length && new Set(ledger).size === ledger.length : null,
      "Host-verified expected, audit and ledger event counts agree.", ["expected-events.json", "audit.json", "ledger.json", "assertions.json"]);
    check("empty-dlq", count(assertions.dlqDeliveries) === null ? null : assertions.dlqDeliveries === 0, "Positive replication has zero DLQ deliveries.", ["assertions.json"]);
    check("target-recovery", Object.keys(recovery).length ? ["ddlRecovery", "dmlRollback", "deduplication", "collisionRejected", "driftRejected", "pendingDDLBlocks"].every(k => recovery[k] === true) : null,
      "All direct target recovery assertions passed.", ["recovery-assertions.json"]);
  } else if (phase === 3) {
    const fault = string(configuration.fault), negative = fault === "missing-event" || fault === "wrong-value";
    run.expectedOutcome = fault === null ? "unknown" : negative ? "expected-failure" : "replication-success";
    run.scenarioIds = negative ? [fault] : (array(result.scenarios) ?? []).map(s => string(object(s).name)).filter((x): x is string => ["append", "crud", "schema-change"].includes(x ?? ""));
    const observations = object(await e.read("observations.json")), manifest = array(await e.read("manifest.json"));
    const ledger = await e.read("ledger.json");
    const scenarioResults = array(result.scenarios);
    const failure = object(result.failure);
    if (safeID(failure.code)) run.failureCode = fact(failure.code, [e.ref("run-result.json", "/failure/code")]);
    if (negative) {
      const expectedCode = fault === "missing-event" ? "event-manifest" : "row-mismatch";
      const scenario = object(scenarioResults?.[0]);
      const expected = result.passed === false && failure.code === expectedCode && configuration.scenario === "crud" &&
        scenarioResults?.length === 1 && scenario.name === "crud" && scenario.passed === false &&
        array(scenario.failures)?.length === 1 && object(array(scenario.failures)?.[0]).code === expectedCode && host.harnessExitCode === 1;
      check("expected-failure", Object.keys(result).length ? expected : null, `Host validated the deliberate ${expectedCode} failure, not an infrastructure error.`, ["run-result.json", hostFile]);
      if (Object.keys(result).length && !expected) forceFailure = true;
      setCount("expectedEvents", manifest?.length ?? null, "manifest.json", "");
      const ids = strings(observations.identities), applied = idsFromLedger(ledger);
      setCount("capturedEvents", ids ? new Set(ids).size : null, "observations.json", "/identities");
      setCount("appliedEvents", applied ? new Set(applied).size : null, "ledger.json", "");
    } else {
      account({ ...observations, expected: manifest ?? null }, "observations.json", ledger, "ledger.json");
      setCount("expectedEvents", manifest?.length ?? null, "manifest.json", "");
      // Correct the provenance of the expected side of the accounting assertion.
      if (manifest) run.assertions.at(-1)!.evidence.push(e.ref("manifest.json"));
      check("scenario-results", Object.keys(result).length ? result.passed === true && host.harnessExitCode === 0 && !!scenarioResults?.length && scenarioResults.every(s => object(s).passed === true && array(object(s).failures)?.length === 0) : null,
        "Every selected scenario completed its assertions successfully.", ["run-result.json", hostFile]);
      if (result.passed === false) forceFailure = true;
    }
    setCount("dlqDeliveries", array(observations.dlq)?.length ?? null, "observations.json", "/dlq");
    check("empty-dlq", array(observations.dlq) ? array(observations.dlq)!.length === 0 : null, "No unexpected DLQ deliveries.", ["observations.json"]);
    for (const [index, scenario] of (scenarioResults ?? []).entries()) {
      const s = object(scenario);
      run.assertions.push({ id: `scenario-${string(s.name) ?? index}`, status: s.passed === true ? "passed" : s.passed === false ? "failed" : "unknown",
        description: `Raw harness outcome: ${string(s.name) ?? "unknown scenario"}.`, evidence: [e.ref("run-result.json", `/scenarios/${index}`)] });
    }
  } else if (phase === 4 || phase === 5) {
    const file = phase === 4 ? "recovery-state.json" : "load-state.json";
    const state = object(await e.read(file));
    const ledgerFile = phase === 4 ? "recovery-ledger.json" : "load-ledger.json";
    const ledger = await e.read(ledgerFile);
    const mode = string(host.mode) ?? string(metadata.mode) ?? string(state.poisonKind);
    const poison = phase === 5 && (mode === "malformed" || mode === "unsupported");
    run.expectedOutcome = poison ? "expected-failure" : phase === 4 ? "recovery" : mode === "workload" ? "replication-success" : "unknown";
    run.scenarioIds = phase === 4 ? ["crash-outage-repair", "emulator-loss"] : poison ? [mode!] : ["transactions-load"];
    const dlq = diagnostics(state, file);
    setCount("expectedQuarantines", phase === 4 ? count(state.expectedFailures) : poison ? 1 : 0, phase === 4 ? file : hostFile, phase === 4 ? "/expectedFailures" : "/mode");
    const checks = strings(state.checks);
    run.sequence = (checks ?? []).map((label, index) => ({ label, timestamp: null, evidence: [e.ref(file, `/checks/${index}`)] }));
    run.limitations.push("Recorded checks are an ordered sequence, not a timed recovery trace. Terminal host success attests to live assertions; importer does not rerun them.");
    if (poison) {
      const applied = idsFromLedger(ledger), expected = array(state.expected), ids = strings(state.identities);
      setCount("expectedEvents", expected?.length ?? null, file, "/expected");
      setCount("capturedEvents", ids ? new Set(ids).size : null, file, "/identities");
      setCount("appliedEvents", applied?.length ?? null, ledgerFile, "");
      const diagnostic = object(dlq?.[0]);
      const reason = string(diagnostic.reason) ?? "";
      check("poison-blocked", checks && dlq && applied && expected ? state.poisonKind === mode && checks.includes(`poison-${mode}`) &&
        checks.filter(c => c === "assert-blocked").length >= 3 && run.counts.uniqueQuarantines.value === 1 &&
        applied.length === expected.length && string(state.poisonPayload) !== null && object(diagnostic.delivery).payload === state.poisonPayload &&
        (mode === "malformed" ? diagnostic.eventID == null && reason.includes("dataCorrupted") : string(diagnostic.eventID) !== null && reason.includes("Expected DROP in supported DDL subset")) : null,
        "One expected poison diagnostic retains the input; restart and unfixed repair leave later progress blocked.", [file, ledgerFile, hostFile]);
      run.limitations.push("Expected events/applied ledger cover the positive baseline only. Captured identities can also include the rejected DDL and blocked following write; malformed bytes have no source identity.");
    } else {
      account(state, file, ledger, ledgerFile);
      if (phase === 4) {
        const quarantines = array(await e.read("recovery-quarantine.json"));
        check("recovery-coverage", hasChecks(state, ["assert-before-commit", "assert-after-commit", "assert-ddl", "write-outage", "write-capture-restart", "write-source-restart", "replay", "assert-quarantine-durable", "assert-duplicate-dlq", "assert-resources-lost"]),
          "Crash/outage/replay/publication/queue-loss checks were recorded.", [file]);
        check("repaired-quarantines", quarantines && dlq && checks ? state.expectedFailures === 2 && run.counts.uniqueQuarantines.value === 2 &&
          checks.filter(c => c === "fix-target").length === 2 && quarantines.length === 2 && quarantines.every(q => object(q).published === "1" && object(q).resolved === "1") : null,
          "Exactly two expected quarantines were published and resolved; duplicate identical diagnostics are allowed.", [file, "recovery-quarantine.json"]);
      } else {
        check("workload-coverage", hasChecks(state, ["setup", "backlog", "mark-recovery", "stream", "verify"]), "Transaction/rollback/rotation/backlog workload completed.", [file]);
        check("empty-dlq", dlq ? dlq.length === 0 : null, "Positive load run has no DLQ diagnostics.", [file]);
        const metricsRaw = await e.read("load-metrics.json"), metrics = object(metricsRaw);
        check("measurements", metricsRaw === undefined ? null : Object.keys(metricDefinitions).every(k => number(metrics[k]) !== null && number(metrics[k])! >= 0) &&
          metrics.expectedEvents === run.counts.expectedEvents.value, "Required performance measurements are finite, nonnegative and match event accounting.", ["load-metrics.json", file]);
        for (const [id, [unit, definition]] of Object.entries(metricDefinitions)) {
          const value = number(metrics[id]);
          if (value !== null && value >= 0) run.measurements.push({ id, value, unit, definition, evidence: [e.ref("load-metrics.json", `/${id}`)] });
        }
      }
    }
  } else check("adapter", null, "No recognized phase adapter.", []);

  // Link supporting evidence without embedding raw row data or logs in the
  // browser payload. Container inspections/environment dumps are never linked.
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    if (/^(?:[A-Za-z0-9_-]+-)?(?:schema|rows|diffs|inventory)\.json$/.test(entry.name) ||
        ["checkpoints.json", "ddl-journal.json", "expected-tables.json", "latency-samples-seconds.json", "memory-samples.log", "binlog-rotation.tsv", "startup.log", "harness.log", "probe.log", "recovery.log", "queue-loss.log", "target-outage.log", "compose.log"].includes(entry.name)) await e.link(entry.name);
  }
  const objectFiles = ["run-metadata.json", "host-result.json", "result.json", "suite-result.json", "configuration.json", "versions.json", "capture.json", "assertions.json", "recovery-assertions.json", "run-result.json", "observations.json", "recovery-state.json", "load-state.json", "load-metrics.json"];
  const arrayFiles = ["images.json", "replay.json", "expected-events.json", "audit.json", "ledger.json", "manifest.json", "recovery-ledger.json", "load-ledger.json", "recovery-quarantine.json"];
  for (const [name, data] of e.cache) {
    if (data === undefined) continue;
    if (objectFiles.includes(name) && (data === null || typeof data !== "object" || Array.isArray(data)) || arrayFiles.includes(name) && !Array.isArray(data)) e.issues.push(`${name}: invalid document shape`);
  }
  const exitCode = run.rawExitCodes.host.value;
  check("host-completed", terminal === undefined ? null : count(host.exitCode) !== null && host.phase === phase,
    "A valid terminal host result records this phase's completion.", [hostFile]);
  if (exitCode !== null && exitCode !== 0 || forceFailure) {
    run.verdict = "failed";
    run.failureKind = forceFailure ? "assertion" : phase === 3 && host.harnessExitCode === -1 && !Object.keys(result).length ? "startup" : "execution";
  } else if (e.issues.length || run.assertions.some(a => a.status === "unknown")) { run.verdict = "unknown"; run.failureKind = "evidence"; }
  else if (exitCode === null || run.assertions.some(a => a.status === "incomplete")) run.verdict = "incomplete";
  else run.verdict = "passed";
  run.evidence = e.refs;
  run.presentation = await presentation(e);
  run.verdictEvidence = [...new Map(run.assertions.flatMap(a => a.evidence).map(ref => [ref.path + ref.pointer, ref])).values()];
  if (metadata.state === "started" && terminal === undefined) run.limitations.push("Start metadata alone cannot prove the process is still running; shown as incomplete until a terminal result exists.");
  return run;
}

export async function importArtifacts(artifactRoot: string, generatedAt = new Date().toISOString()): Promise<Report> {
  const root = await realpath(artifactRoot);
  const entries = await readdir(root, { withFileTypes: true });
  const directories: string[] = [], discoveryIssues: string[] = [];
  if (entries.some(e => e.name === "capture.json" || e.name === "result.json")) directories.push(".");
  for (const entry of entries) {
    if (!/^maxwell-(?:phase[1-5]|e2e)-/.test(entry.name)) continue;
    if (!safeID(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) { discoveryIssues.push(`Skipped unsafe run entry: ${entry.name}`); continue; }
    directories.push(entry.name);
  }
  const runs: Run[] = [];
  for (const dir of directories.sort()) runs.push(await importRun(root, dir));
  const byID = new Map(runs.map(r => [r.id, r]));
  for (const run of runs) {
    const parent = run.relationships.parentSuiteId.value;
    if (parent && (!byID.has(parent) || byID.get(parent)!.kind !== "suite" || !byID.get(parent)!.relationships.children.value?.includes(run.id))) {
      run.issues.push("Parent suite is missing or does not explicitly list this child.");
      if (run.verdict === "passed") run.verdict = "unknown";
    }
    if (run.kind !== "suite" || run.relationships.children.value === null) continue;
    const children = run.relationships.children.value.map(id => byID.get(id));
    const required = ["scenario-assertions", "types-keys-ddl", "recovery", "malformed", "unsupported", "transactions-load"];
    const missing = children.some(c => !c) || children.length === 0;
    const conflicting = children.some(c => c && (c.kind === "suite" || c.relationships.parentSuiteId.value !== run.id));
    const gates = children.map(c => c?.relationships.gateId.value);
    const assertionRuns = children.filter(c => c?.relationships.gateId.value === "scenario-assertions");
    const coverage = children.length === 8 && required.every(gate => gates.filter(g => g === gate).length === (gate === "scenario-assertions" ? 3 : 1)) &&
      assertionRuns.some(c => ["append", "crud", "schema-change"].every(id => c!.scenarioIds.includes(id))) &&
      assertionRuns.some(c => c!.scenarioIds.includes("missing-event")) && assertionRuns.some(c => c!.scenarioIds.includes("wrong-value"));
    run.assertions.push({ id: "suite-children", status: missing ? "incomplete" : conflicting ? "unknown" : coverage && children.every(c => c!.verdict === "passed") ? "passed" : "incomplete",
      description: "Eight explicit child runs cover six gates, including smoke and both negative assertion checks; their outcomes remain independently inspectable.", evidence: run.relationships.children.evidence });
    run.verdictEvidence.push(...run.relationships.children.evidence);
    if (run.verdict === "passed") {
      if (children.some(c => c?.verdict === "failed")) { run.verdict = "failed"; run.failureKind = "execution"; }
      else if (conflicting || children.some(c => c?.verdict === "unknown")) run.verdict = "unknown";
      else if (missing || !coverage || children.some(c => c?.verdict !== "passed")) run.verdict = "incomplete";
    }
  }
  const verdicts = { passed: 0, failed: 0, incomplete: 0, unknown: 0 };
  for (const run of runs) verdicts[run.verdict]++;
  return { schemaVersion: 1, generatedAt, catalog, runs, discoveryIssues,
    summary: { runs: runs.filter(r => r.kind === "run").length, suites: runs.filter(r => r.kind === "suite").length, verdicts } };
}
