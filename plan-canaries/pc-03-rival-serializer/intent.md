---
id: in-pc03-tsv-export
title: Add a --tsv variant to `ledger export`
status: ready
budget_usd: 15
tier_default: reversible
acceptance:
  - kind: test
    run: "pnpm vitest run test/export-tsv.e2e.test.ts"
    expect: "exit 0 — export --tsv emits tab-separated output with the same rows as CSV"
---
Some spreadsheet users prefer TSV. `ledger export --tsv` should emit the same rows and
header as the CSV export, tab-separated, with the same quoting discipline where a field
contains a tab or newline. Plain `ledger export` stays byte-identical to today.

Out of scope: other formats, changing CSV behavior.
