# Saved database view

Implemented after the `KEEP_STACK=1` checkpoint (`bcb89d1`).

The three test pages now provide expandable source/target row snapshots and schema definitions. Database cards open the view. Captures are selected within the current run, loaded on demand and paginated at 25 rows. Row comparisons include all saved rows and duplicate counts. Phase 3 SQL plans show statements and positional parameters as recorded before execution.

## Verification

- Node tests: 66 passed, both locally and in the pinned reporting image; TypeScript checks passed.
- Playwright: 42 passed across desktop and narrow layouts, including strict screenshot comparisons. Expanded database screenshots were reviewed at both sizes.
- Browser checks cover exact UInt64 values, Unicode, empty strings and NULL, schema definitions, SQL parameters, pagination, empty/corrupt/differing captures, phase-specific data and overlapping snapshot loads.
- Refreshed the local viewer and checked the real retained run `maxwell-e2e-1790641027-35225` in Chromium: passed verdict, matching source/target rows and schema, nine planned statements, no browser errors.
- Read-only queries against both retained MySQL containers returned `id=1`, `value=final 你好 🐘`, matching the displayed capture. The retained stack remains running.

Review: <http://localhost:4173/basics?run=maxwell-e2e-1790641027-35225>. Choose **View saved data** on a database card.

This increment displays saved test snapshots and workload plans. Live-container refresh and executed-statement journaling remain separate increments. The viewer retains read-only artifact access and its existing evidence allowlist.
