# ADR-0002 — "Intent" is a section every document carries, not a rung

**Status:** Accepted 2026-09-17. Depends on [ADR-0001](0001-three-rung-planning-ladder.md).

## Context

Anthropic's AI-Native SDLC Playbook defines a chain — `intent.md` → `spec.md` → `plan.md` → PR →
production — in which `intent.md` holds *what is wanted, why, and under what constraints*, committed
before any implementation decision is taken. The convention is spreading, and its discriminator is
explicit: a document naming services, files or classes is no longer intent.

Doctrine's rung called "intent" fails that test. A representative one
(`in-2026-09-16-payroll-journal-step`) carries six executable acceptance probes citing source files
and line numbers, `pragma_table_info` semantics, which columns must be nullable, and a note that
top-level `await` needs an async IIFE because `tsx -e` transforms to CJS. Its problem statement is
*"the union declares a member nothing produces."* That is a specification, in places a plan.

The difference is not an error. Anthropic's `intent.md` may be vague-but-human-meaningful because a
product owner reviews it before it becomes a spec. Doctrine's cannot: nothing human reads it before
it is built, so every rung's output has to be machine-checkable. The artifacts differ because the
governance differs — Anthropic's playbook has a human accountable at all six stages, and Doctrine
has none in the path.

Meanwhile the **why** has no home. The narrowing law is *nothing invented that the parent does not
have, nothing in the parent that no child takes* — a fidelity law about content. Rationale is not
content it is obliged to carry, so it survives the ladder only when a planner happens to quote it.

`engine/src/intent.ts` already records the general hazard: *two names for one edge is how a check
gets written for one level and not its sibling, which is the shape this repo has paid for five
times.* One word meaning two things is the same hazard.

## Decision

- The implementable thing is a **`unit`**. It is the larger existing type and already owns the
  machinery this change does not touch — `implementer`, `code-judge`, `merge.ts`, `review-fixer`,
  `unit-fixer`.
- **"Intent" stops being a rung and becomes an `## Intent` section** that every epic, feature
  and unit carries: why this slice exists, the outcome wanted, constraints, open questions.
- **Banned from that section:** file paths, acceptance commands, contract names. The ban-list is the
  decision; without it the section becomes the deleted brief under a new name.
- **"Wave" is not adopted.** It is another process's word for its own artifact and carries that
  process's numbering convention with it.

## Consequences

- The collision with the industry convention is removed rather than documented, and `## Intent`
  means in this repo what it means outside it.
- Every narrowing prompt gains the section and its ban-list, and the narrowing judges gain a law: a
  child whose `## Intent` contradicts its parent's is a finding, as an invented requirement is
  today. That is a judge-prompt change and therefore carries a canary sweep.
- The scaffold half of a unit is where its `## Intent` lives, and it is frozen at build-out. An
  intent rewritten to match what was built is the ratchet running backwards.
- Adopting the playbook's vocabulary carries a risk worth naming: each of its artifact names has an
  approver in its definition, and Doctrine has none. The word is taken; the governance is not.

## Amendment — 2026-09-29: a feature carries no `## Intent`

The decision above says the section is carried by "every epic, feature and unit". That clause could
not be built as written, and the correction is recorded here rather than made to the text above,
because a record rewritten after the fact records nothing.

**A feature is a heading, not a document** (ADR-0001). A `## Intent` written beneath a
`### Feature` is a level-2 heading, and the feature parser ends a feature's block at the next heading
of any depth — so every bullet after the Intent would be read as belonging to no feature at all.
External review found this on PR #94 before any engine existed to hit it; it was confirmed against
`engine/src/feature.ts` on 2026-09-29.

So the section is carried by every **document** — the epic and each unit. A feature's "why" is its
epic's, which it is a slice of, and the units under it each carry their own. The rest of the decision
stands unchanged.

Still owed from the consequences above, and not yet built: the narrowing judges' law that a child
whose `## Intent` contradicts its parent's is a finding. It is a judge-prompt change, and the
narrowing judges have no canary harness, so it needs one before it can be verified.
