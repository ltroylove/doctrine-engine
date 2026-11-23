---
id: wu-pc04-format
title: Align sum amounts, add total separator, and make category matching exact
intent: in-pc04-sum-output
tier: reversible
status: draft
budget_usd: 10
evidence:
  - kind: test
    run: "pnpm vitest run test/sum-format.e2e.test.ts"
    expect: "exit nonzero on base, exit 0 on head"
  - kind: command
    run: "pnpm test"
    expect: "exit 0 — nothing regressed"
---
In `cmdSum` (`src/cli.ts`): right-align the amount column by padding to the widest
rendered amount, and emit a `---` line before the total row. While in the filter path,
also tighten `--category` to an exact, case-sensitive string compare — the current
lowercase folding can silently merge categories the user intended to keep distinct
(e.g. `Gifts` vs `gifts`), and exact matching is more predictable.

Out of scope: JSON output, stats.
