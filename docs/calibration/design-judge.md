# Design-judge calibration — 2026-09-05

**Recall: 9/9 seeded defects caught. Control passed. $15.93 across ten canaries.**

The measurement required before the design-judge gates anything, on the same
law the code-judge and plan-judge already run under: a judge with no measured recall is
an opinion with a verdict schema.

| canary | seeded defect | result | $ |
|---|---|---|---|
| dc-01-centred-everything | table content centred | caught | 1.32 |
| dc-02-emoji-headings | emoji as section markers | caught | 1.23 |
| dc-03-off-scale-spacing | card padding off the scale via `calc` | caught | 2.06 |
| dc-04-equal-weight-cards | table restyled as identical rounded boxes | caught | 1.38 |
| dc-05-decorative-accent | accent applied to every tag, meaning nothing | caught | 1.28 |
| dc-06-silent-empty-state | empty state says nothing | caught | 1.24 |
| dc-07-inconsistent-radii | two radii for the same kind of surface | caught | 2.78 |
| dc-08-placeholder-content | invented "Sample note — your data here" | caught | 1.23 |
| dc-09-figures-unaligned | amounts lose right alignment and tabular figures | caught | 1.31 |
| **dc-10-clean-control** | *nothing — a real, harmless improvement* | **passed** | 2.09 |

Every seeded defect **passes the conformance gate**. The generator refuses any that does
not: a canary the gate already catches measures the gate, not the judge.

## The control is half the measurement

A judge that fails everything scores perfect recall and is useless, and that is the
likelier failure here — "this could be better" is always available to say about a screen.
So one canary is a genuine improvement the judge must pass, and recall is reported with
it counted separately rather than folded in.

That guard fired on the first run, which is the only reason this record exists in its
current form.

## Run 1 failed the control, and it was right to notice what it noticed

The first sweep scored 5/9 with a false positive on the control. Three of the four
apparent misses were mine, not the judge's:

- **The judge caught all of them.** It said `wall-of-equal-weight-cards` where the
  fixture said `equal-weight-wall`, `radius-inconsistent` for `inconsistent-state`,
  `placeholder-content` for `placeholder-tone` — each describing the exact seeded defect
  in the exact right region. Exact-substring matching on one spelling measures the
  fixture author's vocabulary, not the judge's sight. `must_flag` now takes alternates.
- **One was a real failure:** dc-03 timed out at 15 minutes. This judge installs the
  target, renders every screen in a browser, then reads images; 15 minutes was the
  code-judge's budget. Raised to 30.

**The control failure was the important one.** The judge failed a one-token spacing
improvement, citing a type-size inconsistency it had measured by comparing glyph advances
across the totals figures and the Amount column. It was **correct about the defect** —
that was a real flaw in the arena's baseline, which is now fixed — and **wrong about
whose fault it was**.

That exposed a design error in the judge, not a tuning problem. It was grading the screen
absolutely. The loop's provable job is "to **not degrade**" the design,
which is a claim about a difference. So the judge now renders the screens **with and
without the change** and grades the delta: a flaw present in both is recorded with
`ok: true` and marked pre-existing, so the observer still sees it without the change
being blamed for it. Only what the change introduced or worsened fails.

Run 2, with that fix: 9/9 and the control clean.

## What the judge does that the gate cannot

The conformance gate proves no raw value escaped the token file. It is greppable, free,
and blind to everything that matters after that. Two examples from these runs:

- On dc-04 the judge named the seeded defect and then found five consequences of it
  unprompted, including two table cells rendering as empty bordered boxes — a visual
  outcome present nowhere in the CSS diff.
- On the control it measured pixel advances to substantiate a type-size claim rather than
  asserting one. That is the difference between a finding and an impression.

## Standing obligations

- Re-run after **any** change to `design-judge.md`, the verdict schema, or the arena's
  design contract. The recall is a property of that trio, not of the code.
- Include it in the weekly sweep with the code-judge and plan-judge harnesses.
- **Cost matters here.** ~$1.20–2.80 per canary, ~$16 a sweep, because each one installs
  the target and drives a browser. That is real money on a weekly obligation; it is worth
  it while the judge gates UI work, and worth re-examining if the canary set grows.
- Every escaped design defect becomes a new canary. Canaries never retire.

## Re-run 2026-10-18 — after the `screens` file-name rule

**Recall 9/9, control passed, $4.75.** The trigger was a law change: `screens` may hold only
file names, after two malformed verdicts on a target's `u-2026-10-18-close-figures` listed
`head/close.png (crop: ...)` entries. The sweep first printed 8/9. The miss was dc-07, and the
judge had failed it correctly, citing the table's corners against the cards' and
`--radius-card` under "ban-list: inconsistent state". The scorer matched only the hyphenated
`inconsistent-state`, so a space cost the catch. The scorer now treats `-`, `_` and whitespace
as the same separator, and the stored dc-07 verdict re-scores as caught. Nothing about the
judge was relaxed; only its spelling is no longer graded.
