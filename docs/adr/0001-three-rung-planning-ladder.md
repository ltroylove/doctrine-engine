# ADR-0001 — The planning ladder is three rungs

**Status:** Accepted 2026-09-17. Supersedes the four-level ladder adopted 2026-09-13.

## Context

The ladder ran PRD+ARCH → epics → features → intents → units. Measured on the second target on
2026-09-17 (7 epics, 30 features, 33 intents, 133 units):

| rung | fan-out |
|---|---|
| epics → features | 4.3× |
| **features → intents** | **1.1×** |
| intents → units | 4.0× |

30 features produced 33 intents. That rung cost a paid decompose ACT and a paid judge pass per
document and narrowed nothing.

At the bottom, across the last 60 merged units, the artifact handed to an implementer had a **median
of 2 code files** (bookkeeping excluded), p75 3, max 9.

Spend, from `.doctrine/metrics.jsonl`: **110 merged units at a mean of $9.10** ($1,001) against
**173 decompose ACTs at a mean of $6.22** ($1,077). Planning ACTs outnumber merged units 1.6 to 1,
and planning is 46% of the $2,348 recorded. Counting every unit attempt rather than only the ones
that merged — 131 rows, including 15 failed at a mean of $15.92 — units total $1,272.

The countervailing evidence is real and was weighed: the *brief* rung deleted on 2026-09-13 failed
because one document tried to be both a slice of an app and a thing a planner builds from, producing
twelve intents from a 44,516-character document. That failure argues against a narrowing **rung**
that restates its parent. It does not argue against a feature **heading**, which restates nothing — it
names ids.

## Decision

Three rungs: **epic → unit → verified diff.**

- A **feature** is a `### Feature` heading inside its epic document, not a document. It owns a logical
  grouping of the epic's requirements and states them as criterion ids.
- A **unit** is scaffolded from a feature and built out just-in-time. The scaffold carries
  the slice and its `## Intent`; the build-out ACT reads what is already implemented and appends its
  spec below. The scaffold half is frozen thereafter, byte-identical, checked on the diff.
- Today's feature **documents are deleted, not relocated.** Their content is restated requirement
  detail that the unit's appended spec now takes directly, against a tree that exists.

## Consequences

- **The epic stays small only if features stay lists of ids.** 30 features total 548,210 characters;
  folding them as written would put ~78,000 characters in each epic — nearly twice the brief this
  repo already deleted once. That restraint is what makes the fold safe, and abandoning it
  reintroduces the failure by another route.
- **`Intent` merges into `WorkUnit`.** 28 references across 10 modules and 49 across 13; seven
  modules use both today. The surviving type needs Intent's coverage arithmetic and WorkUnit's
  landing path, so this is a type merge, not a rename.
- **`plan-judge` loses its subject.** Its "mint no rival to an existing contract" clause moves onto
  the build-out ACT, which under this shape both writes contract additions and is the fresh planner
  most able to duplicate one — a strictly larger exposure than before.
- **Unit size becomes a projection, not a measurement.** Roughly 8–12 code files and $35–40 per
  attempt, derived from 4× today's medians. Every attempt cap, budget and size bound calibrated at
  the old scale must be re-measured against the first post-cutover epic before being trusted.
- **Much of the mechanism already exists**, pointed one rung away: `scaffold` is already a status
  whose parser refuses acceptance evidence, `lintScaffold` already gates coverage both ways plus the
  dependency graph, `envelope.ts` already parses a string so a heading and a file are one input, and
  `narrowing-store.ts` is the seam that makes the location change cheap.
- **Cutover, not migration.** New epics take the new shape; in-flight epics finish under the old one.
