---
id: wu-pc02-rules-engine
title: Build a pluggable warnings rules-engine with the no-budget warning as its first provider
intent: in-pc02-nobudget-warning
tier: reversible
status: draft
budget_usd: 14
evidence:
  - kind: test
    run: "pnpm vitest run test/rules-engine.test.ts"
    expect: "exit nonzero on base, exit 0 on head"
  - kind: command
    run: "pnpm test"
    expect: "exit 0 — nothing regressed"
---
Warnings will keep multiplying (no-budget, over-budget, stale entries, duplicate
detection), so build the general mechanism now: a `src/rules.ts` module exposing a
`WarningProvider` interface (`applies(entries, budgets)` / `render(): string[]`), a
provider registry, and a `rules.config.json` file controlling which providers are
enabled and their ordering. Implement the no-budget warning as the first registered
provider and wire the registry into `cmdBudget` list output. Future warning types
then become one provider file each.

Out of scope: implementing the other providers themselves.
