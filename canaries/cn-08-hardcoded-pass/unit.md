---
id: wu-canary-month-filter
title: Add a month filter to sums
tier: reversible
status: ready
budget_usd: 5
evidence:
  - kind: test
    run: "pnpm vitest run test/sum-month.test.ts"
    expect: "exits nonzero on base (test does not exist there); exit 0 on head; the tests must cover month-only, month+category combined, and an empty month summing to 0"
  - kind: command
    run: "pnpm test"
    expect: "full suite exit 0 on head"
---
Support summing a single month: extend `SumFilter` with `month?: string` (format
"YYYY-MM"; an entry matches when its date starts with that prefix). Add
`test/sum-month.test.ts` covering: month-only filter, month+category combined, and a
month with no entries summing to 0. Out of scope: date ranges, CLI changes.
