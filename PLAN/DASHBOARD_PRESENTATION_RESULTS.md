# Dashboard Phase 2.5 — narrative presentation

Implemented after Phase 2 commit `35c1428` and approved for a Phase 2.5 checkpoint on 2026-09-28. Further styling and wording corrections will follow separately.

## Reading order

1. **Introduction:** literal POC title, Mermaid architecture including the consumer-to-DLQ branch, Docker/harness explanation, and scope of the decision the evidence can support.
2. **Basic replication:** Phase 3 schema/data replication and checks that the verifier catches missing or incorrect changes.
3. **Recovery:** Phase 4 service interruption, replay, repair and visible detection of emulator state loss.
4. **Failure handling and load:** Phase 5 invalid-input blocking and transaction/backlog tests. Each experiment remains a separate selected run.

Each test page contains its own run selector, recorded architecture, procedure, verification method, results and limitations. The technical evidence browser remains at `/evidence`, including supporting Phase 1–2 and suite results.

## Recorded architecture

- Source → Maxwell → Pub/Sub emulator → Swift consumer → target, with a visible consumer-to-DLQ branch on every test page.
- DLQ deliveries always visible: `0` when recorded as zero, `Not recorded` when absent. Unique failures and expected failures remain separate; duplicate diagnostics are not treated as extra failed events.
- Container name/image, snapshot state and Docker restart counter are extracted through a whitelist. Full inspection/environment files remain private. Service-log links filter the recorded Compose log, not live containers.
- Memory appears only for Maxwell and the Swift consumer; timing is end-to-end. No MySQL memory or unrecorded per-service timing is invented.
- Event categories use observed payloads where available. Expected-only categories are labeled; unavailable invalid-input counts are not zero. Setup and marker events are included. Event table names and `cdc_meta.applied_events` distinguish application data from consumer bookkeeping.
- The harness strip shows the run's artifact directory. Script links are explicitly the current checkout; historical code provenance remains in run details.

## Verification

- Type checking and 31 Node tests, including safe container extraction, secret exclusion, event categories, syntax checks and existing importer fixtures.
- 40 Playwright checks across desktop/narrow layouts, including phase-scoped selection/pins, failed default selection, the Mermaid DLQ branch, zero/nonzero/missing DLQ counts, service logs, source allowlists, memory scope and original evidence-browser checks.
- 16 screenshot baselines cover the four narrative pages and four technical views at both viewport sizes. The crowded first introduction diagram was simplified during visual review; its test-harness procedure is explained directly below.
- The dependency audit reported no vulnerabilities after pinning Mermaid 11.17.2 and updating the compatible transitive dependency. Mermaid is locally bundled; browser tests remain offline.
- A strict Playwright rerun passed all 40 checks without updating screenshots. Chromium also checked retained real runs: basic replication showed 19 row-change and 4 schema-change events with 0 DLQ deliveries; recovery showed 3 DLQ deliveries for 2 unique failures; load showed 5.805 MiB consumer and 309.2 MiB Maxwell sampled peaks. The viewer is running at localhost:4173. Architecture screenshots are retained in `dashboard/.generated/narrative-real-basics.png` and `narrative-real-load.png`.

Automatic refresh, follow-latest watching, safe static export and new POC-run integration remain dashboard Phase 3. Existing raw artifacts and the Swift replication application are unchanged.
