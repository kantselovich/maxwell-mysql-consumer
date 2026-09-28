# Dashboard Phase 2 — narrative viewer

Implemented locally on 2026-09-28; changes and initial screenshot baselines are ready for user review. Phase 1 was committed separately as `79f55fe`.

## Delivered

- Observable Framework overview, scenario, correctness/recovery, performance and history views. Read-only localhost server; no Docker socket, database credentials or replication-service dependencies.
- Selected-run provenance, explicit failure/unknown/incomplete states, negative-test explanation, missing values, baseline pin, comparison caveats and suite navigation without duplicate totals.
- Event/rate charts, real-sample latency histogram and sampled-memory peaks with accessible value tables, units, definitions and source links. Recovery is ordered, not falsely timed. Schema/row differences remain original-file drill-downs.
- Allowlisted, artifact-root-bounded, symlink-rejecting plain-text evidence access; raw strings cannot execute as HTML. External fonts disabled; fixture browser tests run without network access.
- `make dashboard-view`, `make dashboard-stop`, `make dashboard-test`, and explicit `make dashboard-test-update-snapshots`. Manual reimport/reload supported; no watcher or shareable snapshot claim.

## Verification

- Type-check and **29 unit/importer/presentation/security tests** pass in the pinned Node container.
- **22 Playwright checks** across desktop and narrow viewports: exact counts, units, expected failures, latest failed attempt, baseline selection, evidence navigation/escaping, missing/corrupt results, quarantine accounting, comparisons and explicit suite membership. Includes **8 visual baselines**, inspected during implementation; narrow multi-column tables use stacked rows.
- Real-artifact import: **46 individual runs and 2 suites**, with **37 passed, 10 failed, 1 unknown**. Historical failures remain visible; importing them is not a reporting failure.
- Chromium checked the running viewer against retained workload `maxwell-phase5-workload-1790625225-23902`: **2,009 applied events**, **2,006 latency samples**, **5.805 MiB** peak sampled consumer memory. Recovery run `maxwell-phase4-1790624592-18402` displays its **38 recorded steps**. No browser errors. Screenshots are local review artifacts in `dashboard/.generated/real-performance.png` and `real-recovery.png`.
- The replication application and existing raw artifacts were not modified; no fresh database workload was needed for this presentation-only phase.

## Review / next phase

Run `make dashboard-view`, then open <http://localhost:4173>. After another POC run, use `make dashboard-data` and reload. Inspect fixture screenshots under `dashboard/test/browser/snapshots/` and the Playwright HTML report under `dashboard/playwright-report/`.

Latest selection uses recorded start times, including failures; undated legacy attempts explicitly have unknown chronology. “Pin reviewed baseline” is a browser-local viewing preference only. Raw evidence remains local-only and may contain test data.

Phase 3 still owns automatic artifact watching, refresh while preserving historical selection, follow-latest behavior, safe shareable export and fresh POC-run browser integration.
