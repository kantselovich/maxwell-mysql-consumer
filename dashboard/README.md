# POC evidence dashboard

Phases 1–2 provide an artifact importer, read-only Observable Framework viewer, and Playwright data/visual checks. Phase 2.5 adds the introduction, separate test-story pages and recorded architecture components. Automatic watching and shareable static export remain Phase 3 in [the dashboard plan](../PLAN/DASHBOARD_PLAN.md).

## Run

From the repository root, with Docker/Compose:

```sh
make dashboard-data       # Type-check/test the reporting image, then import artifacts
make dashboard-data-test  # Run the importer/host-metadata fixture suite in its container
make dashboard-view       # Import current artifacts and start http://localhost:4173
make dashboard-stop       # Stop only the dashboard viewer
make dashboard-test       # Isolated Chromium fixture/data/visual gate
```

Output: `dashboard/.generated/report.json`, ignored by Git. The standalone Compose file starts no replication services, mounts `artifacts/` read-only, and disables runtime networking for reporting and fixture browser tests. The viewer publishes only `127.0.0.1:4173`. Node is pinned to 24.13.0 and an image digest; npm development dependencies are locked. It does not mount a Docker socket or inspect live databases. The build needs package-registry access; the built viewer needs no external browser requests or fonts. A patched esbuild override avoids the upstream build dependency's Windows development-server advisory.

After rerunning any POC phase, run `make dashboard-data` and reload the page. `make dashboard-view` is the manual-refresh Phase 2 command; the planned `make dashboard` watcher and `make dashboard-build` export are not implemented yet.

## Views and interpretation

The presentation starts at `/` with **MySQL Third-Party Replication POC**, a Mermaid architecture diagram that includes the consumer's DLQ branch, the test procedure, and the limits of the POC. Follow the pages in order:

- `/basics`: Phase 3 — basic replication and verifier self-tests.
- `/recovery`: Phase 4 — interruption, replay, repair and emulator-loss detection.
- `/failures`: Phase 5 — malformed input, unsupported schema changes and transaction/backlog load, as separate selected runs.

Each page selects only individual runs from its own phase and defaults to the latest recorded start time, including failed attempts. Pins are separate for each page. Suites remain in the detailed evidence browser rather than appearing as one combined experiment. The per-run architecture always includes a DLQ card: an observed zero is **0**, missing evidence is **Not recorded**, and diagnostic deliveries are separate from unique/expected failures.

Service cards show safe recorded container fields and service-log links where available. Memory appears only for Maxwell and the Swift consumer. Table names come from the event list; `cdc_meta.applied_events` is shown separately from application tables. Timing is labeled as end-to-end, not assigned to a particular container. Procedures, verification methods, results and limitations follow the architecture. Scripts, raw assertions and comparison files are expandable. Code links show the current checkout, not an assertion that it matches the selected run's revision.

The previous technical views remain available at `/evidence`:

- **Overview:** architecture, selected-run counts, scenario coverage, recorded versions/platform and limitations.
- **Scenario:** question, action, expected/observed outcome, raw assertion results and evidence.
- **Recovery:** event/DLQ/quarantine accounting, schema/row/diff drill-downs, and recorded restart/repair order. No invented timestamps.
- **Performance:** metric definitions/units, processing rates, a histogram of recorded latency samples, sampled memory peaks and timestamped samples. Raw missing/invalid samples remain unavailable. Numeric summaries accompany every chart.
- **History:** attempts, configuration/code provenance, explicit suite members and side-by-side measurements. Differing or missing workload/version/platform metadata produces warnings; unrecorded host conditions prevent claiming controlled comparability.

Selection is carried in `?run=...` (plus `view=...` in the detailed evidence browser). With no explicit selection or pinned baseline, the latest **recorded start time** wins, including failed/incomplete runs. Undated legacy attempts follow by ID and cannot honestly be placed chronologically; the UI says so. A browser-local reviewed-baseline pin is a viewing preference, not a changed test verdict. Nothing aggregates suite and child event counts.

Evidence links open inert plain text in a separate tab; their labels include JSON pointers, but the full original file is retained (no lossy reserialization of row values). The server requires a path referenced by the current report and rechecks every path component against the artifact root, rejecting traversal and symlinks. File reads are limited to 64 MiB. Container environment dumps are not allowlisted. Raw logs/payloads can still contain test data: local access is not permission to publish them. This server is for localhost, not authenticated multi-user hosting.

The additive `presentation` field contains whitelisted container name/image/snapshot state/Docker restart count, labeled event categories, and table names. Raw container inspections are private inputs limited to 8 MiB and never exposed by evidence routes. Optional presentation-file errors do not change a recorded replication verdict. The Docker restart counter is not a complete history of injected restarts. Observed payload categories are used where present; expected workload categories are clearly labeled when used as a fallback, and do not establish how many invalid events were received.

Service-log routes filter only a selected run's allowlisted `compose.log` by known Compose service prefixes. Source-code routes allow only the explicitly listed harness/script files. Both return inert plain text. Mermaid is pinned and prebundled locally from the lockfile by `viewer/build.ts`; only the fixed architecture definition is rendered, never artifact content. The generated bundle is ignored by Git.

For development with Node >=24.13:

```sh
cd dashboard
npm ci
npm run typecheck
npm test
npm run data -- ../artifacts .generated/report.json
npm run build:viewer
npm run viewer
```

Node executes [erasable TypeScript directly](https://nodejs.org/api/typescript.html); `tsc --noEmit` separately checks types. The importer publishes output by atomic rename and rejects output paths inside the raw artifact root, including directory symlinks into it. Importing failed tests is a successful reporting operation: CLI exit 0 means the report was generated, not that every replication test passed.

## Version 1 contract

`reporting/model.ts` defines the format. The root contains `schemaVersion`, `generatedAt`, the plain-language scenario `catalog`, `runs`, `discoveryIssues` and a summary of run/suite verdicts. No global event total is emitted: suites reference child runs, and independent reruns repeat workloads.

Each run contains:

- Identity, artifact directory, phase, kind, expected outcome, verdict and available failure classification/code.
- Raw host/harness exit codes, timestamps, base Git commit/dirty flag, workload configuration and available database/image versions.
- Explicit parent suite/gate IDs and child IDs when recorded. New complete suites require eight successful child runs covering six gates, including smoke and both negative self-tests. Historical suites without a manifest retain their reported gate verdict but explicitly lack child linkage; logs are not mined to guess it.
- Scenario IDs, individual assertions, event/DLQ/quarantine counts, named measurements with units and definitions, and an ordered recovery-check sequence. Sequence timestamps remain null when none were recorded.
- Evidence references, import issues and limitations. Facts use `{value, evidence}`; null means unavailable, not zero. Evidence uses artifact-root-relative paths plus JSON pointers, and is marked `local-only` pending an explicit export policy.

Verdicts:

| Verdict | Meaning |
| --- | --- |
| `passed` | Successful terminal host result and required phase-specific structured evidence agree; expected negative outcomes have their specific predicates checked |
| `failed` | Host execution failed, or the recorded harness failed unexpectedly; available evidence is still imported |
| `incomplete` | Required completion evidence is absent; a start record alone does not prove the process is still alive |
| `unknown` | Evidence is corrupt, unsafe, contradictory or has an unsupported shape/version |

A known failed execution remains failed even if its evidence is also incomplete/corrupt; `issues` and assertions retain that distinction. For intentional negative tests, raw scenario assertions can be failed while the overall expected-failure gate passes. A DLQ count alone establishes neither success nor failure.

## Adapter boundaries

| Existing gate | Main evidence |
| --- | --- |
| Phase 1 | Terminal result, captured identities/payloads, replay payloads; target-applied counts are unavailable |
| Phase 2 | Expected/audit/ledger counts, zero-DLQ assertion and six explicit target-recovery assertions |
| Phase 3 | Host + harness results, exact negative-test predicate, scenario outcomes, manifest/audit/ledger and DLQ |
| Phase 4 | Host result, event accounting, recorded recovery checks, stable diagnostic identities and resolved quarantines |
| Phase 5 workload | Host result, completed workload checks, event accounting, empty DLQ and finite performance measurements |
| Phase 5 poison | Host result, repeated blocked checks, one stable expected diagnostic retaining the original payload, and the positive baseline ledger |
| Phase 5 suite | Six required host gates; explicit child completeness when a membership manifest exists |

This layer checks report consistency and surfaces the harness's recorded assertions; it does not rerun SQL assertions or independently certify archived replication behavior. Historical per-probe health/repair outcomes were recorded in host control flow rather than individual JSON verdicts. Their gate requires successful terminal completion plus the corresponding structured state, not a `PASS` log line.

UInt64 configuration seeds outside JavaScript's safe integer range remain exact strings. Replay comparison preserves numeric lexemes while allowing JSON object-key reordering. Raw row/message values are not converted into rounded JavaScript numbers for display. Latency/rate definitions retain the existing observational/debug-build limitations. Memory samples, schema/row comparisons and supporting logs are linked as local evidence; container inspection/environment dumps are neither copied nor linked.

## New run metadata and legacy artifacts

The host scripts now write `run-metadata.json` with UTC start/finish times, identity, phase, base commit and dirty flag. Metadata writes are best-effort and never change the replication test's exit code. Suites write `suite-members.jsonl`; children record matching parent and gate IDs. Metadata does not include an environment dump or credentials. A dirty flag is not a snapshot of uncommitted changes.

Future Phase 1 runs use `artifacts/maxwell-phase1-*/` instead of overwriting shared root files; this changes evidence storage only, not the existing Phase 1 persistent-stack behavior. Historical root evidence imports as `legacy-phase1`. Older start/end times, code revisions, lost overwritten attempts and suite links are not invented from filesystem timestamps or nearby directory names.

Discovery covers the legacy root and `maxwell-phase1-*` through `maxwell-phase5-*` / `maxwell-e2e-*` directories. Symlinked runs/files and unsafe paths are rejected. Required JSON reads are bounded to 64 MiB per file. UI strings use text nodes; the server enforces the evidence boundary described above.

## Tests and fixtures

`test/fixtures/runs.json` contains deliberately small synthetic artifact sets and independent expected values for each adapter and outcome. These are reporting fixtures, not claims that a one-event workload passed the actual full replication gate. Playwright materializes these raw files into an isolated temporary directory and runs the real importer. It adds fixed metadata, consistent nearest-rank latency samples, timestamped memory, escaped HTML-looking evidence and an eight-member suite. No mocked report/API or real artifact mutations.

Tests cover correct and incorrect expected failures, corrupt/missing evidence, repeated diagnostics, unresolved quarantine, mismatched ledger IDs, invalid measurements, UInt64 seeds, symlink/path boundaries, suite completeness, CLI output and metadata failures. The Phase 1 runner storage test uses a fake Docker executable in a temporary workspace; it is explicitly not a database integration test. Real replication regression evidence is recorded separately in the dashboard Phase 1 results document.

### Browser and screenshot review

`make dashboard-test` runs Chromium in the Playwright 1.63.0 Noble image pinned by digest, at Linux ARM64 (emulated on Intel), with bundled fonts, UTC/en-US, fixed fixture dates, reduced motion and 1440×1000 / 390×844 viewports. Unexpected console/page/network errors fail the gate. Numerical assertions are independent of screenshot comparisons. Browser tests do not replace replication E2E tests.

Sixteen baseline images live under `test/browser/snapshots/`: introduction and three narrative pages, plus the four detailed evidence views, each at desktop and narrow sizes. Review them before committing a visual change. Updating is always explicit:

```sh
make dashboard-test-update-snapshots
make dashboard-test
```

Open `dashboard/playwright-report/index.html` for the test report. Failure screenshots, traces and diffs are retained under `dashboard/test-results/`; both directories are ignored. The initial baselines were visually inspected during implementation and are supplied for user review. They must not be automatically regenerated to silence a failing visual test.
