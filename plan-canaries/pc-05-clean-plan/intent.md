---
id: in-pc05-list-limit
title: Add --limit N to `ledger list` (show only the most recent N entries)
status: ready
budget_usd: 20
tier_default: reversible
acceptance:
  - kind: test
    run: "pnpm vitest run test/list-limit.e2e.test.ts"
    expect: "exit 0 — list --limit 3 shows the 3 most recent entries by date, full list unchanged without the flag"
---
Long ledgers make `ledger list` unwieldy. Add `--limit <n>`: show only the n most
recent entries by date (ties broken by input order, later wins). Without the flag,
output is byte-identical to today. `--limit 0` or a non-numeric value is a usage error.

Out of scope: pagination, sorting options, filtering.
