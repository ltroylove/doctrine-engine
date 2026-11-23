# ADR-0008 — Surface first, and the surface contract that "done" is graded against

**Status:** Proposed 2026-10-17. Depends on [ADR-0001](0001-three-rung-planning-ladder.md),
[ADR-0003](0003-acceptance-at-three-levels.md).

## Context

On 2026-10-15 the second target, a bookkeeping app, reported `program-done`: 55/55 machine criteria,
each delivered by an epic whose own end-to-end acceptance the engine ran and passed. The operator
then ran the app, and could not use it on real books:

- **The Setup destination was never built.** Its nav entry has no `href`, and only `/setup/sentinel`
  exists. The UX defines Setup as a destination of eight sections, and as where the app *starts*
  on first run.
- **No connection to QuickBooks Online or QuickBooks Time was wired.** `src/server.ts` passes
  `clients: {}` and its comment says "the OAuth flow of A11, which no unit owns yet". Every sync
  records `skipped: not connected`.
- **Statements cannot be imported.** The importers exist and pass their tests, but no route and no
  script reaches them. The history load (PRD §5 step 7) has no tool to run it with.

These are filed as three issues on the target. **The deciding fact:** the operator had already
approved a drawn mockup of the Setup screen on 2026-09-04, one of six in `docs/program/design/`. An
approved mockup existed, and the screen was still never built. So "draw the screens and get them
signed off" is not by itself the missing step. **Nothing connected the approved surface to the
definition of done.** `program-done` asks one question, whether every PRD *machine* criterion is
delivered by a passing epic. Requirements that live in UX or ARCH, or in criteria marked `draft`,
are invisible to it by construction.

Two further measurements shaped the decision:

- **Two of the three gaps have no screen at all.** The OAuth callback and the history-load command
  are entry points, not views. A screens-only inventory would have missed them as well.
- **The app already marked one gap, quietly.** Sync records `skipped: not connected`, which is an
  honest stub that nothing counted. The other two gaps were not marked anywhere.

The operator's proposal (2026-10-17) was to split greenfield work in two: first the loop builds every
screen as a navigable mockup and the operator signs it off, then the loop adds the functionality.
This ADR keeps that shape and adds the piece the evidence says was missing.

## Decision

**1. The surface contract: operator-owned, and a door.** A target declares its surface: every
destination and section, every state the UX names (empty, blocked, done, not connected), and every
entry point that is not a screen (OAuth callbacks, background jobs, operator commands, connectors),
each with a stable id. It is extracted from the program inputs, shown to the operator, and once
approved becomes a manifest door, exactly as `RUBRIC.md` and `calibration/**` are on the third target.
**The loop never writes the surface it is graded against.** If one register both listed the stubs
and defined done, a unit could make done true by deleting an entry along with the screen. **The
same holds for the checker:** the script behind the surface command (decision 2) is a door as well.
A unit that replaces a stub could otherwise weaken it, or break it, until it reports nothing
unresolved, and recreate the false done this ADR exists to prevent (doctrine#104 review). Changing
either one is an operator act.

**2. Stub state is derived from the code, never declared.** A placeholder goes through one helper,
`stub(id)`, which renders or answers "not wired yet" visibly and names its contract id. A target
command, declared in the manifest, prints every contract id that is either still a stub or has no
implementation at all. The second half is what a stub register alone cannot do: it cannot list a
screen nobody wrote, and that is exactly how Setup was missed.

**3. Program-done gains a second condition.** `program-done` requires all PRD machine criteria
delivered by passing epics, **and** the manifest's surface command to report no unresolved ids. A
target without a surface declaration keeps today's single condition.

**4. For greenfield targets, surface first, and the approval is an input, never a wait.** The
operator is never an approver in the loop's execution path: the loop never
blocks on a reply. So the surface is settled the way DESIGN is, as a program input **before** the
build loop runs:

- **Phase 1 is part of onboarding, not of the loop.** A bounded session (an observer session or
  a dedicated onboarding run) builds every contract id as a real view or entry point in the app's
  own code, rendering from registered stubs, with the state screenshots the design judge already
  takes. It produces a sign-off packet: the screenshots per state, and the navigable shell.
- **The operator's approval commits the contract and its checker as doors.** That is the same act
  as approving `DESIGN.md`, and it happens before the target's loop is started.
- **Phase 2 is the loop, unchanged:** the epic ladder replaces stubs with real behaviour, and the
  count of unresolved ids falling to zero is the progress measure.

Nothing in the running loop waits for a person. The only pause this ADR adds (decision 3's
unresolved surface at the end) is the stall the guard already reports, when nothing is left to
build.

**5. The surface is not a planning rung.** ADR-0001 forbids reintroducing a single narrowing rung
between the program and the epics. The surface contract narrows nothing: it is an operator-owned
program input alongside PRD, UX, DESIGN and ARCH, and a second exit condition. The ladder is still
PRD + ARCH, then epic, then unit.

**6. Why stubs do not break the no-placeholder rule.** Empty placeholder files are forbidden
because they drift silently: nothing knows they are empty. A registered stub is the opposite:
tracked debt behind a gate, counted every tick, and it blocks `program-done` while it exists. The
rule protects against untracked emptiness, and this mechanism makes emptiness loud.

## Consequences

- **The second target is retrofitted first**. Its contract is extracted from UX
  §1–5 and ARCH and diffed against the real routes and scripts. That sweep must find more than the
  three known gaps, or it proves nothing. The operator approves it, and the three gaps also become
  PRD machine criteria so the existing ladder builds them now. Once the engine change lands,
  the target's `program-done` must flip to not done with a list, and the ladder must start
  planning the new criteria. Both directions are the proof.
- **The program rung does not read contract ids yet.** Until it does, a gap is closed by making it a
  PRD criterion, as the retrofit does. Having the planner treat unresolved contract ids as criteria
  directly is named later work, not done here.
- **The operator gains one sign-off per program,** at the phase boundary. It is a program input,
  like the design approval, not a gate inside the loop.
- **Cost:** phase 1 renders every screen before any of it works. The loop builds cheaply, and the
  first-run and empty states that phase 1 forces are the ones that were missing.
- **Not covered:** the contract can only be as complete as the inventory taken from it. An entry
  point that no program input mentions is still invisible. The sign-off is the human check against
  that.
