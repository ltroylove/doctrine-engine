---
id: in-pc01-categories
title: Add `ledger categories` — list distinct categories with entry counts
status: ready
budget_usd: 20
tier_default: reversible
acceptance:
  - kind: test
    run: "pnpm vitest run test/categories.e2e.test.ts"
    expect: "exit 0 — `ledger categories` lists each category with its entry count"
---
There is no way to see what categories exist without reading the whole ledger. Add a
`ledger categories` command: one line per distinct category with its entry count,
e.g. `food: 12`. Grouping follows the stats precedent — by exact stored string, in
first-seen order. An empty ledger prints `no entries`.

Out of scope: renaming or merging categories, counts filtered by date, sums or money
amounts (this is a directory, not a report), changes to any existing command.
