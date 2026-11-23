# ADR-0007 — Where feature and epic acceptance are written

**Status:** Accepted 2026-09-18. Depends on [ADR-0003](0003-acceptance-at-three-levels.md),
[ADR-0001](0001-three-rung-planning-ladder.md).

## Context

[ADR-0003](0003-acceptance-at-three-levels.md) decides that acceptance exists at unit, feature and
epic, and that **the feature grade owns the ratchet**. It says nothing about where a feature's or an
epic's acceptance is *written*, and neither did the ladder's build sequence (its steps are listed in
[ADR-0006](0006-the-epic-act-scaffolds-its-own-units.md)), which describes step 6a as "the intent
grade re-pointed one rung up".

There was nothing to re-point it at. `Feature` carried `delivers`, `renders`, `dependsOn` and
`position`; `Narrowing` carried those plus `body`, `source` and `path`. Neither carried evidence, so
the grade that ADR-0003 calls the ratchet had no input, at either level — the same shape as two
earlier steps, where the gate the step was built on turned out to be absent or stale.

Two containers, two constraints. An epic is a document with frontmatter, so the envelope every other
artifact uses is available to it. A feature is a **heading inside** that document (ADR-0001) and has
no frontmatter at all; its data is three bold bullets, by a rule chosen so that folding 30 feature
documents into their epics did not put ~78,000 characters into each one.

A third fact decided the shape of the parser rather than the format. The evidence list was already
being read in two places — `parseWorkUnit` hand-rolled it inline, `parseIntent` kept a second copy
that produced different messages for the same defect. Adding two levels naively would have made
four copies of one rule, which is the failure this repo names in its own words.

## Decision

**One parser, one executor, two authoring surfaces.**

- `EvidenceSpec`, `EVIDENCE_KINDS` and `parseEvidence` move to `envelope.ts` — the module every
  level already shares — and `work-unit.ts` re-exports the names its two dozen callers import.
- **An epic writes `evidence:` in its frontmatter**, in the same YAML shape a unit uses.
- **A feature writes a fourth required bullet**, `- **Acceptance:**`, whose checks are indented
  sub-bullets: `` - `command` — what passing it shows ``. `(none)` is how an empty one is written;
  an omitted bullet is a finding, exactly as for the other three.
- At the feature rung **`kind` is not authorable** and is always `command`.

## Consequences

- **An absent acceptance list is not a parse error, and is not a vacuous pass either.** Every epic
  written before ADR-0003 carries none, and a parser that refused them would leave the loop unable to
  read its own committed work. The refusal belongs to the grade, which knows which levels are owed
  acceptance; a parser does not. This is the same distinction an earlier step paid for in `edgeProblems` — *a
  criterion nothing names is absent from the satisfied set, not satisfied by default*.
- **Requiring the fourth bullet costs nothing today.** All seven epics on the second target contain zero
  `### Feature` headings, so every one of them is already malformed under step 1's parser and is
  rewritten at cutover regardless. That is a step 7 cost that existed before this decision; it is
  recorded here because it is what made a *required* bullet the honest choice over an optional one.
- **The command goes in backticks so the separator is looked for after the closing one.** A parser
  splitting on the first dash cuts `npm test -- push` in half and grades something else. Anything
  that cannot be read is named as a finding and never dropped — a dropped check is one the feature
  is not graded on while reporting green.
- **`kind` being fixed diverges from the unit dialect deliberately.** A unit's `kind` tells a
  *judge* how to verify a probe. A feature grade has no judge: the engine executes the line and
  `exit 0` means met. A field nothing reads is a field that drifts, and an author choosing between
  three values none of which changes anything is being asked a question with no answer.
- **The authoring obligation ADR-0003 names now has somewhere to land**, and the prompt that teaches
  it is step 6b's. Until then both levels parse acceptance and nothing writes it — the same state
  `runBuildOut` has been in since step 5, and safe for the same reason: the loop is paused until
  step 7.
