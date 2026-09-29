# Published results

This directory contains the reviewed, sanitized input for the GitHub Pages dashboard:

- `snapshot.json`: selected run IDs and capture time.
- `data/report.json`: exported verdicts, counts and measurements.
- `evidence/`: exported checks and numeric timing/memory samples.

The source SQL plans, database rows, configuration dumps and raw logs stay in the local `artifacts/` directory.

To replace these generated results after running tests locally, run `npm run snapshot` from `dashboard/`. Set `RUN_IDS` to a comma-separated list of actual run IDs to include specific tests. The command replaces `data/`, `evidence/` and `snapshot.json`; review the diff before committing and pushing.

GitHub Actions uses `SNAPSHOT_ROOT=published npm run build` to build the presentation from these saved results. A fresh clone also uses this snapshot when local artifacts are absent.
