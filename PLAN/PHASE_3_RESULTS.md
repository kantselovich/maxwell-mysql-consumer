# Phase 3 — Reusable scenario harness

Validated locally on 2026-09-25, building on Phase 2 checkpoint **`c2e90ba`**. Phase 2 was committed separately; this phase adds the harness without changing applier behavior.

## Exit gate

`make e2e-checks` passed: a fresh, repeatable positive smoke suite plus two deliberately failing harness self-tests. Native and Linux-container Swift tests both passed all 13 tests.

| Run | Evidence directory under `artifacts/` | Outcome |
| --- | --- | --- |
| Smoke: append, CRUD, schema-change; 12 rows, seed 42 | `maxwell-e2e-1790399083-53010` | 55 unique events reconciled; schemas/rows matched; final markers applied; zero pending DDL or DLQ |
| Missing transient writes | `maxwell-e2e-1790399245-54132` | Harness exited 1 with `event-manifest`: 23 expected, 21 observed; final schemas/rows still matched |
| Wrong target value | `maxwell-e2e-1790399365-55017` | Harness exited 1 with `row-mismatch`; event accounting and schema checks passed |
| Selected schema-change; 24 rows, seed 777, 5 ms write interval | `maxwell-e2e-1790399443-55513` | 32 unique events reconciled; schema/data matched; zero pending DDL or DLQ |

The negative-test wrapper verifies the exact expected assertion and healthy infrastructure before returning success. Its `host-result.json` records host exit 0 alongside harness exit 1; `run-result.json` remains failed. Startup failures, timeouts, unrelated errors and unexpected successful assertions cannot satisfy this gate.

## MySQL 5.7 startup correction

Subsequent user runs exposed an intermittent infrastructure failure missed by the initial validation: MySQL 5.7 stopped after `Switching to dedicated user 'mysql'`, before database initialization. In retained project `maxwell-e2e-1790400450-61982`, PID 1 was the bundled Go-based `gosu` running under `qemu-x86_64`; all eight threads were waiting on futexes, the data directory was empty, and Docker reported no OOM kill. The harness had not started. A read-only `setpriv` probe in that same container successfully switched to the mysql user.

The target now uses a digest-pinned derivative of the same Debian image, replacing only the upstream `exec gosu mysql` handoff with the already-installed util-linux `setpriv`. Root-owned setup and initialization are otherwise unchanged; `mysqld` still runs unprivileged. The image build checks the expected patch site and tests the privilege switch. No health-check timeout was increased.

`make mysql57-checks` adds three fresh-volume starts, checking the version, init-SQL credentials/grants, non-root server PID 1, and a warm restart preserving a written marker each time. E2E cleanup now retains each service's full container inspection (including health-check history) and process listing before teardown, even if the harness never starts.

Post-fix smoke run `maxwell-e2e-1790400997-65573` passed all three scenarios with 55 events, matching schemas/rows and zero DLQ. Its saved process listing shows `mysqld` at UID 999 instead of a stuck `gosu`. The original retained failed project was left untouched for comparison.

Post-fix regression evidence:

- `maxwell-mysql57-checks-1790401047-66107`: all three cold starts and three warm restarts passed. Warm checks prohibit container recreation, verifying the restarted server against the retained volume.
- `maxwell-e2e-1790401065-66216`: missing-event self-test detected `event-manifest` (23 expected versus 21 observed).
- `maxwell-e2e-1790401125-66864`: wrong-value self-test detected `row-mismatch`.

The smoke suite and both negative tests used fresh isolated stacks with the patched target. This validates the local workaround on this host, not general MySQL 5.7 compatibility across emulators or deployed patch versions.

## What is implemented

- `make e2e` and scenario selection, deterministic seeded values, configurable row count/write interval/convergence timeout/drain interval, unique run IDs and fresh isolated Compose projects/volumes.
- Actual CDC readiness: source-only database/table creation and a marker must reach the audit stream, target ledger/checkpoint and expected target schema before scenarios begin.
- Explicit setup, paced source actions, final ordered marker, bounded convergence/drain and assertions. An independent observer drains audit/DLQ during writes. The schema-change scenario adds a column mid-workload, immediately writes it and continues appending.
- A pre-generated operation manifest includes complete DML values, changed old values and normalized DDL. Verification checks sequence/content, stable source identities, ledger membership/payloads and final checkpoint—not just row counts.
- Independently generated expected table inventory, semantic schemas and sorted rows are compared with both source and target. Secondary indexes remain present in final state for comparison. Pending DDL and any DLQ delivery fail a positive run.
- Machine-readable configuration, plans/manifests, expected state, raw deliveries, duplicate counts, comparisons/diffs, scenario/run results, ledger/journal/checkpoints, database versions and host lifecycle results. Build/startup/service/harness logs, container/image state and Maxwell capture checkpoints are retained, including on failure.
- Host-controlled container lifecycle, service-health checks and a finite harness watchdog; no Docker socket in Swift. `KEEP_ON_FAILURE=1` preserves a failed project's containers/volumes. Normal cleanup removes only disposable test resources, not an existing Phase 1/2 project.
- Unit checks for deterministic generation, invalid configuration, schema expectations, exact event values, ledger accounting, missing transient operations and corrupted rows.

## Scope and next phase

These negative tests validate the verifier: one deliberately omits an intended transient insert/delete pair, and the other changes target data after convergence. They are not claims of broker loss injection, crash recovery or DLQ routing. Real consumer/Maxwell/database restart/outage tests, retry/backoff, renewable leases, durable quarantine and repair/replay remain Phase 4. The broader type/key/drop-recreate checks remain available through `make phase2`; completing the full scenario/load matrix is Phase 5.

See [README](../README.md#reusable-e2e-harness-phase-3) for commands, options and artifact navigation. The existing Phase 1 stack, `PLAN/POC_CONTEXT.md`, `PLAN/s1`, and the Git-ignored upstream clone were left untouched.
