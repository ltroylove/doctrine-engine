# ADR-0003 — Acceptance exists at unit, feature and epic, and gets lighter going up

**Status:** Accepted 2026-09-17. Depends on [ADR-0001](0001-three-rung-planning-ladder.md).

## Context

The ratchet — *plans are cheap, reality decides coverage* — is implemented by the intent-grade:
the engine, with no LLM, runs an intent's acceptance after all its child units merge; a pass closes
the intent, a failure keys `failureSignature` and the gap decomposer is asked what is left to slice.

ADR-0001 makes the unit the implementable thing. A unit has no children, so a unit graded only
against its own appended spec would be **self-grading**, and the gap decomposer would have nothing
to re-slice. That would delete the design's central loop.

Two things constrain where acceptance can go instead. Features are now features inside an epic, and
today's acceptance blocks are heavy — the intent documents measured on the second target have a median of
27,259 characters and a maximum of 59,259, almost all of it acceptance. Putting that inside the epic
reproduces the size failure ADR-0001 exists to avoid.

They are heavy because they are *implementation* probes written at planning time, before the tree
exists. A grade that runs at complete-epic and executes **functional acceptance cases**, not unit
probes, does not have this problem.

## Decision

Acceptance at all three levels, weighted so that it gets **lighter** going up:

| level | asks | weight |
|---|---|---|
| **unit** | do this unit's appended-spec probes pass | heavy, implementation-specific — written just-in-time, lives in the unit, never in the epic |
| **feature** | with all its units merged, does the traced behaviour work | a handful of end-to-end checks |
| **epic** | with all its features done, does the product-level flow work | the functional suite |

**The feature grade owns the ratchet.** The engine runs it with no LLM after a feature's units
merge; a failure keys a signature and mints additional units under that feature. This is the
intent-grade re-pointed one rung up — the mechanism does not change, only which level holds it.

## Consequences

- A unit grading itself is acceptable *because it is not the only grade*. Remove the feature grade
  and this decision becomes the failure it was written to avoid.
- Heavy implementation probes move down into the unit's appended spec, which is where they belong:
  written against a tree that exists rather than one imagined at planning time.
- The **epic grade is new machinery**, and it gives `programProgress` the caller it has never had.
  Program-done becomes answerable for the first time.
- Feature and epic acceptance are a new authoring obligation for the epic ACT — end-to-end checks,
  not probes. If they are written as probes the epic grows and ADR-0001's heading rule is broken from
  the inside.
- Grade coverage now matters more than plan coverage. A criterion missed at planning and caught by a
  feature grade is the system working; one no grade would notice is the failure.
