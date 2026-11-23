---
id: in-pc06-doctor-dryrun
title: Add --dry-run to `ledger doctor --fix` (print what would change, write nothing)
status: ready
budget_usd: 15
tier_default: reversible
acceptance:
  - kind: test
    run: "pnpm vitest run test/doctor-dryrun.e2e.test.ts"
    expect: "exit 0 — dry-run prints the planned fixes and the ledger file is byte-identical after"
---
`doctor --fix` rewrites the ledger in place; cautious users want to preview. With
`--dry-run` alongside `--fix`, print exactly what would change in the same report
format, and guarantee the ledger file is untouched. `--dry-run` without `--fix` is a
usage error.

Out of scope: new diagnostic rules, changing what --fix repairs.
