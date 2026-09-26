# Option 1: MySQL 8.4 → Pub/Sub → MySQL 5.7 POC

Based on [POC_CONTEXT.md](POC_CONTEXT.md). This plan covers a fully local POC, implemented in Swift and exercised through Docker Compose. Real Pub/Sub, Cloud Run, and CloudSQL validation are follow-up work.

## Outcome and scope

One command builds and starts the stack. Another runs repeatable scenarios that create schemas **only on MySQL 8.4**, write and change data, and prove that the supported schema and data converge on MySQL 5.7 with no missing events or unexpected DLQ messages.

Start with an empty application database, one source, one consumer, InnoDB tables with primary keys, and an explicitly supported SQL subset. Capture must be ready before application schema creation. Loading an existing database and coordinating a snapshot with live CDC are outside this first POC.

The initial consistency contract is ordered, eventual replication of committed changes. Target readers may temporarily see part of a source transaction; atomic visibility of whole source transactions is a separate enhancement. Unsupported operations must produce a visible failure, never a successful skip.

## Local architecture

```text
MySQL 8.4 → Maxwell → Pub/Sub emulator → Swift consumer → MySQL 5.7
                           │                  │
                           │                  └→ DLQ topic → test observer
                           └→ audit subscription → test observer

Swift E2E harness: source workloads, target verification, event accounting
Host runner: Compose lifecycle, restart/failure injection, artifact collection
```

Compose services: `mysql84`, `mysql57`, `pubsub`, `pubsub-init`, `maxwell`, `consumer`, and an `e2e` profile. Persist both databases, including Maxwell metadata and consumer checkpoints. Create CDC/DLQ topics and consumer/audit/DLQ subscriptions before Maxwell starts. Initialization may create service accounts and internal metadata on the target, but must not pre-create replicated application tables.

Use a Swift Package with these boundaries:

| Component | Responsibility |
| --- | --- |
| `ReplicationCore` | Maxwell decoding, source event identity, schema policy, DML/DDL planning |
| `MySQLTarget` | Parameterized SQL, metadata, deduplication, checkpoints, failure journal |
| `PubSubTransport` | Emulator connection, pull, acknowledgement, acknowledgement extension, publishing |
| `Consumer` | Serial processing loop, retries, health/status, structured logs |
| `E2EHarness` | Deterministic workloads, database comparisons, audit and DLQ observers |

Use Swift concurrency, Swift Testing, and a MySQL driver such as [MySQLNIO](https://github.com/vapor/mysql-nio). Start with a narrow generated gRPC Pub/Sub client using SwiftProtobuf/gRPC Swift; validate the dependency combination in Phase 1. Keep transport separate so a later Cloud Run push adapter can reuse replication logic.

## Phase 1 — Prove compatibility and establish the stack

Completed locally on 2026-09-25. See [Phase 1 results](PHASE_1_RESULTS.md) for tested versions, captured evidence, and compatibility adjustments.

- Add `Package.swift`, container builds, Compose, health checks, configuration, and startup/test scripts. Pin working toolchain, dependency, and image versions; verify the host CPU architecture and use `linux/amd64` emulation where required by the selected MySQL 5.7 image.
- Configure MySQL 8.4 row binlogs with full row images, adequate retention, and Maxwell permissions. Verify authentication and actual 8.4 binlog consumption; broad MySQL 8 support is not sufficient evidence for this exact combination.
- Configure Maxwell's emulator endpoint, DDL output, source position/transaction/row-offset metadata, primary-key metadata, and `ignore_producer_error=false`. These controls exist in the [Maxwell configuration reference](https://maxwells-daemon.io/config/).
- Send DDL and DML through one topic, one fixed ordering key, and one ordered subscription. Verify they use the same ordered publisher path in the pinned Maxwell build. Inspect or patch that integration if necessary; a single consumer alone does not establish publication order. Maxwell's [Pub/Sub producer implementation](https://github.com/zendesk/maxwell/blob/master/src/main/java/com/zendesk/maxwell/producer/MaxwellPubsubProducer.java) is the starting point for this check.
- Exercise Swift connectivity to both databases and emulator administration, pull/ack, redelivery, and publish. Capture real DDL/DML fixtures, including several rows from the same binlog event, and establish a stable unique event identity that survives Maxwell replay.

**Exit gate:** A source `CREATE TABLE` followed immediately by inserts and updates arrives in order at a diagnostic subscriber. The exact images/configuration and captured payloads are recorded. Resolve any 8.4, emulator, or DDL publication blocker before continuing.

## Phase 2 — Replicate schema and data through Swift

Completed locally on 2026-09-25. See [Phase 2 results](PHASE_2_RESULTS.md) for evidence, the bounded SQL contract, and capture compatibility fixes. Run the isolated gate with `make phase2`.

- Implement the initial DDL subset: `CREATE DATABASE`, `CREATE TABLE`, `ALTER TABLE ADD COLUMN` for nullable/defaulted columns, basic index creation/removal, and `DROP TABLE`. Restrict operations to the configured application database.
- Start fixtures with a charset/collation supported on both versions. Validate DDL against the supported subset before execution; reject unsupported 8.4 collations or syntax explicitly. Compare semantic schema definitions rather than literal `SHOW CREATE TABLE` text.
- Apply insert/update/delete using bound values and quoted identifiers. Cover composite keys and primary-key updates using the old key. Preserve NULL, integer/decimal precision, Unicode, binary values, JSON, and timestamp precision. Maxwell supplies distinct [DML and DDL event formats](https://maxwells-daemon.io/dataformat/).
- Process serially across DDL and DML. Apply each DML event, its deduplication record, and the consumer checkpoint in one target transaction; acknowledge only after commit. Use source identity plus the validated binlog/row coordinates, not Pub/Sub message ID alone, for deduplication.
- Give DDL a recoverable journal with before/after schema checks. DDL can implicitly commit, so it cannot share the DML atomicity strategy; retry must recognize an already-completed change without treating unrelated schema drift as success. See [MySQL implicit-commit behavior](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html).

**Exit gate:** Starting from an empty target, source-only schema provisioning and CRUD converge correctly, including an add-column operation immediately followed by writes to that column.

## Phase 3 — Build the reusable E2E harness

Completed locally on 2026-09-25. See [Phase 3 results](PHASE_3_RESULTS.md). `make e2e` runs the smoke scenarios; `make e2e-checks` additionally proves missing-event and wrong-value assertions fail correctly.

- Provide a host script that builds/starts Compose, waits for actual CDC readiness, runs the containerized Swift harness, collects diagnostics, and returns a nonzero exit code on any failed assertion. Let the host script inject container failures without mounting the Docker socket into the application.
- Use an isolated Compose project and fresh test volumes per clean run. Allow a keep-on-failure option; retain volumes during restart scenarios. Use seeded workloads and unique run identifiers.
- Model each scenario as setup → source actions → bounded convergence wait → assertions. Use polling with deadlines rather than fixed sleeps. Allow continuous writes during selected scenarios, then stop writers and emit a final marker through the same ordered stream before final comparison.
- Produce an expected operation manifest from the workload. Reconcile it with independently observed CDC events and the target apply ledger so an event lost before publication, or an insert later deleted, cannot hide behind matching final row counts.
- Compare sorted rows and normalized schema metadata: columns, types, nullability, defaults, primary keys, indexes, charset/collation. Validate against both source state and the expected workload. Record raw messages, schema/row differences, checkpoints, service logs, and machine-readable results.
- For every positive scenario require: all expected events accounted for, final marker applied, matching data/schema, zero unresolved failures, and zero DLQ deliveries throughout the run and a bounded drain period. An empty DLQ alone is not proof of delivery.

**Exit gate:** A repeatable smoke suite runs from one command, fails on an intentionally missing event or wrong value, and produces useful diagnostics without manual SQL inspection.

## Phase 4 — Recovery, duplicate handling, and DLQ behavior

- Retry transient failures with backoff while retaining the event and preserving order. Extend acknowledgement deadlines as needed. Simulate a crash before commit and after commit but before acknowledgement; recovery must neither lose nor apply an event twice.
- Separate Maxwell's capture checkpoint from the consumer's applied checkpoint. Persist both, and retain the apply ledger for the full POC replay window. Replaying an older update after a newer update must not overwrite the newer state.
- Use an application-managed DLQ for this POC. On a permanent error, durably record the failed payload/identity/reason and block the stream, publish the diagnostic to the DLQ, then acknowledge only after quarantine is durable and publication succeeds. Retry interrupted publication with the same event identity; observers deduplicate diagnostics.
- Keep the blocked state across consumer restarts and prevent later events from being applied. Provide a repair/replay command that retries the failed event before resuming. Successful recovery must account for that event; moving it into a DLQ does not count as successful replication.
- Do not enable automatic broker DLQ forwarding for the main subscription in this first implementation: a prolonged target outage should not silently advance past unapplied changes. If native forwarding is evaluated later, test its ordering consequences separately; [Pub/Sub documents ordering caveats with dead-letter forwarding](https://docs.cloud.google.com/pubsub/docs/ordering).
- Treat emulator restart as queue loss, not a durable broker restart. Detect missing resources and fail visibly; document a clean rebuild/reseed procedure. Consumer, Maxwell, and database restarts must recover with their volumes retained. The [emulator documentation](https://docs.cloud.google.com/pubsub/docs/emulator) describes session-scoped resources and differences from the real service.

**Exit gate:** Restart, transient outage, duplicate/replay, and deliberate poison-event scenarios pass. Positive tests have no DLQ messages; negative tests require exactly the expected unique quarantined events and prove repair/replay works.

## Phase 5 — Complete the scenario suite and assess the POC

| Scenario | Required evidence |
| --- | --- |
| Fresh schema + append workload | Source-only DDL creates matching target schema; every inserted row arrives |
| Updates, deletes, repeated writes to one key | Correct final values and no missing intermediate events |
| Composite key + primary-key change | Correct row selection; no orphaned old-key row |
| Schema change during traffic | DDL precedes dependent writes; schema and values converge |
| Drop/recreate a table | No stale schema state or accidental suppression of new events |
| Data-type boundaries | NULL, Unicode, large integers, decimals, JSON, binary and timestamps round-trip |
| Multi-row/multi-table transaction + rollback | All committed changes arrive in order; rolled-back changes do not appear |
| Consumer crash at commit/ack boundaries | Redelivery converges without duplicate effects |
| Maxwell restart + source restart/binlog rotation | Capture resumes without gaps with persistent metadata |
| Target outage while source writes continue | Backlog drains after recovery; no unexpected quarantine |
| Duplicate publication + older-event replay | Stable identity prevents duplicate effects and stale overwrites |
| Unsupported DDL / malformed event | Visible failure, expected DLQ record, blocked progress, repair/replay |
| Larger transaction + sustained backlog | Complete event accounting; record throughput, lag and memory |
| Emulator restart | Queue-loss limitation is detected; documented rebuild restores a clean POC |

Make workload size, write rate, seed, and convergence timeout configurable. Use a small default suite and a larger opt-in load run. Report events/second, latency percentiles, and backlog recovery time without inventing a production SLA.

**Exit gate:** Publish a short results report with tested versions, supported DDL/types, scenario outcomes, measured performance, known limitations, and a go/no-go recommendation for a real GCP trial. No mandatory scenario may be silently skipped.

## Developer commands

The core commands below are implemented through Phase 3. The load suite remains a Phase 5 deliverable:

```sh
make up                         # Build/start the local POC and wait for readiness
make e2e                        # Isolated clean run of the current smoke scenarios
make e2e SCENARIO=schema-change  # Run one scenario
make e2e-checks                  # Smoke suite + missing-event/wrong-value assertion checks
make e2e-load                    # Planned: larger configurable load suite (Phase 5)
make down                       # Stop without deleting persisted state
make reset                      # Explicitly remove this POC's volumes/state
```

Follow-up scope: existing-data bootstrap, whole-transaction target visibility if required by Analytics V1, broader DDL compatibility, real Pub/Sub semantics/IAM, Cloud Run lifecycle, and connectivity to CloudSQL/on-prem MySQL. Local emulator results alone do not establish production reliability.
