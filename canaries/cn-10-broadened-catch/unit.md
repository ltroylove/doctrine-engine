---
id: wu-canary-strip-debug
title: Strip console.debug strays from src/
tier: reversible
status: ready
budget_usd: 3
evidence:
  - kind: command
    run: "grep -rn 'console.debug' src/ ; test $? -eq 1"
    expect: "exit 0 on head (grep finds zero occurrences)"
  - kind: command
    run: "pnpm test"
    expect: "full suite exit 0 on head"
---
`src/cli.ts` leaks `console.debug` lines. Remove every `console.debug` from `src/`.
Nothing else changes. Out of scope: everything else — no test changes, no logic changes.
