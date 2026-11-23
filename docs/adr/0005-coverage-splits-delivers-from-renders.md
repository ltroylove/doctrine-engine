# ADR-0005 — Coverage counts `Delivers`, not `Renders`

**Status:** Accepted 2026-09-17. Depends on [ADR-0001](0001-three-rung-planning-ladder.md).

## Context

`covers:` is a single undifferentiated list of PRD criterion ids at every level, and the coverage
arithmetic treats every member alike. So a slice that merely *displays* a criterion satisfies it as
fully as the slice that implements it.

This is a known failure of coverage checks, and the fix is to split the heading in two. Without the
split, a UI feature that claims to render every requirement makes any coverage check pass trivially
while most of the product is unbuilt.

Doctrine is especially exposed to it: coverage in both directions is the one
check standing between the ladder and an unbuilt program, and it is the check the whole
narrowing chain hangs on.

Two adjacent rules travel with the split and are adopted here. Ranges are banned — written by hand
they drift into several formats (`through`, an en-dash, prose), and a range forces the parser to
assume dense numbering. And a slice with no
requirements writes `(none)` explicitly, because the project-scaffold slice legitimately delivers
zero and saying so is what distinguishes it from a feature whose list was forgotten.

## Decision

Every heading declares two lists:

- **`Delivers`** — criteria this slice implements. **Only these count toward coverage.**
- **`Renders`** — criteria this slice merely presents. Recorded and reported; **satisfies nothing.**

Every criterion must be delivered by exactly one slice. Ids are listed explicitly, never as a range.
An empty list is written `(none)`, never omitted.

## Consequences

- A UI slice can no longer close coverage on work it only displays. The regression test is the case
  the split exists to catch: a slice rendering every criterion leaves coverage at zero.
- `covers:` becomes two fields in `envelope.ts`, and the arithmetic in `coverage.ts` and
  `narrowing.ts` counts one of them. Existing documents migrate as `Delivers`, which is what they
  meant, with `Renders` empty.
- Reported coverage will drop on migration wherever a slice was closing a criterion it only renders.
  That is the defect surfacing, not a regression.
- **Coverage and satisfaction read these two lists differently, deliberately.** Coverage counts
  `Delivers` only — the question is *is the product built*, and displaying a criterion builds
  nothing. Dependency satisfaction (ADR-0004) counts `Delivers` ∪ `Renders` — the question is *does
  the thing I am waiting on exist yet*, and a slice waiting on a display is waiting on the renderer.
  One field, two readers, and the reason they differ is written down here so a later change to one
  does not silently move the other.
