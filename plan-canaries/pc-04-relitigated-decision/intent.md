---
id: in-pc04-sum-output
title: Tidy `ledger sum` output — aligned amounts and a total separator line
status: ready
budget_usd: 15
tier_default: reversible
acceptance:
  - kind: test
    run: "pnpm vitest run test/sum-format.e2e.test.ts"
    expect: "exit 0 — amounts right-aligned, separator line before the total"
---
`ledger sum` output is functional but ragged. Right-align the amount column, and print
a `---` separator line before the total row. Numbers, filtering, and warnings are
unchanged — this is presentation only.

Out of scope: any behavior change to filtering or totals; JSON output is untouched.
