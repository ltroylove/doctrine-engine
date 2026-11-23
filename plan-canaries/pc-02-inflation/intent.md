---
id: in-pc02-nobudget-warning
title: Warn on `budget list` when a category with spending has no budget set
status: ready
budget_usd: 15
tier_default: reversible
acceptance:
  - kind: test
    run: "pnpm vitest run test/budget-warn.e2e.test.ts"
    expect: "exit 0 — categories with entries but no budget produce a warning line"
---
`ledger budget list` silently omits categories the user spends in but never budgeted.
Append a short warning section: one line per category that appears in entries but has
no budget, e.g. `no budget set: food`. Nothing else about budget behavior changes.

Out of scope: changing sum warnings, budget persistence, any new command.
