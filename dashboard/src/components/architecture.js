import {el, add} from "./ui.js";
import {shown} from "./data.js";

export const valueText = value => value == null ? "Not recorded" : shown(value);
export function link(text, href) { const a = el("a", text); a.href = href; return a; }
export function evidence(ref, label) {
  const a = link(label ?? ref.path.split("/").at(-1), `/api/evidence?path=${encodeURIComponent(ref.path)}`);
  a.target = "_blank"; a.rel = "noopener"; return a;
}
function stat(node, label, value, unit = "") {
  const p = el("p", undefined, "node-stat"); add(p, el("span", label), el("strong", `${valueText(value)}${value == null ? "" : unit}`)); add(node, p);
}

export function architecture(run, memory = []) {
  const diagram = el("section", undefined, "run-architecture"); diagram.setAttribute("aria-label", "Recorded replication architecture");
  add(diagram, el("h2", "What happened in this run"));
  const pipeline = el("div", undefined, "pipeline");
  const names = [["mysql84", "Source database", "MySQL 8.4"], ["maxwell", "Maxwell daemon", "Reads the source binlog"], ["pubsub", "Pub/Sub emulator", "Delivers change events"], ["consumer", "Swift MySQL consumer", "Applies changes in order"], ["mysql57", "Target database", "MySQL 5.7"]];
  const data = run.presentation;
  for (const [index, [service, title, role]] of names.entries()) {
    const card = el("article", undefined, "service-card"); card.dataset.service = service;
    add(card, el("span", String(index + 1).padStart(2, "0"), "step-number"), el("h3", title), el("p", role, "service-role"));
    if (service === "mysql84") stat(card, "Expected events", run.counts.expectedEvents.value);
    if (service === "pubsub") stat(card, "Captured unique events", run.counts.capturedEvents.value);
    if (service === "mysql57") {
      stat(card, "Applied events", run.counts.appliedEvents.value);
      add(card, el("p", "Replicated application schemas and tables", "storage-label"));
      if (data?.tables?.length) add(card, ...data.tables.map(name => el("p", name, "small")));
      const schemas = run.evidence.filter(ref => /schema\.json$/.test(ref.path));
      if (schemas.length) { const d = el("details"); add(d, el("summary", "Recorded table schemas"), ...schemas.map(ref => evidence(ref))); add(card, d); }
      add(card, el("p", "cdc_meta.applied_events", "storage-label"), el("p", "The applied-event record for each change. Checkpoints, schema-change journal and quarantine are also stored in cdc_meta.", "small"));
    }
    if (service === "consumer" || service === "maxwell") {
      const samples = memory.filter(s => s.service === service);
      stat(card, "Peak sampled memory", samples.length ? samples.reduce((max, s) => Math.max(max, s.value), 0) : null, " MiB");
      const ref = run.evidence.find(r => r.path.endsWith("memory-samples.log"));
      if (ref) add(card, evidence(ref, "Memory samples"));
    }
    const snapshot = data?.containers.find(c => c.service === service);
    if (snapshot) {
      const details = el("details"); add(details, el("summary", "Container details"));
      if (snapshot.name) add(details, el("p", snapshot.name));
      if (snapshot.image) add(details, el("p", snapshot.image));
      if (snapshot.state) add(details, el("p", `State when captured: ${snapshot.state}`));
      if (snapshot.dockerRestarts != null) add(details, el("p", `Docker automatic restarts: ${snapshot.dockerRestarts}`));
      add(details, el("p", `Source: ${snapshot.source}`)); add(card, details);
    }
    if (run.evidence.some(r => r.path.endsWith("/compose.log"))) {
      const log = link("Service log", `/api/service-log?run=${encodeURIComponent(run.id)}&service=${service}`); log.target = "_blank"; log.rel = "noopener"; add(card, log);
    }
    add(pipeline, card);
  }
  add(diagram, pipeline);
  const branch = el("div", undefined, "diagnostic-branch");
  add(branch, el("p", "Swift consumer ↓ publishes failure diagnostics to the Pub/Sub DLQ", "branch-label"));
  const dlq = el("article", undefined, "dlq-card"); dlq.dataset.component = "dlq";
  add(dlq, el("h3", "Dead-letter queue (DLQ)"));
  stat(dlq, "DLQ deliveries", run.counts.dlqDeliveries.value);
  stat(dlq, "Unique failures", run.counts.uniqueQuarantines.value);
  stat(dlq, "Expected failures", run.counts.expectedQuarantines.value);
  add(dlq, el("p", "Repeated deliveries may describe the same failure.", "small"));
  for (const ref of run.counts.dlqDeliveries.evidence) add(dlq, evidence(ref, "DLQ evidence"));
  add(branch, dlq); add(diagram, branch);
  if (data?.events) {
    const events = data.events;
    const breakdown = el("div", undefined, "event-breakdown");
    add(breakdown, el("h3", events.basis));
    for (const [label, value] of [["Row-change events", events.rowChanges], ["Schema-change events", events.schemaChanges], ["Other event types", events.otherEvents], ["Unreadable payloads in this list", events.invalidPayloads]]) stat(breakdown, label, value);
    add(breakdown, el("p", "Includes test setup and marker events.", "small"), evidence({path: events.source}, "Event list")); add(diagram, breakdown);
  }
  const harness = el("div", undefined, "harness-strip");
  add(harness, el("h3", "Swift test harness · e2e container"), el("p", "Writes to the source → observes events and the DLQ → checks the target → saves results"), el("code", `artifacts/${run.artifactDirectory}/`)); add(diagram, harness);
  return diagram;
}
