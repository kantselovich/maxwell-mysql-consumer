# POC results dashboard

## Outcome and scope

Present the MySQL replication POC as an interactive report: explain each test in plain language, show its actual evidence, and make new results available after rerunning an existing phase/scenario command.

Use Observable Framework for the presentation, with a small TypeScript artifact importer. Keep the Swift replication application unchanged. The dashboard is local and read-only, works after test containers shut down, and can be built as a shareable static report. Browser-triggered test execution and continuous production monitoring are out of scope.

```text
Existing test commands → artifacts/ → normalized reporting data → dashboard
                                           ↑
                                  artifact watcher
```

Raw artifacts remain the source of truth. Generated reporting data is disposable and excluded from Git; dashboard code, test descriptions and small importer fixtures are checked in. Serve locally on localhost, without a Docker socket or database credentials. Containerize dashboard tooling separately so viewing results does not start the replication stack.

## Phase 1 — Normalize the evidence

Implemented locally on 2026-09-28. See [Phase 1 results](DASHBOARD_PHASE_1_RESULTS.md) and the [reporting format/commands](../dashboard/README.md). `make dashboard-data` and `make dashboard-data-test` are available; UI and browser tests remain in the following phases.

- Define a versioned reporting format: run ID, phase/scenario, suite relationships, configuration, available timestamps/code/image versions, expected outcome, actual outcome, assertion results, measurements and evidence links.
- Import the existing Phase 1–5 artifacts, including smoke tests, recovery tests, negative self-tests and load runs. Preserve the distinction between a phase suite and its child runs; do not count their events twice.
- Keep raw exit codes separate from the test verdict. An expected failure passes only when its specific assertions were verified. A DLQ record is not automatically a failure or a successful replication.
- Represent failed, incomplete and unknown results explicitly. Missing evidence is never a pass; unavailable historical metadata stays unavailable. Do not infer success from logs containing a `PASS` line alone.
- Add a small scenario catalog with stable IDs and plain-language descriptions: what we are testing, what we do, what should happen, and which evidence establishes the result.
- Add lightweight run metadata and explicit suite/child IDs to future harness output where needed. Import legacy evidence conservatively without modifying it.
- Prepare small deterministic artifact fixtures and independently specified expected results for importer and Playwright tests. Include passing runs, validated negative tests, unexpected failures, incomplete/corrupt evidence and load measurements.

**Exit gate:** Import representative runs from every phase. Automated fixture tests correctly distinguish positive success, validated expected failure, unexpected failure, startup failure and missing/corrupt evidence. Every displayed result can be traced to its source artifacts.

## Phase 2 — Build the narrative dashboard

Reviewed and committed as `35c1428` on 2026-09-28. See [Phase 2 results](DASHBOARD_PHASE_2_RESULTS.md). `make dashboard-view` starts the manual-refresh viewer, and `make dashboard-test` runs the data/visual browser gate. Watcher/export remain Phase 3.

Provide these views:

| View | Content |
| --- | --- |
| Overview | Architecture, tested versions, phase/scenario coverage, results and known limitations |
| Scenario detail | Plain-language test story, expected versus observed behavior, assertions and supporting evidence |
| Correctness and recovery | Expected/captured/applied counts, schema/row differences, restart/repair sequence, expected and unexpected quarantines |
| Performance | Available latency distribution, throughput, backlog recovery and sampled memory, with units and measurement definitions |
| Run history | Run selection, configuration, evidence links and comparison of compatible runs |

- Default to the latest attempt, including failures, with an option to pin a reviewed baseline. Show run ID and data freshness clearly; never silently substitute an older passing run.
- Scope summaries to the selected run or suite. If an overview combines phases from different runs, label each source run and date explicitly.
- Use charts only where the evidence supports them. Historical recovery checks without timestamps become an ordered sequence, not an invented timed chart. Missing measurements display as unavailable, not zero.
- Label load latency as observational latency including backlog/polling overhead. Warn when comparing runs with different workload sizes, pacing, versions or environments.
- Keep large payloads/logs behind drill-down links. Render evidence as escaped text, restrict links to the artifact root, and avoid exposing container environment dumps in shareable reports.

**Exit gate:** A reader can select an existing run, understand what each scenario proves, inspect a failure and trace a chart or assertion back to its evidence. Playwright checks the displayed values, run switching, missing data and expected-failure presentation, and verifies reviewed visual baselines at desktop and narrow viewport sizes.

## Phase 2.5 — Present the test story

Implemented and approved for a checkpoint on 2026-09-28. See [Phase 2.5 results](DASHBOARD_PRESENTATION_RESULTS.md).

- Add a plain-language introduction with a Mermaid architecture diagram, including the DLQ, and an explanation of the Docker test harness.
- Present basic replication, recovery, and failure handling/load on separate pages, each with phase-scoped run selection.
- Show recorded container details, log links, event counts, target tables and DLQ counts in a reusable architecture component. Display recorded zero DLQ deliveries as `0`; distinguish missing evidence.
- Show memory only for Maxwell and the Swift consumer, and label timing as end-to-end.
- Explain each test's procedure, verification, results and coverage, with expandable supporting evidence on each test page.

**Exit gate:** Importer and Playwright checks pass, including reviewed desktop/narrow visual baselines and checks against retained real runs. Further styling and wording corrections can follow this checkpoint. Automatic refresh and export remain Phase 3.

## Phase 2.6 — Simplify the presentation

Reviewed and approved for a checkpoint. See [presentation corrections and verification](DASHBOARD_PRESENTATION_RESULTS.md).

- Include the `e2e` harness in the overview diagram and runnable commands above each test's selector.
- Explain Maxwell and Pub/Sub in plain language; keep the presentation focused on test procedures and results.
- Remove the old `/evidence` dashboard, next-step section, repeated coverage summaries and Git housekeeping from the pages.
- Retain supporting-file links, assertions, failure notices, test settings and explicit DLQ counts on the four presentation pages.

**Exit gate:** Type checking, 31 Node tests and 34 Playwright checks pass, including eight desktop/narrow screenshot baselines.

## Phase 3 — Refresh after reruns and publish snapshots

Completed and verified with `make dashboard`, `make dashboard-build`, and `make dashboard-test-live`. The full Basic replication command passed with Chromium observing changing counts during execution and all three final results. See [Phase 3 results](DASHBOARD_PHASE_3_RESULTS.md) for the run IDs, browser evidence and regression checks.

- Add `make dashboard` to start the local dashboard and artifact watcher, plus a manual `make dashboard-data` refresh command.
- Keep existing test commands unchanged: `make phase2`, `make phase4`, `make phase5`, `make e2e SCENARIO=crud`, and `make e2e-load` produce results that the watcher discovers automatically.
- Debounce file changes and publish normalized data atomically. Show an unfinished run as in-progress only when supported by run metadata; interrupted or legacy partial runs must not remain falsely successful or indefinitely marked running.
- Explicitly refresh generated data and invalidate relevant preview caches. Do not rely on a data loader noticing changes to arbitrary external artifacts; account for [Observable loader caching](https://observablehq.github.io/framework/data-loaders#caching).
- Refresh new results without losing a manually selected historical run. Offer a “follow latest” mode for watching reruns.
- Add `make dashboard-build` for a static snapshot with its selected run IDs, generation time and safe supporting evidence. Omit sensitive/raw files by default and label local-only evidence links rather than publishing broken links.
- Keep dashboard/import failures separate from test outcomes: a reporting error must not change a replication test's exit status or overwrite its evidence.

**Exit gate:** Playwright observes new fixture runs through the real importer/watcher without manual page reload, covering passing, validated negative and failed/interrupted outcomes. Run the exact Basic replication page command (`make e2e-checks WRITE_INTERVAL_MS=250`) with Chromium already open. Verify changing counts during the smoke workload, all three final run IDs and their expected results, without page reload. A built snapshot passes browser tests without the original test containers and contains no unintended credentials or local-only paths.

## Playwright testing

- **Data correctness:** Feed fixture artifacts through the real reporting pipeline, not mocked dashboard responses. Assert visible run IDs, verdicts, expected/captured/applied counts, DLQ outcomes, units and performance values against independent fixture expectations. Check that suite totals do not double-count child runs and that missing values remain unavailable rather than zero. Expose chart values in accessible summaries/tables so numerical correctness does not depend on screenshots alone.
- **Visual correctness:** Capture reviewed screenshots of the overview, scenario detail, recovery and performance views at fixed desktop and narrow viewport sizes. Check chart rendering, legends, table readability and absence of unintended clipping/overlap. Pin browser/container/font settings and fixture timestamps, disable animations and wait for data/charts to finish rendering. Do not mask meaningful results or chart values to make screenshots pass.
- **Interactions and refresh:** Test run selection, evidence navigation, incompatible-run warnings and “follow latest.” Add a new run to an isolated artifact directory while the page is open; verify automatic refresh, preservation of a manually selected historical run, and that a newer failure is not hidden behind an older success. Use bounded condition-based waits rather than fixed sleeps.
- **Static report:** Build and serve the exported report separately. Verify its selected run IDs, displayed data, charts and included evidence links without access to the original artifact directory or replication services. Clearly unavailable/local-only evidence must not appear as a working link.
- **Execution and diagnostics:** Start with Chromium in a pinned container, with the test command managing an isolated viewer and fixture workspace. Leave the user's artifact directory untouched. Fail on unexpected browser errors or failed required data requests; retain the HTML report, traces, failure screenshots and visual diffs.
- **Baseline review:** Check visual baselines into Git. Updating them is an explicit command followed by human review, never an automatic response to a failed test. A successful screenshot comparison does not replace data assertions, and neither test suite replaces the existing replication E2E gates.

## Proposed developer workflow

```sh
make dashboard                 # Start local viewer + artifact watcher
make phase4                    # In another terminal; new run appears automatically
make e2e SCENARIO=crud          # Rerun one scenario
make e2e-load                   # Generate fresh performance evidence
make dashboard-data            # Explicitly regenerate the reporting data
make dashboard-build           # Build a shareable static snapshot
make dashboard-test            # Playwright: data, visuals, interactions, refresh and static report
make dashboard-test-live       # Full basic suite + live browser verification
make dashboard-test-update-snapshots  # Explicit visual baseline update; review the diffs
```

The commands above are implemented. `make dashboard-view` also remains available for starting the viewer alone; `make dashboard-stop` stops the viewer and watcher. Database/SQL captures remain local in the default static export.

The basic suite updates saved event counts during execution and publishes final verdicts after host completion. Follow-up scope: timestamped fault/recovery event streams, richer backlog time-series sampling, artifact retention/archive policies, and CI-hosted reports.
