import {shown, orderedRuns, comparisonWarnings, latencyBins, memorySamples} from "./data.js";

// Artifact strings only enter text nodes. Never interpolate evidence into HTML.
export function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function add(parent, ...children) { parent.append(...children); return parent; }
export function heading(parent, title, description) { add(parent, el("h2", title)); if (description) add(parent, el("p", description, "muted")); }
export function badge(verdict) { return el("span", verdict, `badge ${verdict}`); }
export function table(headers, rows, label) {
  const wrap = el("div", undefined, "table-wrap"), t = el("table", undefined, headers.length > 2 ? "stack-narrow" : undefined);
  t.setAttribute("aria-label", label);
  add(t, add(el("thead"), add(el("tr"), ...headers.map(h => el("th", h)))));
  const body = el("tbody");
  for (const row of rows) add(body, add(el("tr"), ...row.map((value, i) => {
    const cell = add(el("td"), value instanceof Node ? value : document.createTextNode(shown(value)));
    cell.dataset.label = headers[i]; return cell;
  })));
  add(t, body); return add(wrap, t);
}
function button(text, action) { const b = el("button", text); b.type = "button"; b.onclick = action; return b; }
function select(label, options, value, change) {
  const wrap = el("label", label), control = el("select");
  control.setAttribute("aria-label", label);
  for (const [id, title] of options) { const option = el("option", title); option.value = id; control.append(option); }
  control.value = value; control.onchange = () => change(control.value);
  return add(wrap, control);
}
export function bars(title, values, unit) {
  const section = el("section", undefined, "chart");
  add(section, el("h3", title));
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 640 ${values.length * 36 + 34}`);
  svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `${title}; values in the accompanying table`);
  const max = Math.max(1, ...values.map(d => d.value));
  values.forEach((d, i) => {
    const label = document.createElementNS(ns, "text"); label.setAttribute("x", "0"); label.setAttribute("y", String(i * 36 + 22)); label.textContent = d.label; svg.append(label);
    const rect = document.createElementNS(ns, "rect"); rect.setAttribute("x", "175"); rect.setAttribute("y", String(i * 36 + 5)); rect.setAttribute("width", String(d.value / max * 365)); rect.setAttribute("height", "23"); rect.setAttribute("rx", "3"); svg.append(rect);
    const number = document.createElementNS(ns, "text"); number.setAttribute("x", "552"); number.setAttribute("y", String(i * 36 + 22)); number.textContent = shown(d.value); svg.append(number);
  });
  add(section, svg, table(["Measurement", unit], values.map(d => [d.label, d.value]), title));
  return section;
}
const countLabels = {expectedEvents: "Expected events", capturedEvents: "Captured events", appliedEvents: "Applied events", dlqDeliveries: "DLQ deliveries", uniqueQuarantines: "Unique quarantines", expectedQuarantines: "Expected quarantines"};
const tabs = ["Overview", "Scenario", "Recovery", "Performance", "History"];

export async function mount(root) {
  root.className = "dashboard";
  try {
    const response = await fetch("/api/report");
    if (!response.ok) throw new Error("Report unavailable. Run make dashboard-data and reload.");
    const report = await response.json();
    const runs = orderedRuns(report.runs);
    if (!runs.length) { root.append(el("h1", "No runs yet"), el("p", "Run a POC scenario, then make dashboard-data and reload.")); return; }
    const params = new URLSearchParams(location.search);
    let pinned = null;
    try { pinned = localStorage.getItem("reviewed-baseline"); } catch { /* storage optional */ }
    let selected = runs.find(r => r.id === params.get("run")) ?? runs.find(r => r.id === pinned) ?? runs[0];
    let active = tabs.includes(params.get("view")) ? params.get("view") : "Overview";
    let compareId = runs.find(r => r.id !== selected.id)?.id ?? selected.id;
    let generation = 0;

    function evidenceLink(ref) {
      const a = el("a", ref.path.split("/").at(-1) + (ref.pointer || ""));
      a.href = `/api/evidence?path=${encodeURIComponent(ref.path)}#${encodeURIComponent(ref.pointer)}`;
      a.target = "_blank"; a.rel = "noopener";
      a.setAttribute("aria-label", `Evidence ${ref.path}${ref.pointer}`);
      return a;
    }
    function refs(evidence) {
      return add(el("div", undefined, "refs"), ...evidence.map(evidenceLink));
    }
    function facts(value) { return el("pre", value === null ? "Unavailable" : JSON.stringify(value, null, 2)); }
    function choose(id) { selected = runs.find(r => r.id === id); render(); }
    function render() {
      const token = ++generation;
      const run = selected;
      const url = new URL(location.href); url.searchParams.set("run", run.id); url.searchParams.set("view", active); history.replaceState(null, "", url);
      root.replaceChildren();
      const hero = el("header", undefined, "hero");
      const back = el("a", "Return to the POC introduction"); back.href = "/";
      add(hero, back, el("h1", "Detailed test evidence"), el("p", "Inspect recorded assertions, measurements and source files.", "architecture"));
      add(root, hero);
      const controls = el("div", undefined, "controls");
      add(controls, select("Selected run", runs.map(r => [r.id, `${r.id} · ${r.verdict}`]), run.id, choose));
      add(controls, button(pinned === run.id ? "Unpin baseline" : "Pin reviewed baseline", () => {
        pinned = pinned === run.id ? null : run.id;
        try { if (pinned) localStorage.setItem("reviewed-baseline", pinned); else localStorage.removeItem("reviewed-baseline"); } catch { /* storage optional */ }
        render();
      }));
      const latest = button("Latest dated attempt", () => { choose(runs[0].id); });
      latest.disabled = !Number.isFinite(Date.parse(runs[0].startedAt.value));
      if (latest.disabled) latest.title = "No recorded start dates; undated attempts are listed by ID.";
      add(controls, latest);
      add(root, controls);
      const status = el("section", undefined, "status-card");
      add(status, add(el("div", undefined, "status-line"), badge(run.verdict), el("span", `Phase ${shown(run.phase)} · ${run.kind} · ${run.expectedOutcome}`)), el("h2", run.id));
      add(status, el("p", `Started: ${shown(run.startedAt.value)} · Finished: ${shown(run.finishedAt.value)}`, "muted"));
      add(status, el("p", `Report generated: ${report.generatedAt}. Manual refresh: make dashboard-data, then reload.`, "muted"));
      if (pinned) add(status, el("p", `Reviewed baseline pinned: ${pinned}. Pinning is a viewing preference, not a test verdict.`, "notice"));
      if (runs.some(r => !r.startedAt.value)) add(status, el("p", "Legacy dates are unavailable. Latest means latest recorded start time; undated runs cannot be placed chronologically.", "notice"));
      if (run.expectedOutcome === "expected-failure") add(status, el("p", run.verdict === "passed" ? "Expected failure verified — the negative-test gate passed. This does not mean successful replication." : "Expected failure was NOT verified. Inspect the failed or missing assertions.", "notice"));
      if (run.failureKind || run.failureCode.value) add(status, el("p", `Failure: ${shown(run.failureKind)} / ${shown(run.failureCode.value)}`, "notice"), refs(run.failureCode.evidence));
      add(root, status);
      const nav = el("nav", undefined, "tabs"); nav.setAttribute("aria-label", "Report views");
      for (const tab of tabs) { const b = button(tab, () => { active = tab; render(); }); b.setAttribute("aria-current", tab === active ? "page" : "false"); add(nav, b); }
      add(root, nav);
      const content = el("section", undefined, "view"); content.dataset.view = active; add(root, content);

      if (active === "Overview") {
        heading(content, "The result, in context", "All counts below belong to this selection. Suite events are not summed from repeated child workloads.");
        const metrics = el("div", undefined, "metrics");
        for (const id of ["expectedEvents", "capturedEvents", "appliedEvents", "dlqDeliveries"]) {
          const card = el("div", undefined, "metric"); card.dataset.metric = id;
          add(card, el("span", countLabels[id]), el("strong", shown(run.counts[id].value)), refs(run.counts[id].evidence)); add(metrics, card);
        }
        add(content, metrics);
        heading(content, "What this run covers");
        add(content, table(["Scenario", "Question"], run.scenarioIds.map(id => { const s = report.catalog.find(s => s.id === id); return [s?.title ?? id, s?.question ?? "Unavailable"]; }), "Scenario coverage"));
        heading(content, "Tested versions"); add(content, facts(run.versions.value), refs(run.versions.evidence));
        const images = el("details"); add(images, el("summary", "Image and platform evidence"), facts(run.images.value), refs(run.images.evidence)); add(content, images);
        heading(content, "Boundaries of this proof");
        add(content, el("p", "Local emulator, serial event application, supported DDL subset. MySQL 5.7 is a compatibility target. Source transactions are not applied atomically as whole transactions. Emulator queue loss requires reseeding; this is not a durable broker test."));
        add(content, el("p", "DLQ delivery counts can include duplicate diagnostics. An empty DLQ alone does not prove complete replication."));
        for (const message of [...run.limitations, ...run.issues, ...report.discoveryIssues]) add(content, el("p", message, "notice"));
      }
      if (active === "Scenario") {
        heading(content, "What did we ask the system to prove?");
        for (const id of run.scenarioIds) {
          const s = report.catalog.find(s => s.id === id); if (!s) continue;
          const story = el("article", undefined, "story");
          add(story, el("h3", s.title), el("p", s.question), el("h4", "Action"), el("p", s.action), el("h4", "Expected"), el("p", s.expected), el("h4", "Observed"), el("p", `Test gate: ${run.verdict}. Expected outcome: ${run.expectedOutcome}. Raw host exit: ${shown(run.rawExitCodes.host.value)}; harness exit: ${shown(run.rawExitCodes.harness.value)}.`)); add(content, story);
        }
        if (!run.scenarioIds.length) add(content, el("p", "Scenario unavailable; inspect startup and host evidence."));
        heading(content, "Assertions", "Raw assertions remain visible, even when a matching expected failure passes the outer test gate.");
        add(content, table(["Result", "Assertion", "Evidence"], run.assertions.map(a => [badge(a.status), `${a.id}: ${a.description}`, refs(a.evidence)]), "Assertions"));
        add(content, refs(run.verdictEvidence));
      }
      if (active === "Recovery") {
        heading(content, "Account for every event", "Diagnostic deliveries are not unique failures. Missing evidence is unavailable, never zero.");
        add(content, table(["Count", "Value", "Evidence"], Object.entries(run.counts).map(([id, fact]) => [countLabels[id], fact.value, refs(fact.evidence)]), "Event accounting"));
        const known = ["expectedEvents", "capturedEvents", "appliedEvents"].filter(id => run.counts[id].value !== null);
        if (known.length) add(content, bars("Event counts", known.map(id => ({label: countLabels[id], value: run.counts[id].value})), "events"));
        heading(content, "Schema and row differences", "Open the recorded schemas, rows and diffs. No diff artifact means unavailable, not an assumed match.");
        const diffs = run.evidence.filter(ref => /(?:schema|rows|diffs)\.json$/.test(ref.path));
        add(content, diffs.length ? refs(diffs) : el("p", "Schema / row comparison artifacts unavailable."));
        heading(content, "Restart and repair sequence", "Recorded order only — these checks have no timestamps. Spacing does not represent elapsed time.");
        const sequence = el("ol", undefined, "sequence");
        for (const check of run.sequence) add(sequence, add(el("li"), el("span", check.label), refs(check.evidence)));
        add(content, run.sequence.length ? sequence : el("p", "Recovery sequence unavailable."));
        for (const a of run.assertions.filter(a => /quarantine|dlq/.test(a.id))) add(content, add(el("p"), badge(a.status), el("span", ` ${a.description}`)), refs(a.evidence));
      }
      if (active === "Performance") {
        heading(content, "Performance, with its conditions", "Observational latency includes backlog and polling overhead. Debug / emulated local runs are not production throughput or latency guarantees.");
        add(content, table(["Measurement", "Value", "Unit / definition", "Evidence"], run.measurements.map(m => [m.id, m.value, `${m.unit} — ${m.definition}`, refs(m.evidence)]), "Performance measurements"));
        if (!run.measurements.length) add(content, el("p", "Performance measurements unavailable for this run."));
        const rates = run.measurements.filter(m => m.unit === "events/second");
        if (rates.length) add(content, bars("Observed processing rates", rates.map(m => ({label: m.id.startsWith("backlog") ? "Backlog recovery" : "Streaming", value: m.value})), "events/second"));
        const samples = el("div"); add(content, samples);
        void renderSamples(samples, run, token);
      }
      if (active === "History") {
        heading(content, "Run history", "Each row is one attempt or suite; no cross-run event totals. Dated attempts are newest first; undated legacy attempts follow by ID.");
        add(content, table(["Run", "Phase", "Started (UTC)", "Result"], runs.map(r => [button(r.id, () => choose(r.id)), r.phase, r.startedAt.value, badge(r.verdict)]), "Run history"));
        heading(content, "Compare a second run");
        add(content, select("Compare with", runs.map(r => [r.id, r.id]), compareId, id => { compareId = id; render(); }));
        const other = runs.find(r => r.id === compareId);
        for (const warning of comparisonWarnings(run, other)) add(content, el("p", warning, "notice"));
        add(content, table(["Measurement", run.id, other.id], [...new Set([...run.measurements, ...other.measurements].map(m => m.id))].map(id => [id, run.measurements.find(m => m.id === id) ? `${shown(run.measurements.find(m => m.id === id).value)} ${run.measurements.find(m => m.id === id).unit}` : "Unavailable", other.measurements.find(m => m.id === id) ? `${shown(other.measurements.find(m => m.id === id).value)} ${other.measurements.find(m => m.id === id).unit}` : "Unavailable"]), "Run comparison"));
        heading(content, "Configuration and provenance"); add(content, facts(run.configuration.value), refs(run.configuration.evidence), facts(run.code.value), refs(run.code.evidence));
        heading(content, "Suite membership", "Members are referenced, not added to suite totals.");
        const children = run.relationships.children.value;
        add(content, children ? add(el("div", undefined, "refs"), ...children.map(id => runs.some(r => r.id === id) ? button(id, () => choose(id)) : el("span", `${id} — evidence unavailable`))) : el("p", "Explicit child membership unavailable."));
        if (run.relationships.parentSuiteId.value) add(content, el("p", `Parent suite: ${run.relationships.parentSuiteId.value}; gate: ${shown(run.relationships.gateId.value)}`));
      }
      const evidence = el("details", undefined, "evidence");
      add(evidence, el("summary", `Supporting evidence (${run.evidence.length} files; local-only)`), el("p", "Read-only plain text. Raw payloads may contain test data; do not share without review."), refs(run.evidence)); add(content, evidence);
      root.dataset.ready = "true";
    }
    async function renderSamples(target, run, token) {
      for (const [file, title] of [["latency-samples-seconds.json", "Latency distribution"], ["memory-samples.log", "Sampled memory"]]) {
        const ref = run.evidence.find(r => r.path.endsWith(`/${file}`) || r.path === file);
        if (!ref) { add(target, el("h3", title), el("p", "Samples unavailable.")); continue; }
        try {
          const response = await fetch(`/api/evidence?path=${encodeURIComponent(ref.path)}`);
          if (!response.ok) throw new Error("Samples could not be read");
          const text = await response.text();
          if (token !== generation) return;
          if (file.endsWith(".json")) {
            const samples = JSON.parse(text);
            add(target, bars(title, latencyBins(samples), "samples"), el("p", `${samples.length} latency samples; equal-width bins in seconds, final bin inclusive.`), refs([ref]));
          } else {
            const samples = memorySamples(text);
            const services = [...new Set(samples.map(s => s.service))];
            add(target, bars("Peak sampled memory", services.map(service => ({label: service, value: samples.filter(s => s.service === service).reduce((max, s) => Math.max(max, s.value), 0)})), "MiB"));
            add(target, el("p", `${samples.length} Docker memory samples. MiB = 1,048,576 bytes. Peaks are sampled, not process-lifetime high-water marks.`), refs([ref]));
            const details = el("details"); add(details, el("summary", "Timestamped memory samples"), table(["UTC timestamp", "Service", "MiB"], samples.map(s => [s.timestamp, s.service, s.value]), "Memory samples")); add(target, details);
          }
        } catch (error) { if (token === generation) add(target, el("h3", title), el("p", `Unavailable: ${error.message}`, "notice"), refs([ref])); }
      }
      if (token === generation) target.dataset.samplesReady = "true";
    }
    render();
  } catch (error) { root.replaceChildren(el("h1", "Reporting error"), el("p", error.message)); }
}
