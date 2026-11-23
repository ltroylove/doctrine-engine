# ADR-0006 — The epic ACT scaffolds its own units, one epic at a time

**Status:** Accepted 2026-09-17. Depends on [ADR-0001](0001-three-rung-planning-ladder.md).

## Context

ADR-0001 says *a unit is scaffolded from a feature and built out just-in-time*, and it does not say
what does the scaffolding. Neither did the ladder's build sequence: step 1 parses feature
headings, step 5 freezes the scaffold half, 6a grades, 6b writes prompts, 7 cuts over. Nothing
writes the units. The gap surfaced only when step 5 finished and `runBuildOut` had no scaffold to be
handed by anything but a test.

The rung it replaces answered the question one way. `engine/src/intent.ts` records it: a scaffold is
*"minted once for the WHOLE program, carrying what it delivers, what it depends on, and the PRD text
it serves — and nothing about HOW."* `lintScaffold` is built on that assumption — it lints a set
against the PRD in both directions, and step 5 pointed its dependency checks at `edgeProblems`,
which can only call an edge unsatisfiable by looking at the slices it is handed. Closed-world is
correct exactly when the set is the program.

Two things make carrying that forward unattractive at the unit rung. A unit is the implementable
thing now, so the fan-out is an order larger — the second target ran 33 intents against 90 merged units,
and ADR-0001 projects a *bigger* unit still, which means the up-front set is the whole program's
worth of titles and coverage claims written before a single epic is narrowed. And the epic is
already the unit of narrowing: epics are served in dependency order, and the loop deliberately does
not read the whole program at once.

The opposite extreme — a scaffold ACT per feature heading, minting units just before they are needed
— was considered and rejected. It gives up the one property the scaffold rung exists for: coverage
as a **set** property, checkable on paper before anything is built. `engine/src/coverage.ts` makes
that argument at length — *"nothing anywhere can run to discover a requirement that reached no
intent"* — and a rung that never holds a whole set can never ask it.

## Decision

**The epic ACT writes the epic, its `### Feature` headings, and the scaffolded units under them, in
one ACT.** Scaffolding arrives as each epic is narrowed, not before.

The set a scaffold is checked against is therefore **one epic's units against that epic's own
criteria**, not the program's.

## Consequences

- **`lintScaffold` becomes open-world, and this is the change the decision forces.** Its edge checks
  must be handed the units already scaffolded under other epics, because a unit in the second epic
  legitimately waits on a criterion the first delivers. Left closed-world it would report edges that
  can clear as edges that can never clear — the quiet kind of stuck, in the gate built to prevent
  it. The caveat was written at the call site in step 5 against exactly this possibility.
- **Coverage stays a set property, one rung down from where it was.** Every criterion an epic
  `Delivers` must reach one of its units; every criterion the PRD holds must reach an epic, which
  `lintEpics` already asks. The whole-program question survives as the composition of the two, and
  it is answerable on paper at the moment each epic is minted.
- **One ACT now writes an epic, its features and its units.** That is a larger single artifact than
  the narrowing ACT writes today, and it is the size risk ADR-0001 already names: the epic stays
  small only if features stay lists of ids. A scaffolded unit is a title, a coverage claim, a
  dependency edge and an `## Intent` — no acceptance, by the parser's refusal — so it is bounded by
  construction. If epics start growing, this is the first place to look.
- **`program-decomposer.md` rule 2 still holds, and for the same reason it held before.** *"A
  program planned to the end is fiction"* is a claim about READINESS, and a scaffold carries nothing
  about how. This decision makes the claim easier to honour, not harder: a scaffold now reaches only
  as far as the epic being narrowed.
