# Architecture decision records

One file per decision. `docs/design.md` says what the design **is**; an ADR says what was **decided**,
what forced it, and what it costs. If you want to know why something is the way it is, it is here.

Principle 6 asks for these explicitly: *ADRs — supersede, don't delete.* A decision that turns out
wrong gets a new ADR that supersedes it and a `Superseded by:` line on the old one. Nothing is
removed, because a record rewritten after the fact records nothing.

**Format.** Status / Context / Decision / Consequences. Keep the measurements in Context and cite
where they were taken. Keep the design statement out — that belongs in `docs/design.md`, and
repeating it here is how the two drift.

| # | Decision | Status |
|---|---|---|
| [0001](0001-three-rung-planning-ladder.md) | The planning ladder is three rungs | Accepted 2026-09-17 |
| [0002](0002-intent-is-a-section-not-a-rung.md) | "Intent" is a section every document carries, not a rung | Accepted 2026-09-17 |
| [0003](0003-acceptance-at-three-levels.md) | Acceptance exists at unit, feature and epic, and gets lighter going up | Accepted 2026-09-17 |
| [0004](0004-explicit-depends-on-at-every-level.md) | One explicit `depends_on` at every level | Accepted 2026-09-17 |
| [0005](0005-coverage-splits-delivers-from-renders.md) | Coverage counts `Delivers`, not `Renders` | Accepted 2026-09-17 |
| [0006](0006-the-epic-act-scaffolds-its-own-units.md) | The epic ACT scaffolds its own units, one epic at a time | Accepted 2026-09-17 |
| [0007](0007-where-feature-and-epic-acceptance-are-written.md) | Where feature and epic acceptance are written | Accepted 2026-09-18 |
| [0008](0008-surface-first-and-the-surface-contract.md) | Surface first, and the surface contract "done" is graded against | Proposed 2026-10-17 |
| [0009](0009-a-target-glossary-injected-deterministically.md) | A target glossary, injected deterministically | Proposed 2026-10-19 |
| [0010](0010-the-retro-turns-run-artifacts-into-intake.md) | The retro turns run artifacts into intake | Proposed 2026-10-19 |
