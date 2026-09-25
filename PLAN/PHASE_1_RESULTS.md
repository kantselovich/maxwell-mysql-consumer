# Phase 1 results

Status: **complete**, validated locally on 2026-09-25 on Apple Silicon with Docker Desktop.

`make phase1` passed with the final configuration. The runner verified live capture and actual Maxwell binlog replay, then restored healthy normal capture. The final replay log contains no exceptions or error entries during shutdown.

## Tested versions

| Component | Version / configuration |
| --- | --- |
| Source | MySQL 8.4.8, native ARM, ROW/FULL binlogs |
| Target | MySQL 5.7.42 Debian, amd64 emulation, native AIO disabled |
| Maxwell | 1.46.0 distribution, custom Pub/Sub runtime and shutdown guard |
| Java runtime | Temurin 21.0.7+6, native ARM |
| Pub/Sub emulator | Google Cloud CLI `543.0.0-emulators`, amd64 |
| Swift | 6.2.1, Linux ARM and macOS ARM builds |
| Swift dependencies | MySQLNIO 1.9.1, gRPC Swift 1.27.6, SwiftProtobuf 1.31.1, SwiftNIO 2.90.0 |

The full Swift dependency graph is pinned in `Package.resolved`; Compose/Dockerfiles pin image versions. Each gate run also records the actual image IDs in `artifacts/images.json`.

## Evidence

- Both MySQL versions were queried successfully from Swift, using the initialized application account.
- Swift created/read subscriptions and published/pulled messages through the emulator. Acknowledgement extension and forced redelivery preserved message ID and payload; acknowledgement and subscription deletion succeeded.
- Source-only `CREATE TABLE`, a three-row insert, two successive updates to the same row in one transaction, and a delete produced exactly seven distinct table events in the expected order with the fixed `mysql84` ordering key.
- All row IDs and values matched expectations. The three inserts shared one binlog position; `xoffset=0`, `xoffset=1`, and the final-row commit marker distinguished their identities.
- A separate Maxwell process replayed from the recorded binlog boundary and heartbeat. All seven source identities, operation order, and expected payload values matched the original capture.
- The DLQ subscription was empty. This is a baseline assertion: consumer failure routing is not implemented yet.
- The target remained free of replicated application tables, as expected for Phase 1.
- Three event-identity unit tests passed on both Linux and macOS. Compose configuration and shell syntax validation passed.

A retained real-message fixture is in [Fixtures/phase1/capture.json](../Fixtures/phase1/capture.json). Per-run artifacts include the original/replayed payloads, exact replay argument, probe output, service logs, image IDs, and `result.json` with the exit code.

## Compatibility fixes included

1. The stock MySQL 5.7.44 Oracle Linux image crashed during initialization under this host's QEMU. MySQL 5.7.42 Debian initialized and ran successfully. The failed, newly created target initialization volume was replaced; it contained no application data.
2. Maxwell's stock image included incompatible Google libraries: Pub/Sub publisher construction failed with `NoSuchMethodError: setUniverseDomain`. The custom image prepends the dependency graph resolved for Google Pub/Sub Java 1.132.3.
3. DDL and DML must use the same publisher. Leaving `ddl_pubsub_topic` unset avoids the upstream Java string-reference comparison issue. A checksum-verified one-line publisher patch prevents closing that shared publisher twice.
4. Maxwell's amd64 Java 23 runtime produced socket/thread-signal exceptions under QEMU during shutdown. Running its Java distribution on native Temurin 21 removed those errors in the final gate.
5. Replay requires the heartbeat component of `FILE:POSITION:HEARTBEAT` to select the appropriate historical schema. The runner uses the persisted heartbeat after stopping capture as the lookup upper bound.

## Next phase

Phase 2 can implement the MySQL 5.7 applier against the captured payloads: supported DDL, parameterized DML, durable deduplication/checkpoints, and acknowledgement after target commit. The captured DDL `def` is not a complete target schema specification; use the original `sql` with the bounded compatibility policy to retain lengths, nullability, and other required details.

This result does not establish target data/schema convergence, crash-safe application, GTID recovery, existing-data bootstrap, broad DDL/type compatibility, scale, or production Pub/Sub behavior. Those remain in the later phases. The deployed target's exact MySQL 5.7 patch version must also be validated separately.
