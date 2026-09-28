# Dashboard Phase 1 — Reporting foundation

Implemented locally on 2026-09-28. Changes are uncommitted for review. This delivers reporting data and fixtures only; no Observable UI, artifact watcher or Playwright browser test is claimed yet.

## Delivered

- Versioned TypeScript reporting model, plain-language scenario catalog and adapters for existing replication Phases 1–5.
- Separate raw exit codes, expected outcomes, gate verdicts and scenario assertions. Expected assertion failures and deliberate poison quarantines are not confused with unexpected failures.
- Evidence-backed counts/measurements, local evidence links, missing-data semantics and conservative handling of malformed/contradictory artifacts.
- Best-effort host run metadata with start/finish times and base commit/dirty flag; explicit future suite/child manifests. Future Phase 1 evidence uses its own run directory, preserving the historical root files.
- Standalone, pinned reporting container with a read-only artifact mount and no runtime network or replication services. `make dashboard-data` generates ignored `dashboard/.generated/report.json`; `make dashboard-data-test` runs fixture tests.

## Validation

- Strict TypeScript checking and **24 reporting tests** passed both natively and in the pinned container.
- The final import contains **46 individual runs and 2 suites**: 37 passed, 10 failed and 1 unknown. These include historical development/startup failures, not new regressions. Artifacts from every replication phase are represented, including validated negative tests, deliberate quarantine/repair and load runs.
- The legacy Phase 1 replay has reordered JSON object keys; exact-content comparison correctly allows that without rounding large numeric tokens.
- An earlier Phase 5 development run, `maxwell-phase5-workload-1790624015-14305`, lacks a final ledger artifact and the newer overlap measurement. It is intentionally not classified as passed despite its successful historical host exit.
- Fresh `make e2e SCENARIO=crud` passed in `artifacts/maxwell-e2e-1790631244-64781/`: **23 expected/captured/applied events**, matching data/schema and zero DLQ. Its new metadata records run identity, UTC start/finish, base commit `4411d0c` and dirty worktree status. The importer recognizes its successful host/harness outcomes.
- Shell syntax and whitespace checks passed. The real E2E run removed only its own disposable stack; evidence remains. Existing stacks and context/scratch files were untouched.

See [reporting documentation](../dashboard/README.md) for commands, the schema, adapter evidence requirements and limitations. Fixture tests cover suite wiring; the entire multi-stack Phase 5 suite was not rerun solely for metadata changes. Phase 1 storage isolation was tested with a fake Docker runner, not by restarting the user's persistent Phase 1 stack.
