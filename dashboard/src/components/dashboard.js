import {el, add, heading, badge, table, bars} from "./ui.js";
import {orderedRuns, shown, memorySamples, latencyBins} from "./data.js";
import {architecture, evidence, link, valueText} from "./architecture.js";
import {stories, metricNames} from "./stories.js";
import {databaseView} from "./database.js";

export function navigation(current) {
  const nav = el("nav", undefined, "story-nav"); nav.setAttribute("aria-label", "POC pages");
  for (const [href, label] of [["/", "Introduction"], ...Object.values(stories).map(s => [s.path, s.title])]) {
    const a = link(label, href); if (href === current) a.setAttribute("aria-current", "page"); add(nav, a);
  }
  return nav;
}
function list(parent, texts) { add(parent, add(el("ol", undefined, "procedure"), ...texts.map(text => el("li", text)))); }
function evidenceRefs(refs) { return add(el("div", undefined, "refs"), ...refs.map(ref => evidence(ref))); }
function disclosure(title, ...contents) { return add(el("details"), el("summary", title), ...contents); }

export async function mount(root, phase) {
  root.className = "dashboard narrative";
  const story = stories[phase];
  add(root, navigation(story.path), el("p", `MYSQL THIRD-PARTY REPLICATION POC · PHASE ${phase}`, "eyebrow"), el("h1", story.title), el("p", story.question, "lead"), el("p", story.summary));
  const command = add(el("section", undefined, "run-command"), el("h2", "Run this test"), el("p", story.commandDescription), add(el("pre"), el("code", story.command)), el("p", "Then run make dashboard-data and reload this page to select the new results.", "small"));
  command.setAttribute("aria-label", "Run this test"); add(root, command);
  try {
    const response = await fetch("/api/report");
    if (!response.ok) throw new Error("The report is not available. Run make dashboard-data and reload this page.");
    const report = await response.json();
    const runs = orderedRuns(report.runs.filter(r => r.phase === phase && r.kind === "run"));
    if (!runs.length) {
      add(root, el("p", "No individual runs have been recorded for this test."), add(el("article", undefined, "dlq-card"), el("h2", "Dead-letter queue (DLQ)"), el("p", "DLQ deliveries: Not recorded")));
      root.dataset.ready = "true"; return;
    }
    const requested = new URLSearchParams(location.search).get("run");
    let pinned; try { pinned = localStorage.getItem(`baseline-phase-${phase}`); } catch { /* optional storage */ }
    let selected = runs.find(r => r.id === requested) ?? runs.find(r => r.id === pinned) ?? runs[0];
    const controls = el("div", undefined, "run-controls");
    const label = el("label", "Test run"), selector = el("select"); selector.setAttribute("aria-label", "Test run");
    for (const run of runs) { const option = el("option", `${run.id} · ${run.verdict}`); option.value = run.id; add(selector, option); }
    add(controls, add(label, selector));
    const pin = el("button", "Pin this run"), latest = el("button", "Latest dated attempt");
    latest.disabled = !Number.isFinite(Date.parse(runs[0].startedAt.value));
    add(controls, pin, latest); add(root, controls);
    if (requested && !runs.some(r => r.id === requested)) add(root, el("p", "The requested run is not an individual run for this page. Showing the page's default selection.", "notice"));
    if (runs.some(r => !r.startedAt.value)) add(root, el("p", "Runs are ordered by recorded date; undated runs follow by ID.", "small muted"));
    const view = el("div"); add(root, view);
    let generation = 0;
    selector.onchange = () => { selected = runs.find(r => r.id === selector.value); void render(); };
    latest.onclick = () => { selected = runs[0]; void render(); };
    pin.onclick = () => {
      pinned = pinned === selected.id ? null : selected.id;
      try { if (pinned) localStorage.setItem(`baseline-phase-${phase}`, pinned); else localStorage.removeItem(`baseline-phase-${phase}`); } catch { /* optional storage */ }
      void render();
    };

    async function render() {
      const token = ++generation, run = selected;
      root.dataset.ready = "false";
      selector.value = run.id; pin.textContent = pinned === run.id ? "Unpin this run" : "Pin this run";
      const url = new URL(location.href); url.searchParams.set("run", run.id); history.replaceState(null, "", url);
      view.replaceChildren();
      const status = el("div", undefined, "run-result");
      add(status, badge(run.verdict), el("span", run.id, "run-id"));
      add(view, status, el("p", `Started: ${valueText(run.startedAt.value)} · Finished: ${valueText(run.finishedAt.value)}`, "small muted"));
      if (pinned) add(view, el("p", `Pinned run for this page: ${pinned}. This page opens with that run selected.`, "small"));
      const graph = el("div"); add(view, graph);
      let memory = [], sampleIssue = null;
      const memoryRef = run.evidence.find(r => r.path.endsWith("memory-samples.log"));
      if (memoryRef) {
        try { const response = await fetch(`/api/evidence?path=${encodeURIComponent(memoryRef.path)}`); if (!response.ok) throw new Error(); memory = memorySamples(await response.text()); }
        catch { sampleIssue = "Memory samples could not be read. Memory values are shown as not recorded."; }
      }
      if (token !== generation) return;
      const databases = databaseView(run), databaseSummary = databases.querySelector("summary");
      add(graph, architecture(run, memory, databaseSummary ? () => {
        databaseSummary.parentElement.open = true;
        databaseSummary.focus(); databaseSummary.scrollIntoView({block: "start"});
      } : undefined));
      if (sampleIssue) add(view, el("p", sampleIssue, "notice"));
      const timing = run.measurements.filter(m => ["backlogRecoverySeconds", "latencyP95Seconds", "streamEventsPerSecond"].includes(m.id));
      if (timing.length) {
        const strip = el("section", undefined, "timing-strip");
        add(strip, el("h3", "Time across the whole pipeline"), el("p", "End-to-end measurements for this workload, including backlog recovery and polling time.", "small"));
        for (const m of timing) add(strip, el("p", `${metricNames[m.id]}: ${shown(m.value)} ${m.unit}`), evidenceRefs(m.evidence));
        add(view, strip);
      }

      add(view, databases);
      heading(view, "What the test does"); list(view, story.steps);
      const selectedScenarios = report.catalog.filter(s => run.scenarioIds.includes(s.id));
      for (const scenario of selectedScenarios) {
        add(view, add(el("article", undefined, "selected-experiment"), el("h3", `Selected experiment: ${scenario.title}`), el("p", scenario.action), el("p", `Expected: ${scenario.expected}`)));
      }
      const sourceLinks = add(el("div", undefined, "refs"), ...story.sources.map(path => {
        const a = link(path, `/api/source?path=${encodeURIComponent(path)}`); a.target = "_blank"; a.rel = "noopener"; return a;
      }));
      add(view, disclosure("Test script and harness code", el("p", "Current project files."), sourceLinks));

      heading(view, "How the results are checked"); list(view, story.verification);
      heading(view, "Results for the selected run");
      const summary = run.verdict !== "passed" ? `This run ${run.verdict === "failed" ? "failed" : "cannot yet be verified"}. Review the recorded checks and missing evidence below.` :
        run.expectedOutcome === "expected-failure" ? phase === 3 ? "The verifier detected the deliberately introduced error. The harness self-test passed." : "The expected failure was confirmed. The consumer retained the blocked event and held later changes. Applying that event requires a repair." :
        phase === 4 ? "The recovery checks passed. The final emulator-loss check confirmed that replication stops visibly when broker resources disappear." : "The selected replication checks passed.";
      add(view, el("p", summary, run.verdict === "passed" ? "result-summary" : "notice"));
      add(view, table(["Check", "Recorded value", "Evidence"], Object.entries(run.counts).map(([id, fact]) => [({expectedEvents: "Expected events", capturedEvents: "Captured unique events", appliedEvents: "Applied events", dlqDeliveries: "DLQ deliveries", uniqueQuarantines: "Unique failures", expectedQuarantines: "Expected failures"})[id], valueText(fact.value), evidenceRefs(fact.evidence)]), "Recorded result counts"));
      if (phase === 5 && run.expectedOutcome === "expected-failure") add(view, el("p", "Expected and applied counts cover the valid baseline. Captured events can also include the rejected schema change and the later blocked write.", "small"));
      add(view, disclosure("Recorded assertions and raw exit codes", el("p", `Host exit: ${valueText(run.rawExitCodes.host.value)}; harness exit: ${valueText(run.rawExitCodes.harness.value)}; failure code: ${valueText(run.failureCode.value)}.`), table(["Result", "Check", "Evidence"], run.assertions.map(a => [badge(a.status), a.description, evidenceRefs(a.evidence)]), "Recorded assertions")));
      const differences = run.evidence.filter(r => /(?:schema|rows|diffs)\.json$/.test(r.path));
      if (differences.length) add(view, disclosure("Schema and row comparison evidence", evidenceRefs(differences)));
      if (run.sequence.length) {
        const sequence = add(el("ol", undefined, "sequence"), ...run.sequence.map(s => add(el("li"), el("span", s.label), evidenceRefs(s.evidence))));
        add(view, disclosure("Recorded action sequence", sequence));
      }

      if (run.measurements.length) {
        heading(view, "Timing and load measurements", "Measurements from this local test run.");
        const rates = run.measurements.filter(m => m.unit === "events/second");
        if (rates.length) add(view, bars("Observed processing rates", rates.map(m => ({label: m.id.startsWith("backlog") ? "Backlog recovery" : "Continuing writes", value: m.value})), "events/second"));
        const samples = run.evidence.find(r => r.path.endsWith("latency-samples-seconds.json"));
        if (samples) {
          try {
            const response = await fetch(`/api/evidence?path=${encodeURIComponent(samples.path)}`); if (!response.ok) throw new Error();
            const values = await response.json(); if (token !== generation) return;
            add(view, bars("End-to-end latency distribution", latencyBins(values), "samples"), el("p", `${values.length} recorded samples; ranges are seconds. The final range includes its upper boundary.`, "small"), evidence(samples));
          } catch { if (token === generation) add(view, el("p", "Latency samples could not be read.", "notice")); }
        }
        add(view, disclosure("All measurement values and definitions", table(["Measurement", "Value", "Definition", "Evidence"], run.measurements.map(m => [metricNames[m.id] ?? m.id, `${shown(m.value)} ${m.unit}`, m.definition, evidenceRefs(m.evidence)]), "Measurement definitions")));
      }
      if (token !== generation) return;
      if (memory.length) add(view, disclosure("Recorded memory samples", el("p", "Memory is sampled for Maxwell and the Swift consumer. MiB = 1,048,576 bytes. Each peak is the largest recorded sample."), table(["Timestamp (UTC)", "Service", "MiB"], memory.map(s => [s.timestamp, s.service, shown(s.value)]), "Memory samples")));
      for (const issue of [...run.issues, ...(run.presentation?.issues ?? [])]) add(view, el("p", issue, "notice"));
      const settings = Object.fromEntries(Object.entries({configuration: run.configuration.value, versions: run.versions.value}).filter(([, value]) => value != null));
      if (Object.keys(settings).length) add(view, disclosure("Test settings", el("pre", JSON.stringify(settings, null, 2))));
      const siblings = Object.values(stories), index = siblings.indexOf(story);
      const next = el("nav", undefined, "page-navigation"); next.setAttribute("aria-label", "Presentation sequence");
      add(next, link(index ? `← ${siblings[index - 1].title}` : "← Introduction", index ? siblings[index - 1].path : "/"));
      if (index < siblings.length - 1) add(next, link(`Next: ${siblings[index + 1].title} →`, siblings[index + 1].path));
      add(view, next); root.dataset.ready = "true";
    }
    await render();
  } catch (error) { add(root, el("p", error.message, "notice")); }
}
