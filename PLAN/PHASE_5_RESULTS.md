# Phase 5 — Scenario suite and local POC assessment

Phase 4 checkpoint: `b62355c`. Phase 5 changes are uncommitted for review. The complete mandatory suite and larger load run passed locally on 2026-09-28.

## Scenario coverage

`make phase5` requires all six gates; its machine-readable suite result records completed/required gates and exit status. The larger `make e2e-load` is opt-in.

| Required scenario | Gate / evidence |
| --- | --- |
| Fresh schema, append, CRUD, repeated updates, schema changes during writes | Phase 3 smoke: independent manifest, modeled/source/target schemas and rows, full ledger, empty DLQ |
| Composite/changed keys, drop/recreate, type boundaries | Phase 2: 21 events plus replay and direct rollback/journal/collision/drift checks |
| Multi-row/multi-table transaction and rollback | Phase 5 workload: six ordered committed operations; rolled-back insert/update/delete excluded from audit and ledger |
| Crash at DML commit/ACK and DDL implicit-commit boundaries | Phase 4: actual SIGKILL, durable head/journal and eventual exact accounting |
| Maxwell/source restart and binlog rotation | Phase 4 retained-volume restarts; Phase 5 explicit rotation before continuing writes, with pre/post binlog evidence |
| Target outage, replay/duplicates, fixable quarantine and repair | Phase 4: nine backlog operations, stable identity, two exact-byte repairs; no skipped events |
| Malformed event and unsupported DDL | Separate Phase 5 stacks: exact expected durable diagnostic, original envelope, unchanged checkpoint/schema, captured following event blocked across restart and failed repair |
| Larger transaction, continuing writes and backlog | Phase 5 small default and opt-in load: complete event accounting, transaction metadata/commit order, raw latency/throughput and sampled memory |
| Emulator restart and rebuild/reseed | Phase 4 detects queue loss; final Phase 5 workload provisions a new clean project/source history, not reuse of old checkpoints |
| Harness catches false convergence | Phase 3 deliberately missing intermediate events and wrong final value must fail with the specific intended assertion |

Unsupported MODIFY COLUMN is actual source DDL captured by Maxwell but rejected by the Swift policy. Malformed JSON is deliberately published to the real emulator topic. Neither can become valid merely by reapplying unchanged bytes: failed repair must preserve the durable block. A reviewed decoder/policy correction or explicit clean disposable rebuild remains necessary. Successful in-place repair is established only for Phase 4's fixable target drift; no claim of automatic malformed/unsupported-payload repair is made.

## Tested contract and limits

Compose pins MySQL 8.4.8 Oracle, MySQL 5.7.42 Debian with the tested `setpriv` entrypoint adjustment, Maxwell 1.46.0 with the existing Pub/Sub/index-DDL patches, Google Cloud CLI emulator image 543.0.0 and Swift 6.2.1 Jammy. MySQL 5.7 and the emulator run amd64 under Apple Silicon emulation. This is a debug-build, instrumented local POC; exact deployed database patch versions still need validation.

Supported schema operations remain CREATE DATABASE/TABLE, trailing nullable/defaulted ADD COLUMN, ordinary nonunique ascending full-column indexes, and single-table DROP TABLE. Scope is `poc`, InnoDB with primary keys, portable identifiers and `utf8mb4_unicode_ci`. Tested data boundaries include SQL NULL versus JSON null, Unicode, unsigned 64-bit integers, DECIMAL(65,30), exact JSON numbers, binary and microsecond date/time values. See the [full contract](../README.md#phase-2-checks-and-contract).

Whole-source-transaction atomic visibility at the target, existing-data bootstrap, arbitrary DDL, multiple concurrent consumers, ledger pruning, real Pub/Sub IAM/durability/ordering, Cloud Run lifecycle and production networking remain outside this POC. Maxwell suppresses some broader operations; a consumer DLQ cannot detect DDL it never receives. Emulator restart destroys resources/queued messages. The repair command cannot skip or substitute failed payloads.

## Measurement definitions

Each load run has three setup DDL events, a six-event transaction, one `ROWS`-event transaction, and `ROWS` continuing autocommit inserts: `2 × ROWS + 9` total unique events. Target/source each finish with `2 × ROWS + 2` rows across two tables. The rolled-back operations are not included in either total.

Backlog recovery runs from a timestamp recorded before restarting the consumer until polling first observes every initial unapplied DML event committed. Its rate is initial backlog events divided by this interval, while new writes continue. The load probe requires an outstanding backlog at the start of continuing writes when `ROWS >= 1000`.

Latency is the source pre-statement/pre-COMMIT timestamp to first target-ledger observation, with nearest-rank p50/p95/p99. It includes outage/startup/probe overhead and polling delay, and is an upper bound rather than native server commit-to-commit latency. Observation occurs every ten continuing writes, then roughly every 100 ms during convergence. Stream rate includes writes, convergence and drain. Raw samples and timing boundaries are retained. Docker memory/CPU samples are roughly every four seconds including collection overhead; sampled memory is not a true high-water mark. Instrumentation, debug builds, QEMU and other local workloads affect all numbers. No production SLA is inferred.

## Validation results and recommendation

`make phase5` passed **6/6 mandatory gates**, exit 0, in `artifacts/maxwell-phase5-suite-1790624184-15541/`. Native and Linux-container Swift unit suites passed **21 tests**. Shell syntax, Compose configuration and Git whitespace checks passed.

| Evidence directory under `artifacts/` | Outcome |
| --- | --- |
| `maxwell-e2e-1790624184-15548` | Smoke: 55 events; matching schemas/rows; zero DLQ |
| `maxwell-e2e-1790624321-16514` | Missing intermediate events correctly failed `event-manifest`; self-test passed |
| `maxwell-e2e-1790624455-17449` | Wrong target value correctly failed `row-mismatch`; self-test passed |
| `maxwell-phase2-1790624523-17950` | Type/key/DDL/replay checks: 21 unique events; direct recovery/collision/drift checks passed |
| `maxwell-phase4-1790624592-18402` | 47 probes; 22 events; both quarantines repaired; crash/outage/replay/queue-loss gate passed |
| `maxwell-phase5-malformed-1790624878-21010` | Exactly one diagnostic; failed health and repair for expected reasons; following captured write remained blocked across restart |
| `maxwell-phase5-unsupported-1790624983-21852` | Same fail-closed outcome for real source MODIFY COLUMN; target schema unchanged |
| `maxwell-phase5-workload-1790625090-22897` | 33 events, 26 rows, ordered transactions/rollback/rotation; zero DLQ/quarantine; fresh rebuild/reseed passed |

The final small run (`ROWS=12`, seed 42, 10 ms pacing) observed an 18-event initial DML backlog, with 14 still unapplied when continuing writes began. Recovery took **4.082 s** (**4.41 backlog events/s**). Continuing-write rate including convergence/drain was **3.43 events/s**. Across 30 DML observations, latency p50/p95/p99 was **4.740 / 5.422 / 5.566 s**. Sampled peak Docker memory was **5.09 MiB consumer / 264.9 MiB Maxwell**. Fixed startup/poll/drain overhead dominates this small run; these are not capacity estimates.

The separate `make e2e-load` run (`ROWS=1000`, seed 42, 1 ms requested pacing) passed in `artifacts/maxwell-phase5-workload-1790625225-23902/`, exit 0. **2,009 unique events** matched the independent manifest, audit, commit-ordered ledger and final checkpoint; **2,002 modeled/source/target rows** and both schemas matched. The six-event and 1,000-event transactions had consistent transaction IDs, contiguous offsets and correct final-row markers. Rollback events were absent. DLQ, quarantine, pending head and incomplete DDL were all empty.

| Larger run measurement | Observed value |
| --- | --- |
| Initial unapplied DML / still outstanding when continuing writes began | 1,006 / 1,001 events |
| Backlog recovery, with continuing writes | 37.751 s |
| Initial backlog events / recovery interval | 26.65 events/s |
| Continuing-write rate, including convergence/drain | 16.27 events/s |
| Observational latency p50 / p95 / p99 (2,006 DML samples) | 34.638 / 36.863 / 38.944 s |
| Sampled peak Docker memory, consumer / Maxwell | 5.805 / 309.2 MiB |

The larger run was executed after the full regression suite finished, not alongside another new test stack. Pre-existing local services remained running. These rates characterize this serial, instrumented debug POC on an emulated 5.7 target, not production capacity. Latency intentionally includes accumulated backlog; no latency SLA was asserted.

**Recommendation: conditional GO for a bounded, non-production real-GCP trial; NO-GO for production rollout.** First add authenticated/TLS real-service connectivity, validate the deployed MySQL patch versions and network path, restrict writes to the tested schema contract, and repeat failure/ordering/redelivery tests against real Pub/Sub. Keep one writer and the durable replay ledger. Decide separately whether existing-data bootstrap and whole-source-transaction target visibility are required; this POC provides neither. Broader capture/DDL coverage and safe repair of genuinely malformed/unsupported input remain explicit prerequisites wherever those inputs are possible.

All disposable stacks created for this validation were removed; logs, original payloads and measurement artifacts remain. Existing user stacks, context/scratch files and the ignored upstream clone were untouched.
