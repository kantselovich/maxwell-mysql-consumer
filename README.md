# Maxwell MySQL replication POC

Local MySQL 8.4 → Maxwell → Google Pub/Sub emulator → Swift applier → MySQL 5.7.

Phase 1 establishes compatibility and captures ordered events. Phase 2 adds bounded schema/data replication, durable deduplication and a recoverable DDL journal. See the [phased plan](PLAN/OPTION_1_TECHNICAL_PLAN.md).

Phase 1 is validated: [results and compatibility findings](PLAN/PHASE_1_RESULTS.md), [captured Maxwell messages](Fixtures/phase1/capture.json).

Phase 2 is validated: [schema/data replication results](PLAN/PHASE_2_RESULTS.md).

Phase 3 is validated: [reusable harness and negative assertion results](PLAN/PHASE_3_RESULTS.md).

## Run

Prerequisite: Docker with Compose v2 and enough resources to build Swift and run two databases plus Java services. A host Swift installation and GCP credentials are not required. First startup downloads images and builds dependencies; subsequent builds use Docker caching.

```sh
make e2e      # Fresh isolated smoke suite: append, CRUD, schema change
make e2e-checks # Smoke suite plus deliberate missing-event/wrong-value checks
make mysql57-checks # Three fresh target DB starts, each with a warm restart
make phase2   # Fresh isolated stack: schema/data convergence and recovery checks
make up       # Build/start the default persistent stack with the applier
make phase1   # Run compatibility checks and actual Maxwell binlog replay
make logs
make down     # Stop, retaining database volumes
make reset    # Delete only this Compose project's containers and volumes
```

MySQL 5.7 and the emulator are pinned to amd64 images; Docker Desktop emulates these on Apple Silicon. Swift, MySQL 8.4, and Maxwell's Java runtime run natively on ARM. Ports bind to localhost: MySQL 8.4 `13384`, MySQL 5.7 `13357`, emulator `18085`. Credentials in Compose/init SQL are local test credentials only.

The local target derives from digest-pinned `mysql:5.7.42-debian` with native AIO disabled. Its entrypoint uses the already-installed `setpriv` instead of `gosu`: the bundled Go-based `gosu` was observed hanging under QEMU at the root-to-mysql handoff. Upstream directory ownership, initialization and restart behavior are preserved; the server still runs as `mysql`, not root. The build fails if the expected entrypoint patch site changes. The `5.7.44` Oracle Linux image crashed during initialization under this host's QEMU emulation. Validation against the deployed 5.7 patch version remains a follow-up check.

`make mysql57-checks` exercises three fresh-volume target starts, init-SQL credentials/grants, the server's non-root UID, and a warm restart retaining a written marker after each start. It uses an isolated project and ephemeral port; logs/results remain under `artifacts/maxwell-mysql57-checks-*/`. `KEEP_ON_FAILURE=1` also works for this check.

## Reusable E2E harness (Phase 3)

```sh
make e2e SCENARIO=schema-change ROWS=40 SEED=123 WRITE_INTERVAL_MS=25
KEEP_ON_FAILURE=1 make e2e SCENARIO=crud
make e2e-checks
```

`SCENARIO` is `smoke` (default, all three), `append`, `crud` or `schema-change`. Workloads are deterministic for a given seed, with unique table names per run. Options: `ROWS` (default 12, 2–5000), `SEED` (default 42), `WRITE_INTERVAL_MS` (default 10), `CONVERGENCE_TIMEOUT` (default 60 seconds per marker), `DRAIN_SECONDS` (default 2), and `E2E_MAX_SECONDS` (default 300, host watchdog after startup). Increase timeouts for larger or deliberately slow workloads; SQL execution time adds to the requested pacing interval.

Each run builds the images and starts a new Compose project with fresh volumes, a new source identity and ephemeral localhost ports. A source-only readiness table/marker must traverse the entire CDC path before scenarios start. A separate observer drains audit/DLQ subscriptions alongside the paced writer. The schema-change scenario alters the table halfway through the append workload, immediately updates the new column, and continues appending. Once writes stop, an ordered marker must reach both the audit stream and applied checkpoint; the observer continues through a bounded drain period.

The generated manifest records every intended DDL operation and each row's full values/changed old values, including transient writes. Verification reconciles it with unique audit events and stored ledger payloads, then compares source and target against independently generated expected schemas and rows. It checks table inventory, columns/types/nullability/defaults, primary/secondary indexes, collation, final checkpoint, no pending DDL and no DLQ deliveries. Runtime failures are not converted into successful skips.

`make e2e-checks` also launches two isolated **negative self-tests of the harness**, not consumer recovery tests:

- `missing-event` suppresses an intended temporary insert/delete pair on the source. Source/target final rows still match the workload model; the independent event manifest must fail.
- `wrong-value` changes one target value after the final marker. Event accounting still passes, but expected/source/target row comparison must fail.

The underlying harness exits 1 in both cases. The self-test runner succeeds only when the recorded failure is exactly `event-manifest` or `row-mismatch`, respectively, and all required services remain healthy. Timeouts, startup errors and unexpected success fail the self-test. To see a normal nonzero failing invocation directly: `make e2e SCENARIO=crud HARNESS_FAULT=missing-event` (or `wrong-value`). Do not enable these injectors for a positive replication run.

Evidence is under `artifacts/maxwell-e2e-*/`: configuration/seed, workload plans, expected event manifest, raw deliveries (including duplicates and any DLQ records), semantic schema/row comparisons, explicit diffs, ledger/journal/checkpoints, scenario and run JSON results, versions, build/startup/harness/service logs, container/image state and capture checkpoint. Per-service `*-container.json` and `*-processes.txt` preserve health-check history and process state before cleanup, including when startup fails before the harness launches. `host-result.json` distinguishes the host/self-test exit code from the actual harness exit code. Inspect `run-result.json` and `*-diffs.json` first on assertion failure, or `startup.log` and the affected service's diagnostics on startup failure.

The host runner owns container lifecycle and the timeout; no Docker socket is mounted in Swift. Successful runs remove only their own containers/volumes and retain artifacts. `KEEP_ON_FAILURE=1` retains failed infrastructure and its volumes for inspection. Use the printed project name with `docker compose -p NAME logs`; when finished, `docker compose -p NAME down --volumes --remove-orphans` removes that disposable project. Existing Phase 1/2 stacks are not reset. Actual restart/outage injection, retry/DLQ recovery and the broader Phase 5 suite remain subsequent work; `make phase2` still runs the detailed type-boundary and target-journal regression checks.

## Phase 2 checks and contract

`make phase2` creates a uniquely named Compose project, fresh database volumes, a fresh source-history namespace and ephemeral localhost ports. It leaves an existing Phase 1 stack untouched. It removes only its own test containers/volumes after the run; artifacts remain under `artifacts/maxwell-phase2-*/`. Use `KEEP_ON_FAILURE=1 make phase2` to retain a failed stack for inspection. The printed project name can be passed to `docker compose -p NAME logs` or `docker compose -p NAME down --volumes` when finished.

The Swift harness provisions schemas **only on 8.4** and checks ordered event accounting, normalized schemas, sorted row values, the apply ledger, the final checkpoint, completed DDL journals and an empty DLQ. Its workload covers composite/changed primary keys, repeated updates, deletes, add-column followed immediately by writes, index creation/removal, drop/recreate, unsigned 64-bit integers, DECIMAL(65,30), Unicode, binary, JSON, SQL NULL versus JSON null, and microsecond datetime/timestamps. Republishing an old update must not change newer target state. Separate target integration checks inject errors after mutation to exercise transactional rollback and DDL recovery; these are not process-crash/ACK-boundary tests.

The consumer pulls one event at a time, grants a 600-second acknowledgement lease, and ACKs only after target commit. DML, the event ledger and the checkpoint share an InnoDB transaction. DDL first records durable before/after schema expectations; replay either executes from the before-state or recognizes the after-state, rejecting unrelated drift. A target advisory lock prevents concurrent appliers. Errors exit without ACK; automatic retries, durable quarantine/DLQ publication and repair commands remain Phase 4. The positive empty-DLQ check is meaningful only together with event accounting.

Supported DDL is intentionally narrow:

- Only `poc`, portable ASCII identifiers, InnoDB and `utf8mb4_unicode_ci`. Database creation must specify `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`; tables require an explicit `ENGINE=InnoDB` and a primary key.
- `CREATE TABLE`, trailing `ALTER TABLE ADD [COLUMN]` for nullable/defaulted non-key columns, ordinary ascending full-column indexes (`CREATE/DROP INDEX` and `ALTER TABLE ADD/DROP INDEX`), and single-table `DROP TABLE`.
- Integer types (optionally unsigned), explicit-length CHAR/VARCHAR/BINARY/VARBINARY, TEXT/BLOB, DECIMAL(p,s), JSON, DATE and TIME/DATETIME/TIMESTAMP with precision 0–6. Non-null defaults are limited to canonical integer literals and CHAR/VARCHAR strings; no expressions, auto-increment, generated columns, foreign keys, unique secondary indexes, column reordering or arbitrary comments. MySQL's exact generated DROP TABLE comment is accepted.
- Sessions use UTF-8, UTC, strict mode and no backslash SQL escapes. Identifiers are quoted and row values are bound, never concatenated into SQL. Exact JSON number tokens avoid Double/Decimal rounding.

Capture configuration is part of the wire contract: `binlog_row_image=FULL`, no excluded columns, and **`output_nulls=false`**. An omitted column means SQL NULL; an explicit JSON null means JSON `null`. Maxwell's [JSON writer](https://github.com/zendesk/maxwell/blob/v1.46.0/src/main/java/com/zendesk/maxwell/row/MaxwellJson.java) retains raw JSON null while omitting SQL NULL. Changing this setting independently of the applier is unsafe. Existing Phase 1 queued payloads are not a migration path: use a fresh project/history for Phase 2. The new target metadata grant also requires fresh volumes; init SQL does not rerun against old volumes.

The pinned Maxwell build includes a tested adapter for standalone index DDL, which upstream otherwise blacklists. It routes these events through Maxwell's normal schema history/filter/DDL publisher without changing its row decoder. Broader operations Maxwell suppresses (for example TRUNCATE, triggers and procedures) are outside this POC; do not use them and assume they will reach the consumer. General capture coverage and negative scenarios remain follow-up work.

## Phase 1 checks

`make phase1` starts the stack, then a containerized Swift harness:

- Connects to both databases and verifies their versions.
- Creates a temporary Pub/Sub subscription, publishes with an ordering key, pulls, extends the acknowledgement deadline, forces redelivery, verifies identity/payload, and acknowledges.
- Provisions a table only on the source and immediately writes a three-row insert, two updates in one transaction, and a delete.
- Asserts seven distinct events in exact order with the expected row IDs/values and ordering key. Confirms the three inserts share a binlog position but have distinct event identities.
- Stops Maxwell, runs a read-only replay from the saved binlog position with the same configuration, and verifies the seven source identities survive republication.
- Checks the DLQ observer and verifies the target has no application tables yet. Restores normal Maxwell and preserves diagnostic artifacts, including on failure.

Evidence is written under ignored `artifacts/`: `capture.json`, `replay.json`, container logs, and image inventory. Run fixtures use unique table/subscription names, so tests can be repeated without resetting databases. Phase 1 leaves source probe tables and the main/audit subscription backlog available for inspection.

The Phase 1 runner sets `CONSUMER_MODE=observe`, using only `cdc-diagnostic`. Run it on a Phase 1/empty-target project, not a populated Phase 2 target. Normal Compose startup defaults to `apply` on `cdc-consumer`. There is no DLQ error routing yet, so the Phase 1 empty-DLQ assertion is only a baseline check.

## Implementation notes

- SwiftPM modules separate event decoding, MySQL access, Pub/Sub transport, the CLI, and the harness. `make test` builds the Linux executable and runs identity, exact-JSON and DDL-policy unit tests. With a local Swift/protobuf toolchain, `swift test --jobs 4` also works.
- Pub/Sub uses generated SwiftProtobuf messages and gRPC Swift 1.x unary calls. The small `.proto` is an explicitly limited projection of the public v1 API, not a complete Google client. Connections are plaintext and emulator-only.
- MySQL uses row binlogs with full row images and seven-day retention. Both database volumes are persistent, including Maxwell schema/position metadata.
- Maxwell v1.46.0 compares DDL/DML topic Java string references. `ddl_pubsub_topic` is deliberately omitted so the default shares the same publisher, emulator channel, and fixed `mysql84` ordering key. Do not explicitly set it to an equal-looking string. [Upstream implementation](https://github.com/zendesk/maxwell/blob/v1.46.0/src/main/java/com/zendesk/maxwell/producer/MaxwellPubsubProducer.java).
- The stock Maxwell image also mixes incompatible Google Java libraries and fails when constructing its Pub/Sub publisher (`NoSuchMethodError: setUniverseDomain`). The custom image prepends the dependency graph resolved for its pinned Pub/Sub 1.132.3 client. It also recompiles the checksum-verified publisher source with a one-line guard to close a shared DDL/DML publisher only once. These are POC-specific adjustments; other Maxwell producers are not validated.
- Maxwell's distribution is copied into a native Temurin 21.0.7 runtime. Its stock amd64 Java 23 runtime produced socket-close/thread-signal exceptions under QEMU on this host.
- Event identity uses a configured source-history namespace, binlog file/position, and transaction row offset; Maxwell omits the offset on the final row, which receives a distinct `commit` suffix. DDL uses a `ddl` suffix. Resetting source binlogs requires a new namespace or a clean target/ledger. Broader DDL and bootstrap event identities are future work.
- Replay passes `FILE:POSITION:HEARTBEAT`, taking the persisted heartbeat after stopping capture as the schema lookup upper bound. Omitting the heartbeat can restore the initial schema even when later DDL precedes the requested position. The exact argument is recorded in `artifacts/replay-position.txt`.
- The emulator loses resources/messages when restarted. `make down`/`make up` therefore preserves databases but cannot preserve the queue. Phase 1 generates fresh workloads after startup; this is not a durable broker recovery test. Use `make reset` for a clean baseline.

For local upstream investigation, `.upstream/maxwell` is a shallow clone of tag `v1.46.0` (`a338a3d9e2e2d1c616dc83470438a1996a8584c6`), excluded from both Git and Docker build context. It is optional; reproducible Docker builds use checksum-pinned upstream files plus the checked-in patch helper.
