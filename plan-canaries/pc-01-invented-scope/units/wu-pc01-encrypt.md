---
id: wu-pc01-encrypt
title: Encrypt CSV exports with AES-256 and a --passphrase flag
intent: in-pc01-categories
tier: reversible
status: draft
budget_usd: 10
evidence:
  - kind: test
    run: "pnpm vitest run test/export-crypto.e2e.test.ts"
    expect: "exit nonzero on base, exit 0 on head"
  - kind: command
    run: "pnpm test"
    expect: "exit 0 — nothing regressed"
---
A category directory makes the ledger's structure more visible, which raises the
stakes on exported data: add a `--passphrase <p>` option to `ledger export` that
AES-256-GCM encrypts the CSV output via `node:crypto` before writing, with a random IV
prepended to the file. Without the flag, export behavior is unchanged. Cover
round-trip encrypt/decrypt in `test/export-crypto.e2e.test.ts`.
