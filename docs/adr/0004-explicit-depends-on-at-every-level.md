# ADR-0004 — `depends_on` names requirements, not documents

**Status:** Accepted 2026-09-17. Supersedes `after` on `Narrowing`.

## Context

Two mechanisms exist today and neither is sufficient.

`Narrowing.after` is sibling-scoped and expresses a **serve order** — which sibling the planner
narrows next. It was added after a measured failure on 2026-09-15: `nextChainNeed` walked epics in
`readdir` order, which is alphabetical, so on the second target it began at
`ep-categorisation-and-judgment` (PRD §5 step 3) before `ep-hours-to-invoice` (steps 0–1) existed.
The first intent it cut needed a table an unstarted slice owned; three units were built and merged
and the intent could not pass. As `narrowing.ts` records it: *every epic already stated its ladder
position in its own prose. Nothing read it.*

`Intent.dependsOn` and `WorkUnit.dependsOn` name **sibling document ids**.

The alternative is no dependency edge at all: number the epics in dependency order, sort the
documents beneath them, and let order **be** the dependency graph, with one unit in flight at a time
so that waiting for a dependency falls out for free. That caps concurrency at one permanently,
because nothing distinguishes genuinely-parallel work from merely-later work.

**The problem with naming documents** is that document ids churn and requirements do not. A slice
re-planned after a failed grade produces different unit ids; every edge pointing at the old ones is
now either dangling or silently wrong. Under ADR-0001 re-slicing after a failed feature grade is the
normal case, not the exception.

## Decision

**`depends_on` lists the PRD criterion ids that must be satisfied before this work can be built.**
One field, at every level — epic, feature, unit.

- **A criterion is satisfied when every unit that `Delivers` **or** `Renders` it has merged** —
  see the satisfaction note at the end, which is not the same rule coverage uses (ADR-0005).
- **Cross-parent is automatic.** A criterion does not care which epic delivers it.
- **Serve order is derived**, not stored. `after` is removed.
- **Edges survive re-planning.** Re-slicing a feature changes unit ids; it does not change which
  requirements a dependent is waiting on.
- **WIP stays 1.** The edges exist so that raising it later is a scheduler change, not a re-plan.

## Consequences

- Resolution runs through machinery that already exists: `Delivers` maps criterion → unit, and unit
  status says whether it merged. No second graph to keep consistent with the first.
- A `depends_on` naming a criterion that **no** slice delivers is an unsatisfiable dependency and a
  hard lint failure. `lintCoverage` already finds criteria that reach nothing; this gives that
  finding teeth.
- Cycle detection moves to the criterion level.
- Existing `after` and `dependsOn` values name documents and **do not migrate mechanically** — each
  has to be restated as the requirements behind it. On a cutover (ADR-0001) this only affects
  in-flight work, which finishes under the old shape.

### The hole that was open, and the ruling that closes it

`covers: []` is legal, reported, and never shrugged at — `docs/design.md`, *"Necessary work that
advances no PRD criterion is a contradiction, not a category"*. On the second target that was 3 intents
of 21, and one of them was `harness`, which is precisely the kind of thing other work depends on.
A requirement-based edge cannot name it.

**Operator ruling, 2026-09-17, and it dissolves the problem rather than working around it:**

> The harness *does* advance a PRD criterion. With nothing built there is nothing to work with. **The
> first criterion of any greenfield program is that the first scaffolding of the project exists** —
> even if it does nothing — because the rest of the requirements are built on it.

So the scaffold is not zero-coverage work. It is work whose criterion the PRD failed to write down,
which is the same finding `docs/design.md` already reaches for `harness` under *"the ledger
under-indexes the PRD"*: PRD §5 step 0 names it in prose and §4 carries no id for it. The fix is a
criterion, not a second kind of edge.

**Consequences taken:**

- **`depends_on` is criterion ids only. No carve-out, no document-id form.** The earlier proposal to
  allow a unit id when the target delivers nothing is **rejected**: it reintroduced a churning edge
  in exactly the case where stability matters most, since the scaffold is both the most depended-upon
  unit and the most likely to be re-sliced early.
- **A greenfield program's PRD must carry a scaffold criterion.** `docs/program/**` is the operator's
  document, so this is an intake obligation, not something the loop can write for itself. A program
  arriving without one gets the same treatment as any under-specified PRD: reported, and the loop
  mints against the program as it stands.
- **`covers: []` stays legal and reported, and is now also undependable.** That is the honest residue.
  `chart-of-accounts` is the real remaining case — work `docs/design.md` shows no criterion would
  catch the absence of — and it stays a defect report against the PRD. What changes is that nothing
  can declare a dependency on it, which makes the defect louder rather than quieter.

### Satisfaction keys on `Delivers` ∪ `Renders`

Coverage and satisfaction ask different questions and get different answers from the same two lists
(ADR-0005). *Coverage* asks **is the product built**, and a slice that merely displays a criterion
builds nothing — so only `Delivers` counts. *Satisfaction* asks **does the thing I am waiting on
exist yet**, and if what a slice needs is the display, the renderer is exactly what it is waiting
for — so both lists count.

Implemented as one named predicate so that reversing it is a one-line change if the first live epic
says otherwise.
