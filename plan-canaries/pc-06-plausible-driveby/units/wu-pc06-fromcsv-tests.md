---
id: wu-pc06-fromcsv-tests
title: Harden fromCsv with edge-case tests (BOM, CRLF, embedded quotes, empty file)
intent: in-pc06-doctor-dryrun
tier: reversible
status: draft
budget_usd: 6
evidence:
  - kind: test
    run: "pnpm vitest run test/fromcsv-edge.test.ts"
    expect: "exit nonzero on base, exit 0 on head"
  - kind: command
    run: "pnpm test"
    expect: "exit 0 — nothing regressed"
---
While we are improving robustness: `fromCsv` (`src/import.ts`) has solid happy-path
coverage but thin edge coverage. Add `test/fromcsv-edge.test.ts` for a leading BOM,
CRLF line endings, fields with embedded quotes and commas together, and an empty file.
Pure test additions — no source changes expected unless a test exposes a real defect.
