# Phase 4 — Recovery, duplicate handling and durable quarantine

Validated locally on 2026-09-28, after the separately committed Phase 3 checkpoint **`573ed9d`**. Reviewed Phase 4 changes were subsequently committed as **`b62355c`**.

## Exit gate

`make phase4` passed in `artifacts/maxwell-phase4-1790613895-52563/`:

- **22 unique source events** reconciled against the independent workload manifest, audit payloads and target apply ledger. Final modeled source/target schemas and all nine rows matched.
- SIGKILL before DML commit left the old row and ledger intact; restart applied the retained event. SIGKILL after commit/before ACK recovered through deduplication without reapplying the mutation.
- SIGKILL after DDL's implicit commit left one incomplete journal; restart recognized the after-schema and completed it.
- The consumer renewed its 10-second lease at least three times during a pause longer than that lease.
- A target outage accepted nine further source operations, kept the consumer alive through connection refusal and temporary Docker DNS loss, then drained the backlog without DLQ records.
- Maxwell restart and MySQL 8.4 restart recovered with volumes retained. Replaying an older update did not overwrite the current row.
- Two deliberately missing target rows caused exactly **two unique quarantined source events**. Later events and the applied checkpoint stayed blocked across consumer restarts. Both unfixed repair attempts failed for the expected missing-row reason; after restoring each row, exact-byte repair applied the original event before later updates resumed.
- A kill after quarantine persistence/before publication recovered the pending publication. A kill after publication/before publication bookkeeping produced **three total DLQ deliveries for two diagnostic identities**. Duplicate diagnostic contents were identical and matched durable quarantine and independent source audit bytes/identities/reasons. Both quarantines ended published and resolved; no pending head or DDL remained.
- Restarting the emulator removed its resources. The consumer retried transient transport errors, then exited visibly on missing resources. The harness confirmed queue loss and an unchanged 22-event apply ledger. This intentional terminal failure is expected; the overall gate exited 0.

Evidence includes `recovery-state.json`, `recovery-ledger.json`, `recovery-quarantine.json`, modeled/source/target row and schema snapshots, per-probe logs, lease/outage/queue-loss logs, full service inspections, source capture and target applied checkpoints, and `host-result.json`. No error, timeout or startup failure is accepted in place of an expected failed-repair assertion.

## Regression checks

- Native and Linux-container Swift unit suites: **19 tests passed**, including raw malformed-byte preservation, diagnostic identity, bounded backoff, Docker DNS loss and typed gRPC timeout classification.
- Phase 3 `make e2e-checks`: smoke (`maxwell-e2e-1790609708-26322`) reconciled 55 events with matching schema/data and zero DLQ. Missing-event (`maxwell-e2e-1790609779-26923`) and wrong-value (`maxwell-e2e-1790609843-27463`) self-tests detected exactly their intended assertions.
- `make phase2`: `maxwell-phase2-1790610903-34709` passed 21-event type/key/DDL coverage, stale replay, DML rollback, DDL journal recovery, payload collision rejection and schema-drift barriers.

## Implementation and findings

`ConsumerRuntime` owns serial processing, renewable leases, retry/backoff and the operator `repair` command. `MySQLTarget.RecoveryStore` persists one global stream head and an immutable diagnostic with publication/resolution state. Quarantine and head-blocking are transactional; application remains governed by the existing DML ledger/checkpoint transaction and recoverable DDL journal. A single writer lock covers both consumption and repair. No broker-managed DLQ forwarding is enabled, and the replay ledger is not pruned.

Fault injection revealed and corrected three infrastructure details: stopped Docker services may temporarily disappear from DNS; gRPC can expose a typed timeout rather than a `GRPCStatus`; and pinned Maxwell exits after its default single failed reconnect. Maxwell now uses Compose `restart: on-failure` to resume its persisted checkpoint. Consumer fatal queue-loss/configuration errors remain visible, without automatic restart. The test's after-commit pause also explicitly excludes already-deduplicated deliveries.

## Scope and operation

See [README recovery instructions](../README.md#recovery-and-quarantine-phase-4). Stop the consumer and fix the cause before running `docker compose run --rm --no-deps e2e repair` with the same project/source identity. Repair retries the stored bytes; it cannot skip or replace a payload. Malformed or unsupported events may require a reviewed policy/code correction or an explicit clean rebuild. The end-to-end poison fixtures here are target-drift failures of valid source updates; malformed-byte preservation is unit-tested, not a claim of complete Phase 5 poison/type coverage.

Emulator restart is queue loss, not durable broker recovery. Stop writers, preserve evidence, and rebuild/reseed a fresh disposable project/source history rather than recreating subscriptions against old checkpoints. Existing-data bootstrap, real GCP behavior, whole-transaction target visibility, the wider failure/load matrix and performance assessment remain follow-up work.

All disposable stacks created during this validation were removed, with evidence retained. The original persistent stack, the user's retained MySQL startup-failure stack, `PLAN/POC_CONTEXT.md`, scratch/editor files, and ignored upstream clone were left untouched.
