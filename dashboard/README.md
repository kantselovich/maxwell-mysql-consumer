# POC evidence dashboard

Phases 1–2 provide an artifact importer, read-only Observable Framework viewer, and Playwright data/visual checks. Presentation updates add the introduction, separate test pages, recorded architecture and saved database views. Phase 3 adds automatic refresh and static snapshots; see [the dashboard plan](../PLAN/DASHBOARD_PLAN.md).

## Quick start

With Docker running, use `make dashboard` from the repository root and open [localhost:4173](http://localhost:4173). Choose a page from the top navigation and enable **Follow latest**, then run its **Run this test** command in a terminal. Results refresh while the page stays open. Use `make dashboard-stop` when finished.

The [repository quick start](../README.md#run-the-dashboard-and-tests) lists the commands for every page. The command-to-script mapping below identifies their runners and Compose files.

## Dashboard tooling commands

From the repository root, with Docker/Compose:

```sh
make dashboard-data       # Type-check/test the reporting image, then import artifacts
make dashboard-data-test  # Run the importer/host-metadata fixture suite in its container
make dashboard-view       # Import current artifacts and start http://localhost:4173
make dashboard            # Start viewer + artifact watcher
make dashboard-build      # Export latest individual run per test page
make dashboard-stop       # Stop dashboard viewer + watcher; leave test stacks alone
make dashboard-test       # Isolated Chromium fixture/data/visual gate
make dashboard-test-live  # Full basic suite with Chromium open throughout
```

Output: `dashboard/.generated/report.json`, ignored by Git. The standalone Compose file starts no replication services, mounts `artifacts/` read-only, and disables runtime networking for reporting and fixture browser tests. The viewer publishes only `127.0.0.1:4173`. Node is pinned to 24.13.0 and an image digest; npm development dependencies are locked. It does not mount a Docker socket or inspect live databases. The build needs package-registry access; the built viewer needs no external browser requests or fonts. A patched esbuild override avoids the upstream build dependency's Windows development-server advisory.

With `make dashboard` running, existing POC commands produce results that appear automatically. The watcher polls artifact metadata once per second, debounces changes, and imports at least every five seconds during continuing writes. Reports are published by atomic rename. The browser polls every two seconds, and a run's evidence revision invalidates its displayed data when supporting files change. No Observable data-loader cache is involved.

The Basic replication page shows `make test-basic-replication`. This runs the full smoke workload followed by the missing-event and wrong-value verifier checks, each with its own containers and database storage. The default 250 ms pacing makes incoming counts easier to follow. Keep **Follow latest** enabled to see new runs and their evidence as it arrives. Final verdicts appear after host checks and cleanup complete.

Page-named commands map directly to the existing scripts:

| Command | Existing runner | Compose files |
| --- | --- | --- |
| `make test-basic-replication` | `scripts/e2e-checks.sh` → `scripts/e2e.sh` | `compose.yaml` |
| `make test-recovery` | `scripts/phase4.sh` | `compose.yaml` + `compose.phase4.yaml` |
| `make test-invalid-json` | `scripts/phase5.sh malformed` | `compose.yaml` |
| `make test-unsupported-schema` | `scripts/phase5.sh unsupported` | `compose.yaml` |
| `make test-load` | `scripts/phase5.sh workload`, using the existing load defaults | `compose.yaml` |

Older phase-numbered commands remain available. The introduction and each test page offer **View Docker Compose configuration**, which loads these current project files on expansion. Recovery shows the consumer pause-point override as well as the base file. The source endpoint serves only allowlisted files as inert text; static exports omit this local configuration viewer. These files describe the current runner, while the selected run's recorded container details remain its historical evidence.

The page displays reporting freshness and watcher status. **Follow latest** selects newly dated attempts, including failures. Selecting a historical run or pinning it turns following off; its selection remains unchanged as other runs arrive. The latest button or checkbox resumes following. Start-only and interrupted attempts retain incomplete/unknown/failed evidence verdicts until terminal evidence establishes an outcome. Reporting errors preserve the last published report and appear separately from replication verdicts. A stopped or stale watcher is shown as paused.

`make dashboard-data` remains an explicit refresh command. An open page discovers the new report automatically. `make dashboard-view` starts the viewer; it leaves an already-running watcher active. `make dashboard-stop` stops both tooling services.

## Static build for GitHub Pages

With Node.js 24.13 or later, run from the repository root:

```sh
cd dashboard
npm ci
npm run build
npm run preview
```

Open [localhost:4175/maxwell-mysql-consumer/](http://localhost:4175/maxwell-mysql-consumer/). The preview uses the same repository subpath as `https://<username>.github.io/maxwell-mysql-consumer/` and serves only the built files.

`npm run build` imports local test artifacts when available. A fresh clone uses the sanitized snapshot checked into `published/`. `SNAPSHOT_ROOT=published npm run build` explicitly selects that snapshot, as the GitHub Actions workflow does. Both inputs pass through the same public-data export. The build then runs Observable Framework's `observable build` with `observablehq.static.config.js` to render the pages, bundle local assets and add the snapshot metadata through Framework's `head` setting. Framework's `preserveExtension` setting retains `.html` page links. Custom navigation, report requests and evidence links use relative URLs, so the same package also works at a domain root or another repository subpath. The local live viewer continues to use its separate configuration and `build:viewer` command.

The finished website is **`dashboard/dist/`**. Each successful build replaces the generated site, including its previously selected results. From local artifacts, the default selects the latest individual run from each of phases 3, 4 and 5, including failed attempts. From a saved snapshot, it preserves all runs listed in the snapshot manifest. To select exact runs, supply a comma-separated list (replace the example IDs with actual IDs):

```sh
RUN_IDS=maxwell-e2e-123-456,maxwell-phase4-123-456,maxwell-phase5-malformed-123-456,maxwell-phase5-unsupported-123-456,maxwell-phase5-workload-123-456 npm run build
```

Include each of the three Phase 5 scenarios to present invalid JSON, unsupported schema and load results together. Additional runs remain available in each page's selector. `snapshot.json` records the selected IDs and generation time. Local artifacts are read from `../artifacts`; `ARTIFACT_ROOT=/absolute/path/to/artifacts npm run build` selects another local evidence directory. An explicit artifact path must exist. Builds fail if a requested run ID is unavailable. Choose either `ARTIFACT_ROOT` or `SNAPSHOT_ROOT` for a build.

The package includes the introduction, three test pages, diagrams, verdicts, counts, checks and numeric memory/latency samples. SQL, database rows, configuration files, Git metadata, container names, logs and raw diagnostics stay local. Review the generated package and confirm permission to publish it.

### Publish from the full source repository

The [public repository](https://github.com/kantselovich/maxwell-mysql-consumer) contains the Swift application, Docker setup, test harness, dashboard source and the sanitized results under `dashboard/published/`. The [Pages workflow](../.github/workflows/pages.yml) runs on pushes to `main` and manual dispatch. It installs locked dependencies, type-checks and tests the dashboard tools, runs `SNAPSHOT_ROOT=published npm run build`, and uploads only `dashboard/dist/` for deployment. Replication experiments run locally; CI rebuilds their saved presentation.

Pages is configured under **Settings → Pages → Source → GitHub Actions**. The website is [kantselovich.github.io/maxwell-mysql-consumer](https://kantselovich.github.io/maxwell-mysql-consumer/). See [Observable deployment](https://observablehq.github.io/framework/deploying) and [GitHub publishing settings](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

To update the public results after rerunning tests, run from `dashboard/`:

```sh
npm run snapshot
# Or include a reviewed selection of actual run IDs:
RUN_IDS=<basic-run>,<recovery-run>,<invalid-json-run>,<unsupported-schema-run>,<load-run> npm run snapshot
```

`npm run snapshot` builds from local artifacts and replaces the generated `published/data/`, `published/evidence/` and `published/snapshot.json`. Review and commit those changes, then push to `main`. Source-only changes can be pushed with the existing snapshot. The workflow deploys the updated presentation. `npm run preview` is a local check and uploads nothing.

For another static host, upload the contents of `dist/`. The generated `.nojekyll` is also included for optional branch-based Pages hosting.

## Archived static snapshots

The existing Docker command creates a dated snapshot directory without requiring host Node.js:

```sh
make dashboard-build
# Or choose the exact individual runs for a presentation:
make dashboard-build RUN_IDS=maxwell-e2e-123-456,maxwell-phase4-123-456
```

Replace the example IDs with actual run IDs. The default selects the latest dated individual attempt from each of phases 3, 4 and 5, including failures. Each export creates a new directory under `dashboard/.generated/snapshots/`; the command prints its path. `snapshot.json` records the selected IDs, generation time and evidence policy.

The export includes the four presentation pages, local assets, selected verdicts, counts, assertions, measurements, exported check summaries and sanitized numeric memory/latency samples. Configurations, image/container names, Git metadata, table names, SQL plans, database rows, logs and raw diagnostics remain local. References to them display **Local evidence** as text. Included supporting files have working static links. Review the selected IDs and report before sharing.

Serve the generated directory at a domain root or repository subpath. From `dashboard/`, a local preview is:

```sh
node viewer/static.ts .generated/snapshots/<printed-directory-name> /maxwell-mysql-consumer/
# http://localhost:4175/maxwell-mysql-consumer/
```

The snapshot runs entirely from its own files, with no artifact directory, database, Docker socket or API server. Page links use relative `.html` paths. Browser fixture tests remove the source artifacts before checking the exported report, at both domain-root and repository-subpath URLs. A separate browser check executes `npm run build` and verifies the packaged pages, selected results, diagrams, charts and evidence files under `/maxwell-mysql-consumer/`.

## Views and interpretation

The presentation starts at `/` with **MySQL Third-Party Replication POC**, a Mermaid architecture diagram including the Swift harness (`e2e` service), its checks and saved artifacts, and the consumer's DLQ branch. The introduction explains Maxwell's change capture, Pub/Sub topics and subscriptions, and the test procedure. Follow the pages in order:

- `/basics`: Phase 3 — basic replication and verifier self-tests.
- `/recovery`: Phase 4 — interruption, replay, repair and emulator-loss detection.
- `/failures`: Phase 5 — malformed input, unsupported schema changes and transaction/backlog load, as separate selected runs.

Every test page, including the published static pages, shows **Run this test** commands before its run selector. On the public site, the instructions explain that the commands run locally from a clone with Docker running; publishing a new snapshot updates the displayed results. Each page selects individual runs from its own phase and defaults to the latest recorded start time, including failed attempts. Pins are separate for each local page. Suite records remain available in the normalized report; presentation pages show their individual experiments. The per-run architecture always includes a DLQ card: an observed zero is **0**, missing evidence is **Not recorded**, and diagnostic deliveries are separate from unique/expected failures.

Service cards show safe recorded container fields and service-log links where available. Memory appears only for Maxwell and the Swift consumer. Table names come from the event list; `cdc_meta.applied_events` is shown separately from application tables. Timing is labeled as end-to-end. Procedures, verification methods and results follow the architecture. Scripts, raw assertions, database comparison files and test settings are expandable. Script links are labeled as current project files. Git provenance stays in the normalized report; the presentation omits Git housekeeping, general limitations and repeated coverage summaries. Failed checks and evidence errors remain visible. The presentation ends with the test results, with no next-step section.

The previous `/evidence` dashboard has been removed, including its overview, scenario, recovery, performance and comparison tabs. Each test page retains its own counts, assertions, comparison files, action sequence, timing charts, memory samples and run details. The `/api/evidence` file endpoint continues to serve those links.

### Database contents

Choose **View saved data** on either database card, or expand **Explore database contents** below the architecture. The snapshot selector lists capture names from the selected run (for example `crud-<table>`, `recovery`, or `load_a`). Workload captures with both row and schema files appear first, followed by readiness/marker captures.

Source and target rows appear side by side, 25 per page. Comparison uses every saved row, ignores row ordering and preserves duplicate counts. Empty tables, absent captures, corrupt files and differing rows have distinct displays. Schema definitions show the recorded columns, types, indexes, defaults, engine and collation. Raw evidence links open the original files. This comparison is independent of the harness verdict, which also checks expected values, events and diagnostics.

Values retain exact integer and decimal text, Unicode, empty strings and SQL NULL markers. `Absent` means a field was omitted from a saved row; the harness omits SQL NULL fields. Literal strings matching display markers are quoted. Database text is rendered as text nodes.

**Source SQL plans** shows Phase 3 workload statements and their positional parameters when a plan was saved. These plans record intent before execution; negative self-tests can deliberately omit a planned statement. Executed-statement journaling and live-container refresh are separate follow-up work. The current view reads the selected run's saved artifacts through the existing read-only allowlist.

For a retained run:

```sh
make e2e SCENARIO=crud ROWS=2 KEEP_STACK=1
make dashboard-view
```

Open the printed run-specific dashboard link. `KEEP_STACK=1` preserves the containers for inspection; the dashboard's saved snapshots remain tied to that run. Use the cleanup command in its `retained-stack.txt` when finished.

Selection is carried in `?run=...`. With no explicit selection or pinned baseline, the latest **recorded start time** wins, including failed/incomplete runs. Undated legacy attempts follow by ID and cannot honestly be placed chronologically; the UI says so. A browser-local reviewed-baseline pin is a viewing preference, not a changed test verdict. Nothing aggregates suite and child event counts.

Evidence links open the full original file as inert plain text in a separate tab, preserving exact row values. The server requires a path referenced by the current report and rechecks every path component against the artifact root, rejecting traversal and symlinks. File reads are limited to 64 MiB. Container environment dumps are not allowlisted. Raw logs/payloads can still contain test data: local access is not permission to publish them. This server is for localhost, not authenticated multi-user hosting.

The additive `presentation` field contains whitelisted container name/image/snapshot state/Docker restart count, labeled event categories, and table names. Raw container inspections are private inputs limited to 8 MiB and never exposed by evidence routes. Optional presentation-file errors do not change a recorded replication verdict. The Docker restart counter is not a complete history of injected restarts. Observed payload categories are used where present; expected workload categories are clearly labeled when used as a fallback, and do not establish how many invalid events were received.

Service-log routes filter only a selected run's allowlisted `compose.log` by known Compose service prefixes. Source-code routes allow only the explicitly listed harness/script files. Both return inert plain text. Mermaid is pinned and prebundled locally from the lockfile by `viewer/build.ts`; only the fixed architecture definition is rendered, never artifact content. The generated bundle is ignored by Git.

For development with Node >=24.13:

```sh
cd dashboard
npm ci
npm run typecheck
npm test
npm run data -- ../artifacts .generated/report.json
npm run build:viewer
npm run viewer
```

Node executes [erasable TypeScript directly](https://nodejs.org/api/typescript.html); `tsc --noEmit` separately checks types. The importer publishes output by atomic rename and rejects output paths inside the raw artifact root, including directory symlinks into it. Importing failed tests is a successful reporting operation: CLI exit 0 means the report was generated, not that every replication test passed.

## Version 1 contract

`reporting/model.ts` defines the format. The root contains `schemaVersion`, `generatedAt`, the plain-language scenario `catalog`, `runs`, `discoveryIssues` and a summary of run/suite verdicts. No global event total is emitted: suites reference child runs, and independent reruns repeat workloads.

Each run contains:

- Identity, artifact directory, phase, kind, expected outcome, verdict and available failure classification/code.
- Raw host/harness exit codes, timestamps, base Git commit/dirty flag, workload configuration and available database/image versions.
- Explicit parent suite/gate IDs and child IDs when recorded. New complete suites require eight successful child runs covering six gates, including smoke and both negative self-tests. Historical suites without a manifest retain their reported gate verdict but explicitly lack child linkage; logs are not mined to guess it.
- Scenario IDs, individual assertions, event/DLQ/quarantine counts, named measurements with units and definitions, and an ordered recovery-check sequence. Sequence timestamps remain null when none were recorded.
- Evidence references, import issues and limitations. Facts use `{value, evidence}`; null means unavailable, not zero. Local evidence uses artifact-root-relative paths plus JSON pointers and `local-only` access. Sanitized snapshot references use `snapshot` access and export-relative file paths. Watcher reports also carry an optional per-run evidence revision for browser refresh.

Verdicts:

| Verdict | Meaning |
| --- | --- |
| `passed` | Successful terminal host result and required phase-specific structured evidence agree; expected negative outcomes have their specific predicates checked |
| `failed` | Host execution failed, or the recorded harness failed unexpectedly; available evidence is still imported |
| `incomplete` | Required completion evidence is absent; a start record alone does not prove the process is still alive |
| `unknown` | Evidence is corrupt, unsafe, contradictory or has an unsupported shape/version |

A known failed execution remains failed even if its evidence is also incomplete/corrupt; `issues` and assertions retain that distinction. For intentional negative tests, raw scenario assertions can be failed while the overall expected-failure gate passes. A DLQ count alone establishes neither success nor failure.

## Adapter boundaries

| Existing gate | Main evidence |
| --- | --- |
| Phase 1 | Terminal result, captured identities/payloads, replay payloads; target-applied counts are unavailable |
| Phase 2 | Expected/audit/ledger counts, zero-DLQ assertion and six explicit target-recovery assertions |
| Phase 3 | Host + harness results, exact negative-test predicate, scenario outcomes, manifest/audit/ledger and DLQ |
| Phase 4 | Host result, event accounting, recorded recovery checks, stable diagnostic identities and resolved quarantines |
| Phase 5 workload | Host result, completed workload checks, event accounting, empty DLQ and finite performance measurements |
| Phase 5 poison | Host result, repeated blocked checks, one stable expected diagnostic retaining the original payload, and the positive baseline ledger |
| Phase 5 suite | Six required host gates; explicit child completeness when a membership manifest exists |

This layer checks report consistency and surfaces the harness's recorded assertions; it does not rerun SQL assertions or independently certify archived replication behavior. Historical per-probe health/repair outcomes were recorded in host control flow rather than individual JSON verdicts. Their gate requires successful terminal completion plus the corresponding structured state, not a `PASS` log line.

UInt64 configuration seeds outside JavaScript's safe integer range remain exact strings. Replay comparison preserves numeric lexemes while allowing JSON object-key reordering. Raw row/message values are not converted into rounded JavaScript numbers for display. Latency/rate definitions retain the existing observational/debug-build limitations. Memory samples, schema/row comparisons and supporting logs are linked as local evidence; container inspection/environment dumps are neither copied nor linked.

## New run metadata and legacy artifacts

The host scripts now write `run-metadata.json` with UTC start/finish times, identity, phase, base commit and dirty flag. Metadata writes are best-effort and never change the replication test's exit code. Suites write `suite-members.jsonl`; children record matching parent and gate IDs. Metadata does not include an environment dump or credentials. A dirty flag is not a snapshot of uncommitted changes.

Future Phase 1 runs use `artifacts/maxwell-phase1-*/` instead of overwriting shared root files; this changes evidence storage only, not the existing Phase 1 persistent-stack behavior. Historical root evidence imports as `legacy-phase1`. Older start/end times, code revisions, lost overwritten attempts and suite links are not invented from filesystem timestamps or nearby directory names.

Discovery covers the legacy root and `maxwell-phase1-*` through `maxwell-phase5-*` / `maxwell-e2e-*` directories. Symlinked runs/files and unsafe paths are rejected. Required JSON reads are bounded to 64 MiB per file. UI strings use text nodes; the server enforces the evidence boundary described above.

## Tests and fixtures

`test/fixtures/runs.json` contains deliberately small synthetic artifact sets and independent expected values for each adapter and outcome. These are reporting fixtures, not claims that a one-event workload passed the actual full replication gate. Playwright materializes these raw files into an isolated temporary directory and runs the real importer. It adds fixed metadata, consistent nearest-rank latency samples, timestamped memory, escaped HTML-looking evidence and an eight-member suite. No mocked report/API or real artifact mutations.

Tests cover correct and incorrect expected failures, corrupt/missing evidence, repeated diagnostics, unresolved quarantine, mismatched ledger IDs, invalid measurements, UInt64 seeds, symlink/path boundaries, suite completeness, CLI output and metadata failures. The Phase 1 runner storage test uses a fake Docker executable in a temporary workspace; it is explicitly not a database integration test. Real replication regression evidence is recorded separately in the dashboard Phase 1 results document.

### Browser and screenshot review

`make dashboard-test` runs Chromium in the Playwright 1.63.0 Noble image pinned by digest, at Linux ARM64 (emulated on Intel), with bundled fonts, UTC/en-US, fixed fixture dates, reduced motion and 1440×1000 / 390×844 viewports. One worker keeps peak browser memory lower alongside retained POC stacks. Unexpected console/page/network errors fail the gate. Numerical assertions are independent of screenshot comparisons. Browser tests do not replace replication E2E tests.

Ten baseline images live under `test/browser/snapshots/`: introduction, three test pages and expanded database contents, each at desktop and narrow sizes. Browser checks cover the harness diagram, runnable commands before the selectors, removal of the old dashboard, safe evidence links and displayed results. Database checks cover exact values, SQL parameters, schema display, pagination, empty/corrupt/mismatched captures, run changes and overlapping snapshot loads. Review the images before committing a visual change. Updating is always explicit:

```sh
make dashboard-test-update-snapshots
make dashboard-test
```

Open `dashboard/playwright-report/index.html` for the test report. Failure screenshots, traces and diffs are retained under `dashboard/test-results/`; both directories are ignored. The initial baselines were visually inspected during implementation and are supplied for user review. They must not be automatically regenerated to silence a failing visual test.

Refresh tests use isolated artifact directories, the real importer/watcher, and independent viewers. They exercise new positive/negative/failed/interrupted runs, historical selection, reporting outages, and recovery. Static browser tests use exported files alone. `make dashboard-test-live` opens Chromium first, checks the displayed command, then executes `make test-basic-replication`. It requires changing captured counts before the smoke workload finishes, automatically selected new runs, and all three successful final verdicts with counts checked against raw evidence and zero DLQ. A page marker verifies that no reload occurred. During-run and final screenshots, sampled counts, trace, harness/browser logs and verdict remain under `dashboard/live-results/live.*`, separate from Playwright's disposable fixture output. The normal harness cleanup/`KEEP_STACK` policy applies to each new run.
