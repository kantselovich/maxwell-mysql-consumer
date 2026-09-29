# Test harness and implementation reference

For the architecture, dashboard startup and page-named test commands, see the [project README](../README.md). For static builds and GitHub Pages, see the [dashboard documentation](../dashboard/README.md#static-build-for-github-pages).

## POC phases and results

Phase 1 establishes compatibility and captures ordered events. Phase 2 adds bounded schema/data replication, durable deduplication and a recoverable DDL journal. See the [phased plan](../PLAN/OPTION_1_TECHNICAL_PLAN.md).

Phase 1 is validated: [results and compatibility findings](../PLAN/PHASE_1_RESULTS.md), [captured Maxwell messages](../Fixtures/phase1/capture.json).

Phase 2 is validated: [schema/data replication results](../PLAN/PHASE_2_RESULTS.md).

Phase 3 is validated: [reusable harness and negative assertion results](../PLAN/PHASE_3_RESULTS.md).

Phase 4 is validated: [crash/outage recovery, quarantine and repair results](../PLAN/PHASE_4_RESULTS.md).

Phase 5 is validated: [complete scenario matrix, measured load results and assessment](../PLAN/PHASE_5_RESULTS.md).

## Run

The phase-numbered commands below remain available alongside the page-named commands in the quick start.

Prerequisite: Docker with Compose v2 and enough resources to build Swift and run two databases plus Java services. A host Swift installation and GCP credentials are not required. First startup downloads images and builds dependencies; subsequent builds use Docker caching.

```sh
make e2e      # Fresh isolated smoke suite: append, CRUD, schema change
make e2e-checks # Smoke suite plus deliberate missing-event/wrong-value checks
make mysql57-checks # Three fresh target DB starts, each with a warm restart
make phase2   # Fresh isolated stack: schema/data convergence and recovery checks
make phase4   # Fresh isolated stack: real crashes, outages, quarantine and repair
make phase5   # All mandatory scenario gates (multiple fresh stacks)
make e2e-load # Opt-in: 1,000-row transaction + 1,000 continuing writes
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

For a dashboard demonstration, start `make dashboard`, open Basic replication with **Follow latest** enabled, and run `make test-basic-replication`. This single command covers smoke and both verifier checks; its default 250 ms pause between statements makes incoming evidence easier to follow. `make dashboard-test-live` automates this workflow with Chromium open throughout and checks the live count changes and final results.

The Phase 3 audit/DLQ observer retries temporary Pub/Sub RPC failures up to three times per call, with 250 ms, 500 ms and 1 s backoff. Each RPC retains its five-second deadline; persistent errors still fail the run. `observer-retries.json` records operation, subscription, retry number, timestamp and error. Event validation and expected-failure predicates remain unchanged.

Evidence is under `artifacts/maxwell-e2e-*/`: configuration/seed, workload plans, expected event manifest, raw deliveries (including duplicates and any DLQ records), semantic schema/row comparisons, explicit diffs, ledger/journal/checkpoints, scenario and run JSON results, versions, build/startup/harness/service logs, container/image state and capture checkpoint. Per-service `*-container.json` and `*-processes.txt` preserve health-check history and process state before cleanup, including when startup fails before the harness launches. `host-result.json` distinguishes the host/self-test exit code from the actual harness exit code. Inspect `run-result.json` and `*-diffs.json` first on assertion failure, or `startup.log` and the affected service's diagnostics on startup failure.

The host runner owns container lifecycle and the timeout; no Docker socket is mounted in Swift. By default, runs remove only their own containers/volumes and retain artifacts. `KEEP_ON_FAILURE=1` retains failed infrastructure and its volumes for inspection. `KEEP_STACK=1` retains the stack after either success or failure. Existing stacks are not reset. Phase 4 adds real restart/outage and quarantine/repair tests below; Phase 5 aggregates the scenario matrix and load assessment. `make phase2` still runs the detailed type-boundary and target-journal regression checks.

### Keep a test stack for inspection

```sh
make e2e SCENARIO=crud KEEP_STACK=1
make phase4 KEEP_STACK=1
make e2e-load KEEP_STACK=1
KEEP_STACK=1 bash scripts/phase5.sh malformed
```

`KEEP_STACK` accepts `0` (default cleanup) or `1` (retain on success and failure). `KEEP_ON_FAILURE=1` remains supported and retains failures even with `KEEP_STACK=0`. The test exit code and evidence are preserved in either mode.

A retained run prints its run ID, Compose project, artifact directory, source/target port lookup commands, dashboard link and exact cleanup command. The same instructions are saved in `artifacts/<run>/retained-stack.txt`. The commands include the run's Compose files and environment, including the Phase 4 override. Run the printed dashboard command to import the results and start the viewer. The cleanup command removes only that project's containers and database volumes; saved artifacts remain.

Retention applies to end-of-run cleanup. Test-controlled stops, kills, restarts and timeouts still execute. Containers keep the state left by the test: Phase 2 stops its consumer during target-recovery checks, and Phase 4 ends with a stopped consumer after the emulator-loss check. Completed temporary probes are removed as usual. A startup failure retains the resources created up to that point.

The flag also applies to `make phase2`, `make e2e-checks` and every child of `make phase5`. A complete retained Phase 5 suite keeps eight separate stacks, so use a single scenario for routine inspection and run each printed cleanup command when finished.

Lifecycle regression checks run with `make dashboard-data-test` using an isolated fake Docker executable. See [retention verification](../PLAN/STACK_RETENTION_RESULTS.md) for the real retained CRUD run.

## Complete suite and load assessment (Phase 5)

`make phase5` runs six mandatory gates: Phase 3 smoke/assertion self-tests, Phase 2 type/key/DDL checks, Phase 4 recovery, malformed input, unsupported source DDL, and transaction/load checks. A failed gate stops the suite; `artifacts/maxwell-phase5-suite-*/suite-result.json` records completed versus required gates. Its logs identify every child evidence directory. No scenario is silently skipped. The final workload gate rebuilds/reseeds a fresh source history after the emulator-loss and poison tests; it does not resume a lost queue.

```sh
bash scripts/phase5.sh workload    # Only new transaction/backlog gate (12 + 12 rows)
bash scripts/phase5.sh malformed   # Raw invalid JSON: durable block, restart, failed repair
bash scripts/phase5.sh unsupported # Actual source MODIFY COLUMN: same fail-closed checks
make e2e-load ROWS=1000 SEED=42 WRITE_INTERVAL_MS=1
```

The workload verifies a six-event multi-row/multi-table transaction, repeated updates and delete within it, and a rolled-back insert/update/delete transaction. With the consumer stopped, it commits another `ROWS`-event transaction spanning two tables. The host explicitly rotates source binlogs, records a recovery boundary, starts the consumer, then writes `ROWS` more autocommit events while the backlog drains. Ordered audit events, transaction IDs/offsets/final-row markers, target commit order, full ledger payloads, independent schemas/rows, final checkpoint, empty head/journal and zero DLQ/quarantine must all agree. Rollback operations are deliberately absent from the independently generated manifest, so any leaked intermediate event fails verification.

The existing `ROWS` (2–5000), `SEED`, `WRITE_INTERVAL_MS`, `CONVERGENCE_TIMEOUT` and `DRAIN_SECONDS` settings apply. `make e2e-load` defaults to 1000 rows in each segment, 1 ms requested pacing, a 600-second convergence limit and an 1800-second host watchdog **per probe**; the small suite defaults to 12, 10 ms, 60 and 300 respectively. SQL, evidence writes and observation add to pacing. Increase watchdog/timeouts for slow hosts. This is a bounded load characterization, not a soak test or capacity/SLA guarantee.

Small backlogs may drain before the continuing writer starts. `backlogAtStreamStart` records this explicitly; runs with `ROWS >= 1000` require a nonzero backlog at that point to establish actual overlap.

Evidence under `artifacts/maxwell-phase5-*/` includes intent/model/audit/observations in `load-state.json`, commit-ordered `load-ledger.json`, raw latency samples, `load-metrics.json`, explicit binlog rotation, versions/images and timestamped Docker memory/CPU samples for consumer and Maxwell. Latency starts immediately before the source autocommit statement or transaction COMMIT and ends at first polling observation of its ledger entry. It is an upper bound including outages, start/probe overhead and observer delay (every ten streaming writes, then roughly every 100 ms); it is **not** native commit-to-commit latency. Backlog events/second is initial unapplied DML divided by time from the pre-start marker until all those events are observed applied, while new writes continue. Stream events/second includes writing, convergence and the final drain window. Docker memory is sampled, not an allocator high-water mark. Debug builds, instrumentation, QEMU and shared Docker resources materially affect results.

Negative poison gates require exactly one unique diagnostic, original bytes/message/source identity, the expected parse/policy reason, a retained blocked head, unchanged ledger/checkpoint/schema, and proof a captured following event never applies. Restart and exact-byte repair without a code/policy fix must leave the block intact. **Malformed bytes and unsupported DDL are not automatically repairable**; the command cannot skip or replace them. Successful exact-byte repair is tested by Phase 4's target-drift fixtures. A reviewed decoder/policy fix or an explicit disposable rebuild is required for these negative fixtures; the suite does not claim successful in-place repair of them.

## Recovery and quarantine (Phase 4)

`make phase4` builds a fresh isolated stack, retains volumes across injected restarts, and records evidence under `artifacts/maxwell-phase4-*/`. Each Swift probe has a 120-second host watchdog. `KEEP_ON_FAILURE=1 make phase4` retains a failed project for inspection. Only its test-specific Compose override enables file-controlled pause points; the host sends actual SIGKILL signals without exposing the Docker socket to Swift.

The consumer durably stores a single in-flight envelope in `cdc_meta.consumer_head` before applying it. On reconnect/restart, that head is handled before another pull. Transient target/transport failures retry with exponential backoff (250 ms through 5 seconds), without an attempt limit or automatic broker DLQ forwarding. A separate task renews a 10-second acknowledgement deadline every 3 seconds while a live delivery is retained. A target connection loss causes reconnect and reacquisition of the single-writer lock. Unknown infrastructure errors fail visibly without ACK.

A permanent event error atomically records original bytes, source identity when decodable, Pub/Sub message identity, reason and a diagnostic ID in `cdc_meta.quarantine`, and marks the head blocked. Only after this durable write and successful DLQ publication may the delivery be acknowledged. A publish response/state-update crash can duplicate diagnostics; observers deduplicate by the persisted `failureID` and validate identical contents. The blocked head survives restart, makes the health check fail, and prevents all later application writes. Changing `SOURCE_ID` cannot bypass an existing head. A quarantine is not successful replication.

To repair a blocked stream, stop its consumer, inspect `consumer_head`/`quarantine`, and correct the underlying target or supported-policy issue. Then run the exact-byte replay command using the **same project and SOURCE_ID**:

```sh
docker compose stop consumer
# Inspect and correct the failure cause first; do not delete quarantine/ledger rows.
docker compose run --rm --no-deps e2e repair
docker compose start consumer
```

For an isolated retained project, set `COMPOSE_PROJECT_NAME` and `SOURCE_ID` to its printed name and preserve its Compose environment. Repair takes the same writer lock, republishes any outstanding diagnostic, and retries the unchanged stored payload. It marks quarantine resolved and clears the head only after successful application; interrupted repair safely retries through the apply ledger/DDL journal. Failed repair leaves the stream blocked. There is deliberately no skip or replacement-payload option: malformed data or unsupported DDL may require a reviewed code/policy correction, or an explicit clean rebuild, rather than an unsafe automatic translation.

The recovery gate covers DML kills before commit and after commit/before ACK, DDL kill after implicit commit/before journal completion, lease renewal across a pause longer than the lease, target outage with source writes, Maxwell/source restarts, old-update republication, and two deliberate target-drift poison events. It kills between quarantine persistence/publication and between publication/publication bookkeeping, proves blocked progress across restarts, rejects an unfixed repair, restores the missing target row, and replays the original failed event before draining later updates. Every convergence check reconciles an independent operation manifest, audit and full ledger payloads, modeled source/target rows/schema, checkpoint, completed DDL, and resolved quarantine. Positive stages require zero DLQ; negative stages require exactly their expected unique diagnostics.

Maxwell's capture checkpoint remains in the **source** `maxwell.positions`; the consumer's applied checkpoint and full replay ledger remain on the **target**. The ledger is not pruned during the POC. Capture progress alone does not establish successful application.

The pinned Maxwell defaults to one binlog reconnect attempt and can exit during a source restart. Its Compose service uses `restart: on-failure` to resume the persisted capture position with Docker's restart backoff. The consumer itself does not auto-restart on fatal queue-loss/configuration errors; those remain visible and require operator action.

The final gate restarts the emulator, verifies its resources disappeared, and requires a visible consumer failure with no checkpoint/ledger advancement. Queue loss is **not** durable broker recovery. Stop writers and all components; retain artifacts if needed, then explicitly remove only that disposable project's volumes and start a fresh project/source identity, recreating schema/data from the original workload. For the default disposable stack this is `make reset` followed by `make up`; `make e2e` always creates a fresh project. Do not merely recreate subscriptions and resume old checkpoints: missing queued changes cannot be recovered that way. Existing-data snapshot/bootstrap and real Pub/Sub durability remain out of scope.

## Phase 2 checks and contract

`make phase2` creates a uniquely named Compose project, fresh database volumes, a fresh source-history namespace and ephemeral localhost ports. It leaves an existing Phase 1 stack untouched. Default cleanup removes its test containers/volumes; artifacts remain under `artifacts/maxwell-phase2-*/`. Use `make phase2 KEEP_STACK=1` to retain any result, or `KEEP_ON_FAILURE=1 make phase2` to retain failures. Follow the printed inspection and cleanup commands.

The Swift harness provisions schemas **only on 8.4** and checks ordered event accounting, normalized schemas, sorted row values, the apply ledger, the final checkpoint, completed DDL journals and an empty DLQ. Its workload covers composite/changed primary keys, repeated updates, deletes, add-column followed immediately by writes, index creation/removal, drop/recreate, unsigned 64-bit integers, DECIMAL(65,30), Unicode, binary, JSON, SQL NULL versus JSON null, and microsecond datetime/timestamps. Republishing an old update must not change newer target state. Separate target integration checks inject errors after mutation to exercise transactional rollback and DDL recovery; these are not process-crash/ACK-boundary tests.

The consumer pulls one event at a time and ACKs successful replication only after target commit. DML, the event ledger and the checkpoint share an InnoDB transaction. DDL first records durable before/after schema expectations; replay either executes from the before-state or recognizes the after-state, rejecting unrelated drift. A target advisory lock prevents concurrent appliers. Phase 4 extends this with renewable leases, retries and a durable blocking quarantine (described above). The positive empty-DLQ check is meaningful only together with event accounting.

Supported DDL is intentionally narrow:

- Only `poc`, portable ASCII identifiers, InnoDB and `utf8mb4_unicode_ci`. Database creation must specify `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`; tables require an explicit `ENGINE=InnoDB` and a primary key.
- `CREATE TABLE`, trailing `ALTER TABLE ADD [COLUMN]` for nullable/defaulted non-key columns, ordinary ascending full-column indexes (`CREATE/DROP INDEX` and `ALTER TABLE ADD/DROP INDEX`), and single-table `DROP TABLE`.
- Integer types (optionally unsigned), explicit-length CHAR/VARCHAR/BINARY/VARBINARY, TEXT/BLOB, DECIMAL(p,s), JSON, DATE and TIME/DATETIME/TIMESTAMP with precision 0–6. Non-null defaults are limited to canonical integer literals and CHAR/VARCHAR strings; no expressions, auto-increment, generated columns, foreign keys, unique secondary indexes, column reordering or arbitrary comments. MySQL's exact generated DROP TABLE comment is accepted.
- Sessions use UTF-8, UTC, strict mode and no backslash SQL escapes. Identifiers are quoted and row values are bound, never concatenated into SQL. Exact JSON number tokens avoid Double/Decimal rounding.

Capture configuration is part of the wire contract: `binlog_row_image=FULL`, no excluded columns, and **`output_nulls=false`**. An omitted column means SQL NULL; an explicit JSON null means JSON `null`. Maxwell's [JSON writer](https://github.com/zendesk/maxwell/blob/v1.46.0/src/main/java/com/zendesk/maxwell/row/MaxwellJson.java) retains raw JSON null while omitting SQL NULL. Changing this setting independently of the applier is unsafe. Existing Phase 1 queued payloads are not a migration path: use a fresh project/history for Phase 2. The new target metadata grant also requires fresh volumes; init SQL does not rerun against old volumes.

The pinned Maxwell build includes a tested adapter for standalone index DDL, which upstream otherwise blacklists. It routes these events through Maxwell's normal schema history/filter/DDL publisher without changing its row decoder. Broader operations Maxwell suppresses (for example TRUNCATE, triggers and procedures) are outside this POC; do not use them and assume they will reach the consumer. Phase 5 tests captured-but-unsupported MODIFY COLUMN; general capture coverage remains follow-up work.

## Phase 1 checks

`make phase1` starts the stack, then a containerized Swift harness:

- Connects to both databases and verifies their versions.
- Creates a temporary Pub/Sub subscription, publishes with an ordering key, pulls, extends the acknowledgement deadline, forces redelivery, verifies identity/payload, and acknowledges.
- Provisions a table only on the source and immediately writes a three-row insert, two updates in one transaction, and a delete.
- Asserts seven distinct events in exact order with the expected row IDs/values and ordering key. Confirms the three inserts share a binlog position but have distinct event identities.
- Stops Maxwell, runs a read-only replay from the saved binlog position with the same configuration, and verifies the seven source identities survive republication.
- Checks the DLQ observer and verifies the target has no application tables yet. Restores normal Maxwell and preserves diagnostic artifacts, including on failure.

New Phase 1 evidence is written under ignored `artifacts/maxwell-phase1-*/`: `capture.json`, `replay.json`, container logs, image inventory and run metadata. Older shared-root artifacts are preserved. Run fixtures use unique table/subscription names, so tests can be repeated without resetting databases. Phase 1 leaves source probe tables and the main/audit subscription backlog available for inspection.

The Phase 1 runner sets `CONSUMER_MODE=observe`, using only `cdc-diagnostic`. Run it on a Phase 1/empty-target project, not a populated Phase 2 target. Normal Compose startup defaults to `apply` on `cdc-consumer`. The Phase 1 diagnostic mode does not route errors to the DLQ, so its empty-DLQ assertion is only a baseline check.

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
