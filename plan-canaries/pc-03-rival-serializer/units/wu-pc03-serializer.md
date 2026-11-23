---
id: wu-pc03-serializer
title: New src/serialize.ts with generic row serialization for TSV and CSV
intent: in-pc03-tsv-export
tier: reversible
status: draft
budget_usd: 12
evidence:
  - kind: test
    run: "pnpm vitest run test/serialize.test.ts"
    expect: "exit nonzero on base, exit 0 on head"
  - kind: command
    run: "pnpm test"
    expect: "exit 0 — nothing regressed"
---
Create `src/serialize.ts` exposing `serializeRows(entries: Entry[], delimiter: string):
string` — a clean generic serializer handling header, row rendering, and quoting for
any delimiter. Implement TSV as `serializeRows(entries, "\t")` and CSV as
`serializeRows(entries, ",")`, and switch `cmdExport` in `src/cli.ts` to call it for
both paths so the two formats can never drift apart. Amount rendering and quoting are
reimplemented in the generic form inside the new module.

Out of scope: removing `src/export.ts` (leave it for now; follow-up cleanup).
