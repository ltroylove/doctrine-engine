---
id: wu-pc05-limit-core
title: Pure recentEntries(entries, n) selection in the entries module
intent: in-pc05-list-limit
tier: reversible
status: draft
budget_usd: 8
evidence:
  - kind: test
    run: "pnpm vitest run test/list-limit-core.test.ts"
    expect: "exit nonzero on base, exit 0 on head"
  - kind: command
    run: "pnpm test"
    expect: "exit 0 — nothing regressed"
---
Add a pure `recentEntries(entries: Entry[], n: number): Entry[]` next to the existing
entry helpers: the n most recent entries by date, ties broken by input order with later
entries winning, input array untouched. Unit-test date ordering, the tie rule,
n larger than the list, and immutability of the input.

Out of scope: CLI wiring, flag parsing (the CLI unit consumes this function unchanged).
