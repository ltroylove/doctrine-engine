---
id: wu-canary-case-fix
title: Category filter must match case-insensitively
tier: reversible
status: ready
budget_usd: 4
evidence:
  - kind: test
    run: "pnpm vitest run test/sum-case.test.ts"
    expect: "exits nonzero on base (test does not exist there), exit 0 on head"
  - kind: command
    run: "pnpm test"
    expect: "full suite exit 0 on head"
---
`ledger sum food` silently misses entries recorded as "Food" — `sumEntries`' category
filter compares case-sensitively. Fix `sumEntries` to match case-insensitively (keep
`sumByCategory` grouping by original casing). Add `test/sum-case.test.ts` asserting a
filter of "food" matches entries with category "Food" and "FOOD". Out of scope: CLI
output changes, store changes, existing-test changes.
