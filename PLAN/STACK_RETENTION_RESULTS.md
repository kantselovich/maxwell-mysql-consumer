# Test stack retention

Implemented after dashboard Phase 2.6 checkpoint `0b32186`.

`KEEP_STACK=1` skips end-of-run teardown for Phase 2, Phase 3 E2E, Phase 4 and Phase 5 runners. Suite children inherit the flag. The default cleanup and existing `KEEP_ON_FAILURE=1` behavior remain in place. Retention preserves test exit codes and collected evidence; test-controlled stops, restarts and watchdogs still execute.

Retained runs print and save `retained-stack.txt` with run/project identity, artifact location, inspection commands, database-port lookup commands, dashboard refresh/link and an explicitly scoped cleanup command. Commands include the Compose files and interpolation context for that run. Completed temporary probes still follow their normal lifecycle.

## Verification

- Shell syntax and `git diff --check` passed.
- Type checking and 61 Node tests passed, including 30 lifecycle checks with a fake Docker executable. These cover success/failure, default/explicit retention, legacy retention, partial startup, invalid flags, suite propagation, preservation of fault-injection actions and quoted cleanup commands from a different directory.
- The same tests passed in the pinned reporting container via `make dashboard-data-test`.
- Real test: `make e2e SCENARIO=crud ROWS=2 KEEP_STACK=1` passed as `maxwell-e2e-1790641027-35225`: 13 events, matching schemas/rows, zero DLQ deliveries and host/harness exit 0.
- After completion, MySQL 8.4, MySQL 5.7, Maxwell, Pub/Sub and the consumer remained healthy, both named database volumes remained attached, and the completed harness remained inspectable. Direct reads from both databases returned the matching CRUD data; the target ledger contained 13 applied events.
- This test stack is retained for inspection. Its saved instructions contain the cleanup command. Existing user stacks were left untouched. The dashboard report was refreshed with the new evidence.

The initial sandboxed launch stopped before building because Docker's builder activity directory was inaccessible. Its failure evidence remains under `artifacts/maxwell-e2e-1790641009-31806/`; the approved rerun above completed successfully.
