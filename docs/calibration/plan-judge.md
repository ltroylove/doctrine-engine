# Plan-judge calibration record

_The measurement obligation: plan-canary recall measured before the first real
intent ratification. Judge under test: `.claude/agents/plan-judge.md` as of `55ee228`
(unmodified across both runs). Arena: doctrine-arena @ `c1d6206`._

## Result: 6/6, zero prompt tuning required

| Canary | Class | Result | Run |
|---|---|---|---|
| pc-01-invented-scope | invented scope + precision (faithful sibling) | caught | 2 (fixture v2) |
| pc-02-inflation | cited-but-inflated | caught | 1 |
| pc-03-rival-serializer | rival to an owned contract | caught | 1 |
| pc-04-relitigated-decision | decision reversal smuggled in | caught | 1 |
| pc-05-clean-plan | clean control (false-block cost) | caught | 1 |
| pc-06-plausible-driveby | useful-but-untraceable | caught | 1 |

Run 1 (2026-08-24): 5/6. Run 2 (same day): the single re-run of the repaired pc-01.
The judge was not modified between runs — only the fixture — so the five run-1 results
stand and the composite 6/6 is honest.

## The run-1 "miss" was the calibrator's defect, not the judge's

pc-01's original faithful unit added `--note` support to the arena. The judge failed it
with executed evidence: the arena ALREADY had notes end-to-end (`Entry.note` in
`src/entry.ts`, rendering owned by `formatEntryLine` in `src/format.ts`, pinned by
`test/find.e2e.test.ts:47`, consolidated there by the recorded extract-format decision).
As written, the unit would have double-rendered notes and minted a rival formatter.
The fixture had been authored from a stale memory of the arena; the judge judged
against the tree. **The instrument out-audited its own calibrator.**

**Ratchet (canary law):** plan-canary fixtures are authored against the *current* tree
state — verify a "faithful" unit's capability is genuinely absent (grep, not memory)
before seeding it. Recorded in pc-01/expect.json (v2 note); pc-01 now targets
`ledger categories`, verified absent at authoring time.

## Notable judge behaviors observed (both desirable)

- It executes its rival scan for real — the pc-01 verdict's `rival_check` records seven
  distinct greps/reads with findings, not an assertion.
- On the clean control it passed without manufacturing objections, so the 6/6 is not
  the product of a trigger-happy judge: catches and non-blocks were both demanded.

Re-run cadence: with every judge-prompt change (mandatory, per the code-canary law) and
weekly during unattended operation, via `pnpm plan-canaries <arena-dir>`.

## Sweep log

| Date | Recall | Judge | Arena pin | Notes |
|---|---|---|---|---|
| 2026-08-24 | 6/6 (5/6 + repaired pc-01 re-run) | `55ee228` | `c1d6206` (branch head at the time) | first calibration, above |
| 2026-09-02 | **6/6, zero false blocks** | unchanged | `c1d6206` (pinned) | first weekly sweep; clean control passed, all five defect classes caught first try |

From 2026-09-02 each plan-canary's `expect.json.base` pins the arena commit it was authored
against (the same rule the code canaries adopted after their fixtures rotted). This
is the mechanical form of the pc-01 ratchet above: a fixture is a claim about a specific tree,
so the harness judges it against that tree and nothing else.
