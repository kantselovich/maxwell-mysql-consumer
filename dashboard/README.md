# Dashboard reporting data — Phase 1

This directory currently contains the artifact importer and test fixtures, not a web UI. Observable pages, the watcher and Playwright browser tests are subsequent phases in [the dashboard plan](../PLAN/DASHBOARD_PLAN.md).

## Run

From the repository root, with Docker/Compose:

```sh
make dashboard-data       # Type-check/test the reporting image, then import artifacts
make dashboard-data-test  # Run the importer/host-metadata fixture suite in its container
```

Output: `dashboard/.generated/report.json`, ignored by Git. The standalone Compose file starts no replication services, mounts `artifacts/` read-only and disables runtime networking. Node is pinned to 24.13.0 and an image digest; npm development dependencies are locked. It does not mount a Docker socket or inspect live databases.

For development with Node >=24.13:

```sh
cd dashboard
npm ci
npm run typecheck
npm test
npm run data -- ../artifacts .generated/report.json
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

Discovery covers the legacy root and `maxwell-phase1-*` through `maxwell-phase5-*` / `maxwell-e2e-*` directories. Symlinked runs/files and unsafe paths are rejected. Required JSON reads are bounded to 64 MiB per file. Future UI code must escape raw text and resolve evidence links through the same artifact-root boundary; these references are not permission to publish all logs.

## Tests and fixtures

`test/fixtures/runs.json` contains deliberately small synthetic artifact sets and independent expected values for each adapter and outcome. These are reporting fixtures, not claims that a one-event workload passed the actual full replication gate. They are intended for reuse in later Playwright tests.

Tests cover correct and incorrect expected failures, corrupt/missing evidence, repeated diagnostics, unresolved quarantine, mismatched ledger IDs, invalid measurements, UInt64 seeds, symlink/path boundaries, suite completeness, CLI output and metadata failures. The Phase 1 runner storage test uses a fake Docker executable in a temporary workspace; it is explicitly not a database integration test. Real replication regression evidence is recorded separately in the dashboard Phase 1 results document.
