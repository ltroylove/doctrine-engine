---
id: wu-pc01-categories
title: Wire `ledger categories` into the CLI with the e2e test
intent: in-pc01-categories
tier: reversible
status: draft
budget_usd: 8
evidence:
  - kind: test
    run: "pnpm vitest run test/categories.e2e.test.ts"
    expect: "exit nonzero on base (test absent), exit 0 on head"
  - kind: command
    run: "pnpm test"
    expect: "exit 0 — nothing regressed"
---
Add `cmdCategories` to `src/cli.ts`: load entries via the existing `loadEntries` path
(`src/store.ts`, `LEDGER_PATH` env override as every other command does), count entries
per category grouped by **exact stored string in first-seen order** — the same grouping
the stats module's contract pins (no case folding; the case-insensitive decision applies
to filter matching, not grouping) — and print one `<category>: <count>` line per
category, LF-joined. Empty ledger prints `no entries`. Wire `case "categories"` into
`main` and extend the usage string. Write `test/categories.e2e.test.ts` in the
established e2e pattern (temp `LEDGER_PATH`, `vi.resetModules()`, dynamic import).

Out of scope: touching stats, sums, or any existing command's output.
