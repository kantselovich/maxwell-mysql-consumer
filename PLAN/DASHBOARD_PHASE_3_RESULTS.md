# Dashboard Phase 3 — automatic refresh and static snapshots

Implemented after the reviewed database-view checkpoint `2667f4b`.

## Available commands

- `make dashboard`: start the local viewer and artifact watcher.
- `make dashboard-data`: explicitly regenerate reporting data.
- `make dashboard-build [RUN_IDS=id1,id2]`: create a new static snapshot under `dashboard/.generated/snapshots/`.
- `make dashboard-test`: run the fixture, refresh, export and visual browser gate.
- `make dashboard-test-live`: open Chromium, execute the Basic replication page command, and verify changing counts during the workload and all three final results.
- `make dashboard-stop`: stop the viewer and watcher, leaving test stacks alone.

The watcher debounces file changes, serializes imports and publishes by atomic rename. The browser refreshes automatically, keeps manually selected historical runs selected, and offers **Follow latest**. Per-run evidence revisions refresh changed captures. Reporting errors preserve the previous report and appear separately from test verdicts. Partial/interrupted runs retain evidence-based incomplete, unknown or failed states.

Static snapshots record their selected run IDs and generation time. They contain counts, checks and numeric measurements with safe supporting files. Raw database/SQL captures, configuration, container identities and logs remain local. Local-only references are text labels. Static pages use ordinary `.html` links and local assets.

## Verification

- TypeScript checks and 69 Node tests passed, including atomic publication, recovery after reporting errors, output boundaries, export selection and private-field exclusion.
- 48 Playwright checks passed with strict desktop/narrow screenshot comparisons. Updated presentation baselines were reviewed. The gate includes first-run discovery, no-reload refresh, historical selection, newer expected failures/startup failures/interrupted runs, changed row captures, reporting outages and recovery.
- Static browser checks removed the original artifact directory before serving the exported files, then verified selected IDs, counts, safe evidence links, memory and latency charts.
- `make dashboard-build` exported real evidence to `dashboard/.generated/snapshots/snapshot-20260929013617845-vdNxbB/`. A network-isolated Chromium check served only those files and verified the fresh run, 13 applied events and zero API requests/errors. A scan of all 24 exported files found none of the tested credential, user-path or database-value markers.
- Fresh CRUD run: `maxwell-e2e-1790645550-78972`, host/harness exit 0, 13 expected/captured/applied events, matching schema/rows, zero DLQ. Chromium verified the watcher-published run and its counts against the raw event manifest.
- Live browser evidence: `dashboard/live-results/live.bQHnOL/` (screenshot, trace, browser result and logs). Test artifacts remain under `artifacts/maxwell-e2e-1790645550-78972/`. The fresh stack's containers and volumes were removed by normal harness cleanup; existing retained stacks were preserved.

Earlier live attempts (`maxwell-e2e-1790644685-73484` and `maxwell-e2e-1790645324-77424`) passed replication but their Chromium page crashed during full-stack startup. Their browser diagnostics remain in `dashboard/live-results/live.C6EprC/` and `live.glk1j0/`. The initial CRUD-only gate verified the page after the POC finished. The completion gate now keeps Chromium open throughout the full Basic replication command. The browser fixture gate uses one worker alongside retained stacks.

## Full-command completion gate

The reported failure in `maxwell-e2e-1790646114-82981` came from a five-second Pub/Sub RPC timeout in the audit/DLQ observer. The observer now retries each temporary transport failure up to three times with bounded backoff, recording operation/subscription diagnostics in `observer-retries.json`. Persistent errors, missing resources, invalid events and evidence mismatches still fail. Cancellation stops retries. Audit deliveries are saved before querying the DLQ, and ACK retries leave already-recorded batches intact.

The Basic replication page shows `make e2e-checks WRITE_INTERVAL_MS=250`: one smoke run and two verifier self-tests. `make dashboard-test-live` checks that exact text, opens the browser before starting it, and requires changing captured counts before the smoke result exists, automatic selection of new runs, and all three final verdicts checked against raw artifacts. Screenshots and a page marker establish that the same page stayed open throughout.

The new retry tests cover eventual success, exhausted retries, permanent failures and cancellation. All 25 Swift tests pass.

Full live gate passed with evidence in `dashboard/live-results/live.i2KhEF/`:

| Run | Check | Expected / captured / applied | DLQ | Outcome |
| --- | --- | --- | --- | --- |
| `maxwell-e2e-1790646916-92786` | Append, CRUD, schema changes | 55 / 55 / 55 | 0 | Passed |
| `maxwell-e2e-1790647067-94104` | Missing-event verifier | 23 / 21 / 21 | 0 | Expected `event-manifest` error detected |
| `maxwell-e2e-1790647146-94733` | Wrong-value verifier | 23 / 23 / 23 | 0 | Expected `row-mismatch` error detected |

The command and browser check both exited 0. Chromium recorded captured counts of 18 and 50 before the smoke result existed, then verified all three final dashboard verdicts and counts against the saved manifest, observations and ledger. Its page marker remained intact throughout. The evidence directory includes `browser-result.json`, `live-samples.json` (534 observations), `during-run.png`, three final screenshots, and `trace.zip`. Normal harness cleanup removed only these three new stacks and their volumes; retained user stacks were untouched. The viewer and watcher remain available on localhost:4173.

Open the completed smoke run at <http://localhost:4173/basics?run=maxwell-e2e-1790646916-92786>. Enable **Follow latest** when starting another demonstration.

The static export was rebuilt at `dashboard/.generated/snapshots/snapshot-20260929020152566-1ElcCF/`, selecting the latest basic verifier, recovery and malformed-input runs. All 24 exported files were scanned for the tested credential, local-path and raw database-value markers; none were present. The Basic replication and expanded database screenshots were reviewed and updated for the shorter command block at desktop and narrow widths.

Final regression gate: 25 Swift tests, 69 Node tests, TypeScript checks and all 48 Playwright checks pass. The final Playwright run used strict screenshot comparison and no retries. Shell syntax and `git diff --check` pass. Phase 3 is complete, user-verified and approved for commit.
