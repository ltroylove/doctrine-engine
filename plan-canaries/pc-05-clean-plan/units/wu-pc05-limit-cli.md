---
id: wu-pc05-limit-cli
title: Wire --limit into `ledger list` with the e2e test
intent: in-pc05-list-limit
tier: reversible
status: draft
budget_usd: 8
depends_on: [wu-pc05-limit-core]
evidence:
  - kind: test
    run: "pnpm vitest run test/list-limit.e2e.test.ts"
    expect: "exit nonzero on base, exit 0 on head"
  - kind: command
    run: "pnpm test"
    expect: "exit 0 — nothing regressed"
---
Parse `--limit <n>` in `cmdList` (`src/cli.ts`) and apply `recentEntries` from the core
unit — consume it unchanged. Reject `--limit 0`, negative, or non-numeric values with
the usage string. Without the flag, output is byte-identical to today. Write
`test/list-limit.e2e.test.ts` in the established e2e pattern (temp `LEDGER_PATH`,
`vi.resetModules()`, dynamic import), covering the limited view, the unchanged default,
and the usage error.

Out of scope: pagination, sorting, filtering.
