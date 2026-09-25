# Maxwell MySQL replication POC

Local MySQL 8.4 → Maxwell → Google Pub/Sub emulator → Swift diagnostics, with MySQL 5.7 available as the eventual replication target.

Phase 1 establishes compatibility and captures ordered events. **It does not yet apply schema or data to MySQL 5.7.** See the [phased plan](PLAN/OPTION_1_TECHNICAL_PLAN.md).

Phase 1 is validated: [results and compatibility findings](PLAN/PHASE_1_RESULTS.md), [captured Maxwell messages](Fixtures/phase1/capture.json).

## Run

Prerequisite: Docker with Compose v2 and enough resources to build Swift and run two databases plus Java services. A host Swift installation and GCP credentials are not required. First startup downloads images and builds dependencies; subsequent builds use Docker caching.

```sh
make up       # Build and wait for database, emulator, Maxwell and observer readiness
make phase1   # Run compatibility checks and actual Maxwell binlog replay
make logs
make down     # Stop, retaining database volumes
make reset    # Delete only this Compose project's containers and volumes
```

MySQL 5.7 and the emulator are pinned to amd64 images; Docker Desktop emulates these on Apple Silicon. Swift, MySQL 8.4, and Maxwell's Java runtime run natively on ARM. Ports bind to localhost: MySQL 8.4 `13384`, MySQL 5.7 `13357`, emulator `18085`. Credentials in Compose/init SQL are local test credentials only.

The local target uses `mysql:5.7.42-debian` with native AIO disabled. The `5.7.44` Oracle Linux image crashed during initialization under this host's QEMU emulation. Validation against the deployed 5.7 patch version remains a follow-up check.

## Phase 1 checks

`make phase1` starts the stack, then a containerized Swift harness:

- Connects to both databases and verifies their versions.
- Creates a temporary Pub/Sub subscription, publishes with an ordering key, pulls, extends the acknowledgement deadline, forces redelivery, verifies identity/payload, and acknowledges.
- Provisions a table only on the source and immediately writes a three-row insert, two updates in one transaction, and a delete.
- Asserts seven distinct events in exact order with the expected row IDs/values and ordering key. Confirms the three inserts share a binlog position but have distinct event identities.
- Stops Maxwell, runs a read-only replay from the saved binlog position with the same configuration, and verifies the seven source identities survive republication.
- Checks the DLQ observer and verifies the target has no application tables yet. Restores normal Maxwell and preserves diagnostic artifacts, including on failure.

Evidence is written under ignored `artifacts/`: `capture.json`, `replay.json`, container logs, and image inventory. Run fixtures use unique table/subscription names, so tests can be repeated without resetting databases. Phase 1 leaves source probe tables and the main/audit subscription backlog available for inspection.

The regular `consumer` service is a diagnostic observer on `cdc-diagnostic`. It acknowledges only its diagnostic subscription; `cdc-consumer` is reserved for the Phase 2 applier. There is no DLQ error routing yet, so the Phase 1 empty-DLQ assertion is only a baseline check.

## Implementation notes

- SwiftPM modules separate event decoding, MySQL access, Pub/Sub transport, the CLI, and the diagnostic harness. `make test` builds the Linux executable and runs the event-identity unit tests.
- Pub/Sub uses generated SwiftProtobuf messages and gRPC Swift 1.x unary calls. The small `.proto` is an explicitly limited projection of the public v1 API, not a complete Google client. Connections are plaintext and emulator-only.
- MySQL uses row binlogs with full row images and seven-day retention. Both database volumes are persistent, including Maxwell schema/position metadata.
- Maxwell v1.46.0 compares DDL/DML topic Java string references. `ddl_pubsub_topic` is deliberately omitted so the default shares the same publisher, emulator channel, and fixed `mysql84` ordering key. Do not explicitly set it to an equal-looking string. [Upstream implementation](https://github.com/zendesk/maxwell/blob/v1.46.0/src/main/java/com/zendesk/maxwell/producer/MaxwellPubsubProducer.java).
- The stock Maxwell image also mixes incompatible Google Java libraries and fails when constructing its Pub/Sub publisher (`NoSuchMethodError: setUniverseDomain`). The custom image prepends the dependency graph resolved for its pinned Pub/Sub 1.132.3 client. It also recompiles the checksum-verified publisher source with a one-line guard to close a shared DDL/DML publisher only once. These are POC-specific adjustments; other Maxwell producers are not validated.
- Maxwell's distribution is copied into a native Temurin 21.0.7 runtime. Its stock amd64 Java 23 runtime produced socket-close/thread-signal exceptions under QEMU on this host.
- Event identity uses a configured source-history namespace, binlog file/position, and transaction row offset; Maxwell omits the offset on the final row, which receives a distinct `commit` suffix. DDL uses a `ddl` suffix. Resetting source binlogs requires a new namespace or a clean target/ledger. Broader DDL and bootstrap event identities are future work.
- Replay passes `FILE:POSITION:HEARTBEAT`, taking the persisted heartbeat after stopping capture as the schema lookup upper bound. Omitting the heartbeat can restore the initial schema even when later DDL precedes the requested position. The exact argument is recorded in `artifacts/replay-position.txt`.
- The emulator loses resources/messages when restarted. `make down`/`make up` therefore preserves databases but cannot preserve the queue. Phase 1 generates fresh workloads after startup; this is not a durable broker recovery test. Use `make reset` for a clean baseline.

Source/target replication, recoverable DDL, durable deduplication, and failure/DLQ handling remain in subsequent phases.
