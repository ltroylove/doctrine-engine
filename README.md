# Doctrine

**An unattended loop that builds software with AI agents, and a record of what it took to trust
one.**

You give it a PRD and an architecture document. It plans the work, builds it one unit at a time,
has a separate judge agent verify each unit, opens a pull request, answers the review and merges.
No person approves anything along the way. The human is an observer with a veto, never an approver
in the path.

**This engine is retired.** Development stopped in October 2026. It is published as a record of
the work and is not maintained. *Doctrine is a codename, not a product name.*

## What it did

| | |
|---|---|
| **Greenfield trial** | 24 units and 10 intents landed in one day, every unit on its first attempt, with no false blocks, for $59.78 of recorded agent spend. 16 units in a row ran with nobody watching. |
| **Real application** | On a live Express/EJS business application: 7 epics, 30 features, 133 work units, 114 of them merged through pull-request review, unattended, for roughly $2,350 of recorded agent spend. |
| **Code judge** | Caught 10 of 10 seeded defects, twice, three weeks apart. |
| **Plan judge** | Caught 5 of 5 seeded planning defects and passed the clean control. |
| **Design judge** | Caught 9 of 9 seeded UI defects and passed the clean control. |

The spend figures are the Claude Code CLI's own estimates on a subscription login, not a bill.
The measurement records are in [docs/calibration/](docs/calibration/).

## The problem it works on

Most agent harnesses put a person at each gate. Doctrine removes the person, and that one decision
forces everything else. If nobody reads the diff, something else has to know whether the work is
right, whether the money is running away, and whether the loop is stuck. Most of the engine is
that machinery, not the part that asks an agent to write code.

- **Machine verification is the only gate.** A judge runs in its own context, runs the unit's
  evidence commands itself, and scores the diff against them. It never sees what the implementer
  said about its own work. The engine trusts artifacts, never claims.
- **A judge is not trusted until it is measured.** Each of the three judges was run against a
  corpus of seeded defects before it was allowed to gate anything, and again after any change to
  its prompt. Each corpus includes work that is correct, because a judge that fails everything
  also scores perfect recall.
- **The loop holds no state.** Every tick works out where things stand from the target's
  committed files. Kill it mid-unit and the next tick picks up correctly.
- **The safety limits carry weight.** Spend is checked before it is spent. Attempts are capped,
  repeated failure halts the loop, and deny rules guard paths that cannot be undone. Nothing else
  stops a paid retry loop when nobody is watching.
- **Coverage is settled by running things, not by a plan.** After a slice's units merge, the
  engine runs that slice's acceptance evidence with no model involved. If it fails, the failure
  output is the input to the next planning pass.
- **Review is never a gate.** Pull requests collect bot review, but after the configured rounds
  the unit merges anyway and whatever is still open becomes a maintenance ticket.

## What went wrong, and what changed because of it

The design was changed by measurement more often than by argument. These are the cases worth
reading, each with its record.

- **The planning ladder was rebuilt to three rungs.** One of the older rungs turned 30 features
  into 33 intents, a fan-out of 1.1, and the artifact handed to an implementer had a median of
  two code files. That rung was paying for a planning pass and a judge and producing almost
  nothing.
  [ADR-0001](docs/adr/0001-three-rung-planning-ladder.md)
- **The design judge failed its own clean control.** It was right that the screen had a flaw and
  wrong that the change under review had caused it. It was grading the screen, when its job was
  to grade the difference. It now renders each screen with and without the change and fails only
  what the change made worse.
  [calibration/design-judge.md](docs/calibration/design-judge.md)
- **A calibration sweep reported a catch that never happened.** A killed run left its verdict
  file behind and the next sweep scored it. The harness now clears the whole run directory first.
  An instrument that over-reports its own accuracy is worse than one that crashes.
  [design.md](docs/design.md)
- **The seeded defects stopped applying.** The loop had since shipped the very code they were
  written against, so none of the ten patches applied. Each one is now pinned to the commit it
  was written for. [calibration/phase-a.md](docs/calibration/phase-a.md)
- **A judge's "miss" was the test's fault.** The plan judge rejected a unit the corpus called
  correct, and the judge was right: the feature already existed. The fixture had been written from
  memory of the code, and the judge had read the code.
  [calibration/plan-judge.md](docs/calibration/plan-judge.md)
- **An API outage was being counted as a failed attempt.** Outages now cost nothing: no attempt,
  no branch and no step toward the failure halt.
- **The failure halt could never trip.** Reverting an agent's work also reverted the ledger that
  counted the failures. The ledgers are now kept out of the revert.

Many comments in the engine are the same kind of record: they say which failure a piece of code
exists to prevent.

## How a tick works

The engine is a plain outer loop with no model in it. Each tick it:

1. **Works out the state** from the target repository's committed files: what is planned, built,
   in review and owed.
2. **Computes the one next step** by arithmetic over coverage and status, not by asking a model.
3. **Starts exactly one agent** for that step, scoped and capped by a budget: plan a slice,
   implement a unit, judge a diff, fix what a judge found, or answer a review.
4. **Checks the files the agent produced**, never the summary it wrote.
5. **Records the tick** (decision, spend, outcome) and stops.

One step per tick, one unit in flight at a time. Steering is through the repository: a
`.doctrine/pause` file stops the loop and a directives file redirects it. There is no console.

Planning narrows `PRD + ARCH → epic → unit → verified diff`. Features are headings inside the
epic, acceptance evidence is written at every level, and coverage is anchored on stable ids for
the PRD's success criteria. The three-rung ladder was built and merged in September 2026. The
older ladder's intent rung was still being retired, for work already in flight, when development
stopped.

## What is in the repository

| Path | What |
|---|---|
| `engine/src/` | The loop: 55 TypeScript files, about 16,000 lines. One runtime dependency, a YAML parser |
| `engine/test/` | 729 tests in 47 files, about 14,000 lines, all offline. A stand-in for the `claude` CLI sits at the process boundary, so every agent phase is tested without paying for a run |
| `.claude/agents/` | The 19 agent prompts the engine loads. They are part of the program: a test fails when a prompt names a field no parser reads |
| `canaries/`, `plan-canaries/`, `design-canaries/` | The 26 calibration cases: 24 seeded defects and 2 clean controls |
| `docs/` | The design, ten decision records and the calibration records. Start at [docs/README.md](docs/README.md) |
| `CLAUDE.md` | How to install, test and run it, and what the loop does to a target repository |

## Running it

```bash
cd engine && pnpm install
pnpm test                             # tsc --noEmit && vitest run
pnpm loop <target-dir> [maxTicks]     # run the loop against a target repository
```

The tests run from a clone. The loop needs a target repository you set up yourself, and it
discards uncommitted changes in it, so read [CLAUDE.md](CLAUDE.md) first. The calibration sweeps
cannot be re-run from here: each case is pinned to a commit of an arena repository that is not
published, so the corpora are here as a record.

## Where to read next

- [docs/design.md](docs/design.md) for what the system is.
- [docs/adr/](docs/adr/) for why each decision was made.
- [docs/calibration/](docs/calibration/) for the numbers each judge was trusted on.

The build plan, the research notes and the working documents behind this repository are not
published, so a few passages refer to work that is not here. The applications the loop was run
against are not named. The engine and the agent prompts were written for this project; some of
its rules were adopted from earlier work.

## Licence and credit

[MIT](LICENSE).

The design judge's ban-list of generated-UI tells was seeded from the `taste-design` skill in
[google-labs-code/stitch-skills](https://github.com/google-labs-code/stitch-skills), which is
Apache 2.0, © Google LLC.
