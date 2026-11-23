---
id: wu-pc06-dryrun
title: Implement doctor --fix --dry-run preview with the e2e test
intent: in-pc06-doctor-dryrun
tier: reversible
status: draft
budget_usd: 8
evidence:
  - kind: test
    run: "pnpm vitest run test/doctor-dryrun.e2e.test.ts"
    expect: "exit nonzero on base, exit 0 on head"
  - kind: command
    run: "pnpm test"
    expect: "exit 0 — nothing regressed"
---
In `cmdDoctor` (`src/cli.ts`): accept `--dry-run` only together with `--fix` (otherwise
the usage string); compute the fixes exactly as `--fix` does but skip the write and
print the planned changes in the existing report format. E2e test proves the printed
plan matches what a real `--fix` then performs, and that the ledger file is
byte-identical after a dry run.

Out of scope: new diagnostics, changing repair behavior.
