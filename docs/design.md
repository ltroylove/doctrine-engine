# Doctrine — Design (LIVE — Phases A & B built and running)

**Status (2026-08-13): built and operating.** The design below is no longer speculative — Phases A and B
are implemented (TS engine, 101 offline tests), calibrated (canary recall **10/10**,
`docs/calibration/phase-a.md`), and running live against the arena: **six work units landed first-attempt
(zero rework, zero false blocks)** and one intent driven end-to-end (intent → decompose ACT →
lint-promotion → two landed units → engine-run intent-grade → done). This document remains the *why*;
the engine is the *how*.

**Written:** 2026-08-12, on `feature/shape-doctrine`.
**Amended 2026-08-12** by an independent review, which audited the research against the source repos
(all claims confirmed) and resolved several positions — folded in as dated amendments to D4/D5/D6, the
new **Gate honesty** and **Work intake** sections, and supersessions in the hybrid and substrate
sections.

Doctrine is an **autonomous, unattended process for building software with AI agents, run locally** —
installable `.claude/` artifacts plus a small engine that runs without a human in the loop.
It is not a Docker service, not a prose-only method, and **not human-gated.**

## Current direction (provisional — 2026-08-12, subject to change)

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| D1 | Form | **Executable** — `.claude/` artifacts + engine | A prose process drifts from practice; the thing worth carrying forward is an executable loop, not a description of one. |
| D2 | Scope | **Software development only** | Concrete, testable on a real target now; generalize later once proven. |
| D3 | Branches | **`development` → `main`** (protected) | Already set up; matches sibling repos; keeps a staging buffer. |
| D4 | Runtime | **Local, no Docker** *(amended 2026-08-12)* | Docker's original rent (cloud deploy, multi-app fleet) is out of scope. Containment is container-independent: scoped credentials (the loop never holds prod/deploy secrets), deny-hooks on one-way-door paths, disposable worktree. **WSL2 is the optional second wall** on Windows (real boundary, better sandbox/toolchain, no image upkeep); full Docker returns only if pinned-toolchain reproducibility is later needed. |
| D5 | Operation | **Autonomous — no human in the loop**, *calibrated first in a proving arena (amended 2026-08-12)* | Doctrine runs unattended; machine verification is the *only* gate. But the gate is trusted only after being **measured**: first runs are watched, on sample/greenfield apps, with graduation by pre-written criteria (canary catch rate, N units zero escaped defects) — not vibes. A short watched bridging step precedes any real repo (greenfield can't validate against legacy suite quality or real data/env). |

## The planning ladder

```
PRD + ARCH ──► EPIC ──► UNIT ──► verified diff
```

**Epic.** One document per epic. Its requirements are grouped into **features**, written as
`### Feature` headings inside it — each carrying four bullets: `Delivers` and `Renders` (lists of
PRD criterion ids), `Depends on` (criterion ids), and `Acceptance`. Those bullets are the only place
ids are read as data; prose may quote criteria freely. Only `Delivers` counts toward coverage. An
epic stores no status; done is computed from its features. (`status: done` is used for one thing
only: retiring an epic written under the previous ladder.)

**Unit.** The implementable thing, and the only artifact an implementing agent is handed. It is
**scaffolded** under one of its epic's features, in the same ACT that writes the epic — its
`delivers`, `renders`, `depends_on` and `## Intent` — and carries no acceptance evidence, file paths
or contract names at that point. When it is next to be built, the build-out ACT reads what is
already implemented and **appends** its spec and acceptance below the scaffold. The scaffold half is
frozen from then on, checked on the diff.

**`## Intent`** is a section every **document** carries — the epic and each unit: why this slice
exists, the outcome wanted, constraints, open questions. It never contains file paths, acceptance
commands or contract names. **A feature has none**, because a feature is a heading inside its epic,
not a document: a `## Intent` written under a `### Feature` would end that feature's block, and the
bullets after it would be read as belonging to nothing.

**Acceptance exists at three levels and gets lighter going up.** A unit's probes are
implementation-specific and live in its appended spec. A feature's acceptance is a handful of
end-to-end checks, run by the engine after its units merge; a failure mints more units under that
feature, and this is where the ratchet lives. An epic's acceptance is the functional suite, run
after its features are done.

**A greenfield PRD must carry a scaffold criterion.** The first criterion of a greenfield program
is that the project's first scaffolding exists — even if it does nothing — because every later
requirement is built on it. Without one, the work that creates the project delivers no criterion,
nothing can declare a dependency on it, and the program is built on something the arithmetic cannot
see. `docs/program/**` is the operator's document, so this is an intake obligation; a program
arriving without it is reported and planned against as it stands.

**`depends_on` names requirements, not documents** — one field at every level (epic, feature, unit)
listing the PRD criterion ids that must be satisfied before the work can be built. A criterion is
satisfied when every slice that delivers or renders it has merged. Requirement ids are stable when a
slice is re-planned and document ids are not, which is why the edge points at them. Cross-parent is
automatic; serve order is derived; WIP is 1.

Decisions and evidence: [ADR-0001](adr/0001-three-rung-planning-ladder.md) …
[ADR-0005](adr/0005-coverage-splits-delivers-from-renders.md). **Not built yet** — the sections below
this one describe the four-level ladder it replaces and are dated records, not current architecture.

## Why the safety machinery is load-bearing

With no human in the loop, machine gates and safety machinery are the only protection the loop has:

- **The machine verification gate is the only thing between the loop and a bad merge.** Principle 4 below
  is the load-bearing wall. If it is dishonest or absent, the loop ships defects unattended (exactly
  the self-merge-window failure).
- **The anti-spin budgets, spend-gates-before-spend, and truncation-as-failure are safety machinery**, not
  ceremony. Nothing else stops a runaway paid retry loop when no one is watching. Keep them (they can be
  leaner than the version in prior art, but the category stays).
- **Reversibility guardrails must be mechanical (hooks/permission rules)** — the only protection against a
  Replit-style unattended irreversible action.
- **Steering is entirely through the repo** (pause file, directives file, work intake) — there is no
  operator console. This is the correct model for Doctrine.

Genuinely cuttable: the **doc-validates-doc SDLC ceremony** (it checks plans against plans and catches
nothing about reality) and the **prose-nit merge gate** (a bot-review artifact). The operational safety
machinery does **not** get cut.

### Gate honesty (added 2026-08-12 — three failure modes this design refuses to allow)

The verifier itself must be verified. Hard requirements, not aspirations:

1. **No silent no-op gates.** A gate that cannot run (missing key/service/trigger) **fails the tick
   loudly**. `pass=true, judged=false` is banned by construction (the keyless-judge failure).
2. **Gate liveness proof.** A merge requires positive evidence each gate *executed* — exit codes and
   artifact hashes in the verdict record — never absence-of-failure (the self-merge window read
   "ci=green" off the wrong checks).
3. **Canary defects, forever.** Periodically inject a known bug on a sacrificial branch; the verifier
   must catch it. Every escaped defect becomes a registry entry **and** a permanent canary. This yields
   the measured recall number that gates unattended operation (D5) — and keeps yielding it, because gate
   rot happens *during* operation, not just before it.
4. **Bookkeeping is verified like code.** Status transitions (ticket moves, board state) are checked by
   the gate too (stranded-`in-progress/` drift is a state-tracking failure, not a code one).

## The principles

1. **Engine, not pipeline** — a deterministic outer loop that re-derives state from committed artifacts;
   OBSERVE → pick one step → one scoped, budget-capped agent ACT; steer through the repo. Stateless,
   crash-tolerant. (A directly adoptable core.)
2. **Autonomous and unattended** — the loop runs without a human. Therefore every gate is a machine gate,
   and safety machinery (budgets, spend-gates, mechanical guardrails) is load-bearing.
3. **Single-threaded writes; fan-out only to read/review** — implementation is one agent in one context;
   parallel agents research or *review* (the verifier reads and scores, never writes).
4. **Verification is the product — and the only gate** — context-isolated adversarial code-judge;
   `coherence` (self-checkable, iterate to green) vs `evidence` (empirical, satisfiable only by execution
   artifacts); terminate on the evidence gate, not an iteration counter; a defect registry that ratchets.
5. **Reversibility tiering, enforced mechanically** — build-first/throw-away only inside two-way doors;
   one-way doors (schema, data, money, auth, anything externally visible) get rigor + a mechanical gate
   via hooks/permission rules, never prompt wording. Under autonomy this is the primary irreversibility
   safeguard.
6. **Artifacts are leverage only if a future reader (agent or session) consumes them** — keep a lean
   single-sourced primer, a shared-contracts doc, handoff preconditions, ADRs (supersede, don't delete);
   prefer byproduct context (auto-mined transcripts, generated boards) over ceremony docs.
7. **Instrument outcomes, not vibes** — track revert/rework rate and time-to-verified-done.

## Resolved: Q1 (substrate) and Q2 (context-graph)

Both came from re-framing what the substrate and context investigations were *for*. Resolved
2026-08-12.

### D6 — Execution substrate: **a stateless, artifact-derived loop, written from scratch.**

The loop is a stateless, artifact-derived engine (D1/principle 1). A **scheduled-agent runtime is not a
viable substrate** for it: that shape does *no version control* (no branch/PR/merge/build-test — the entire
verify-and-land half of a dev tick is missing) and typically ships *no working autonomous scheduler*. What
Doctrine builds instead (written from scratch to these patterns — ~150 lines — never vendored or depended
on):

- the **hardened `claude -p` spawn seam**: process-group timeout kill, prompt over stdin only, no shell,
  stream-json parse — a typed, unit-testable upgrade over a bash equivalent;
- the **`RunOutcome` / `RunFailureReason` closed-set-asserted-by-test** failure taxonomy;
- the **injected-seam offline-testability** discipline and **"trust artifacts, never claims"** invariant —
  as principles, applied to code-diff/build-test verdicts rather than monitoring findings.

Dropped: everything in that prior art that belongs to monitoring rather than to building software.

**Engine form (resolved 2026-08-12):** **TypeScript, not a bash port, built on current harness
primitives.** Verification found that in an earlier bash loop **only a small part was generic engine**
(the rest was an inherited SDLC pipeline and GitHub-PR plumbing) — carrying the loop forward means
carrying a shape.
The 2026 harness natively supplies what earlier loops hand-built: hooks (the mechanical one-way-door
deny rules of principle 5), **context-isolated subagents** (the code-judge is a subagent definition with
a restricted allowlist — no custom isolation machinery), permission profiles, sandboxing, headless
stream-json with budget caps, background/scheduled agents. Genuinely custom: the tick dispatcher +
frontier, the verdict/evidence record format + ledgers, consolidated budgets (3–4), and the
canary machinery. A hardened spawn seam of this kind is roughly 300 lines of TypeScript. Realistic v1 engine: **~500–1,000 lines of TS.**

### D7 — Context: **no context-graph up front. Phased ladder; never embed code.**

Established context-graph practice treats the graph as a *rebuildable projection* over an authoritative
flat log, and warns against pre-constraining the schema. So Doctrine starts flat and climbs
only when a rung measurably fails:

- **Phase 0 — files + transcripts (ship this; may be enough):** the filesystem is the context bus — lean
  primer, a single-sourced **contracts file** (owner/consumer; highest-leverage artifact), handoff
  preconditions, and a command that mines raw session transcripts. No graph, no embeddings, no daemon.
- **Phase 1 — append-only decision + defect log with supersede-not-delete:** the loop writes decisions and
  defect-patterns as a **byproduct of each commit**; deterministically retrievable by id/file; still
  greppable, zero-daemon. **This is the same ratcheting defect registry principle 4's verifier needs — the
  two features are one artifact.** *For most projects, stop here.*
- **Phase 2 — embeddings over that log only (never code), when linear scan outgrows itself:** reuse
  an assembly that already works elsewhere — layered, budget-capped, top-k≈8, cosine threshold, omit-empty,
  data-not-instructions prefix, degrade-never-block.
- **Phase 3 — graph traversal (last, possibly never):** lineage edges/ACLs only if multi-hop queries prove
  necessary; a graph daemon reintroduces the exact standing-service dependency Doctrine avoids.

**Two guardrails at every rung:** (1) **never embed the code** — LSP/grep/Glob retrieve symbols exactly and
fresh; embedding adds only staleness and wrong-retrieval. (2) **With no human, load-bearing context
(current contracts, current ADRs) is retrieved deterministically; embeddings are labelled *suggestions*
only** — because a plausible-wrong retrieval now gets *acted on*, not reviewed.

## Work intake (added 2026-08-12 — the half the SDLC cut left open)

Cutting the document pipeline removed the thing that *produced machine-executable work units* (the
frontier read the planning docs we're cutting). The replacement is the thinnest spec artifact that works: a
**`work/` directory, one file per unit**, frontmatter contract:

```yaml
id, tier: reversible|irreversible, budget_usd,
evidence:   # machine-checkable proof that closes this unit
  - "test X fails on base, passes on head"
  - "a11y score >= N on /meal-plan"
```

**Admissibility rule: the loop may only pick up a unit whose "done" is machine-checkable.** The evidence
spec is what the judge verifies against — without it the evidence gate has no target. Units are decomposed
from **intents** (and intents from a PRD+ARCH) by budgeted decompose ACTs; promotion `draft → ready` is
**mechanical** (a plan lint in engine code), not a human approval — **the human is an observer with a
veto** (pause file, directives), never an approver in the path; the only hard stops are per-target
one-way-door credential walls and self-halt safety triggers, and a parked unit never stalls the rest of
the loop. Note the proving ground needs this too: the first
target's backlog is human prose with **no** reversible/irreversible classification — that classification
is part of the first intake, not a given.

## Committed direction: a personal knowledge substrate (extends D7)

D7's context system is now understood as bigger than one project run. The decision (committed, though not
yet being built): build a **personal knowledge substrate** — cross-project, cross-session, provenance-
tagged — that **Doctrine consumes but does not own.** It lives outside this repo (Doctrine is one consumer;
interactive assistant sessions are another). Motivation:

- **The incumbent is project-jailed.** Claude Code memory is scoped to the project path
  (`.../projects/<repo>/memory/`), so a session in another repo has zero cross-project recall — verified
  live (asking what a sibling project is from another repo returns web-searched nonsense).
- **Highest-value contents:** (1) **defect→fix lessons** — surfaced as *provenance-tagged suggestions* to
  the verifier, the agent triages relevance; (2) **entity/orientation notes** — a *pointer to the
  authoritative repo* + the non-rederivable "why/gotchas", never a mirror of it (mirrors drift — the
  `CLAUDE.md`→`AGENTS.md` failure).
- **Correctness is not a new risk.** A subtly-wrong *retrieved* fix is no worse than a subtly-wrong
  *self-generated* one — the verification gate is the equalizer, and the retrieved candidate at least
  carries provenance. So retrieval is framed as hypothesis, not authority; the only real cost of noise is
  attention budget.
- **Disciplines (load-bearing):** heavy **provenance** on every record (which project, which stack, when,
  did-the-fix-hold — this is what lets the agent scope out a wrong-stack match); **capture from day one**
  in the dumbest durable append-only form; grow **retrieval** sophistication lazily (grep before vectors;
  never embed code). An existing assistant project is the head-start on the *mechanism* (extract → assemble →
  degrade-never-block → supersede-not-delete), sized down to a local, no-daemon store.

### Where it lives (decided 2026-08-12)

- **Form:** a **dedicated git repo of append-only, provenance-tagged files** at a **global path** (working
  name `~/knowledge/`), **outside** the Doctrine repo — Doctrine is a consumer, not the owner.
- **Truth = files** (`entities/<name>.md`, `lessons/<date>-<slug>.md`), each carrying provenance (project,
  stack, date, did-fix-hold). **Index = a rebuildable SQLite/vector layer** added later, gitignored, never
  over code. git history *is* the audit trail.
- **Machine scope:** single machine; a private git remote is optional backup, not required for sync.
- **Reach into every session (both consumers are local — Claude Code runs on the machine):** start with a
  user-level `~/.claude` pointer + a **session-start hook** that surfaces relevant records *mechanically*
  (not "if the agent remembers to look"); an **MCP server** is the later rich query layer. No daemon early
  — that's the line held from D7.
- **Concurrency:** append-only, one-file-per-record makes multiple sentinels + interactive sessions safe
  without a lock server; git merges the rare conflict.

**Deferred (2026-08-12):** the substrate had become the design's center of gravity — scope drift: a
second product designed before the loop that would feed it exists. The only piece that pays rent at v1 is
the **per-project ratcheting defect/decision log** (D7 Phase 1), which the verifier needs anyway. Capture
cross-project lessons in the dumbest append-only form if convenient, but the record schema
is **frozen as draft v0** — no further schema iteration, no retrieval, no session-start hooks, no MCP —
until the loop has produced enough real records that grep provably fails.
The substrate graduates from accumulated records, not from an up-front schema.

## Decided: hybrid — one loop + scheduled sentinels (refines D6)

Doctrine is **not** a single monolithic loop, and **not** a swarm of sentinels — it is a **hybrid, split on
write vs non-write.** (The pure-sentinel option was raised as a "might work better" thought; the hybrid is
the settled shape — the loop does what a loop must, sentinels do what they safely can.)

- **One tight, serialized implementation spine** (pick next unit → implement → verify → merge). Concurrent
  writers are the one hazard every source agreed on; keep this boringly singular. The stateless
  WIP=1 lease is the model.
- **A constellation of scheduled single-purpose sentinels** around it for the *parallel-safe append/read
  jobs* — verification, lesson-capture, entity-updates, defect-triage, dependency checks. These fit the
  sentinel shape (fire on schedule → "anything in my inbox?" → act or no-op) and want independent cadences.
- **The knowledge substrate is maintained by its own *global* capture/index sentinel** — watches completed
  work across all projects, appends to the shared store, no write-conflict because it only appends.

**Discipline against over-decomposition:** each sentinel must earn itself (cadence or parallel-safety
genuinely differs) — "elaborate scaffolding loses to a well-briefed single agent" (Ronacher).
"Sentinel" here is a *conceptual primitive built fresh* — prompt + schedule + watcher/inbox +
verified-commit — and nothing more.

**Superseded for v1 (2026-08-12):** applying that discipline to this design itself, **no sentinel earns
its place at v1.** v1 is **one spine + one judge subagent**; lesson/decision capture is a post-merge
*step inside the tick* (byproduct, not a separate agent). A scheduled satellite is admitted only when a
genuinely different cadence shows up in practice (e.g. a nightly dependency check). The hybrid remains
the expected *eventual* shape, not the starting one.

## Target repo layout (built incrementally, not all at once)

```
doctrine/
  DOCTRINE.md          the lean always-loaded primer (single-sourced)
  .claude/
    agents/            code-judge (context-isolated verifier), and future specialists
    skills/            verify, contracts, tiering, handoff, defect-registry
    commands/          /doctrine-* entry points
  engine/              the local autonomous loop + spawn seam
  context/             Phase 0/1: contracts file, append-only decisions + defect log
  docs/                design.md (this), ADRs (supersede, don't delete)
```

Files are created when a real increment needs them — no empty placeholders (they drift, per the
`CLAUDE.md`→`AGENTS.md` failure).

## Build status (2026-08-13; updated 2026-09-02) — the phased path, executed

- **Phase A — DONE, exit bar met.** Code-judge + canary harness built and calibrated watched in the
  arena: recall **10/10, zero misses** across five defect classes, including both well-written-fiction
  canaries (`docs/calibration/phase-a.md`). ~$0.70/judge-run.
- **Phase B — COMPLETE (2026-08-13), pending only the operator's escaped-defect audit.** Engine
  (TypeScript, 102 offline tests) ran the full live program in one day: **24 units + 10 intents
  landed, every unit first-attempt (zero rework), 0 false blocks, $59.78 notional**, incl. the
  under-decomposed intent (grade-fail → gap-decompose → re-grade pass) and **16 consecutive fully
  unattended units** across two sessions (bar: 15). One induced-crash recovery live and unplanned.
  The arena grew from 10 to 170 green tests / twelve shipped features. Lessons ratcheted into the
  engine during live runs: outage modifier on both implementer and judge paths (529s never burn
  attempts, branches, or work), reap-in-order worktree cleanup, stale-worktree sweep, spend
  accounting single-sourced to metrics, baseline deny floor, per-target budget overrides.
  Ongoing ops: weekly canary sweep.
- **Phase C — LIVE on the first target (opened 2026-08-18), halfway to its exit bar.** Target is a
  dedicated clone of the app's repository (no door credentials by construction). Landed so
  far: the watched bridge (3 reversible units, 2026-08-20, $5.00, 1 attempt each, 0 escaped defects)
  and one intent end-to-end (`persist-swaps`, 2026-08-24: ratify → decompose → plan-judge → 2 units →
  intent-grade pass) — **5 of the 10 unattended units** the exit bar demands. Built for it (all
  generic, no target-specific engine code): **PR landing mode** (units land via machine-merged PRs
  into `development`; bot review harvested as instrument, never gate); the **plan-judge**
  gate between lint and promotion, **calibrated 6/6** on plan-canaries (`docs/calibration/plan-judge.md`);
  guardrail-edit deny floor; pre-spend landing probe; intent-scaled decompose budgets; rejection
  feedback into decompose retries; ledgers spared from `revertAll` (the failure halt had never been
  able to trip). Remaining: mutation score, UI evidence stack, grade flips via the PR path, more
  ratifications, the review-window question.
- **Canary law ratchet (2026-09-02):** the first post-Phase-B code-canary sweep could not run — the
  Phase A patches no longer applied because Phase B had shipped the units they were seeded against.
  Canaries now pin the arena commit they were authored against (`expect.json.base`) so the
  sweep measures the judge, not the arena's drift.
- **What a pin does and does not freeze (2026-09-03, from the PR #3 review):** the pin freezes the
  arena's *source*; it does not freeze how a checkout is *prepared*. `setup` is therefore still read
  from the arena's current manifest — at pin `9e10a34` there was no `setup` field at all, so
  resolving it from the pinned commit would judge all ten fixtures with no `pnpm install` behind
  them. The residual risk (a setup command the pinned tree cannot run) is contained rather than
  designed away: that canary reports `error` before any judge spend, and the sweep continues.
- **A sweep may never fabricate a measurement (2026-09-03):** the plan harness cleared only its
  worktree, leaving a killed run's `plan-verdict.json` in a run directory that is stable per canary.
  `runPlanJudge` decides on that file existing, so the next sweep scored the dead run's verdict — a
  false *catch*, inflating recall. Clearing the whole run directory is now the rule in both
  harnesses. An instrument that silently over-reports its own recall is worse than one that crashes.
- **Phase D — unchanged:** extensions only on measured failure of the simpler thing.

## The intent scaffold: coverage is a set property (2026-09-13)

> **Superseded by "The planning ladder" above.** This section records the four-level ladder as it
> stood on 2026-09-13 — epics, feature documents, intents, units — and its `covers` field, which
> ADR-0005 split into `delivers` and `renders`. Its central argument survives: coverage is a set
> property, now asked one epic at a time (ADR-0006). Do not plan from the table below.

**Decided and half-built.** The mechanical core is in `engine/src/coverage.ts` with 26 tests; the
two ACTs that use it are stage 2, shaped below. Operator decision behind it: build the mechanism
before the artifact, and give the PRD stable criterion ids.

### The gap

Every gate in the ladder runs **intent → PRD**: the program-judge's *cite or fail* and *no invented
product*, the brief-judge's *nothing is invented*. Brief-judge's *nothing binding is missing* is the
only check facing the other way and it disclaims the property in its own words — "completeness is
not the test."

So Doctrine checks **soundness** — nothing was invented — and never checks **completeness** —
nothing was omitted. That gap cannot be closed by execution. An intent-grade proves you built what
you wrote down and is structurally silent about what you never wrote down; no command anywhere
discovers that a requirement reached no intent.

Which makes the original cut over-broad on exactly one item. The
doc-validates-doc pipeline was cut because it "validates plans against plans and catches nothing
about reality," and for the conformance and cross-documentation skills that was right — they were
redundant with execution. **Requirements coverage is not redundant with execution; it is orthogonal
to it,** because completeness is the one property that can only be checked on paper.

The brief rung already reversed half of this cut on evidence. `engine/src/brief.ts:24` records it:
the prior ladder existed so each level reads its parent, "and the checks between levels were what
made the narrowing trustworthy. This repo cut that as ceremony... The evidence resolved it against
the cut." That reversal took the **narrowing** and left the **verified traceability** behind. This
section takes the rest.

### The split that makes it work, and why rule 2 survives

Two properties the program rung currently conflates:

- **Coverage** — does the intent set account for the PRD? A property of the *set*. Needs only the
  PRD. Checkable once, statically, before anything is built.
- **Readiness** — can this intent's acceptance be written against the code that exists? Needs
  reality. Must stay just-in-time.

`program-decomposer.md` rule 2 — *"a program planned to the end is fiction"* — is a true claim about
**readiness** that has been applied to **coverage**. It survives intact, and mechanically: a
`scaffold` intent that carries acceptance evidence **fails to parse**. The fiction rule 2 forbids is
an acceptance command written against code nobody has built; a title, a citation and a dependency
edge are not that.

```
PRD + ARCH  ──narrowing ACT──►  epics      covers ⊆ PRD criteria      lintEpics
epic        ──narrowing ACT──►  features   covers ⊆ epic's covers     lintFeatures
feature     ──program ACT────►  intents    covers ⊆ feature's covers  lintChildren + nothing_dropped
intent      ──decompose ACT──►  units      plan-judge + intent-grade
```

*(This diagram replaced a two-rung sketch — "scaffold ACT" then "complete ACT" — on 2026-09-13.
That sketch was right about the split and wrong about the shape: it put the whole program's intents
in one artifact, which is the same mistake the 44KB brief made one level up.)*

**"What next" stops being an LLM decision.** `nextChainNeed` is a read of committed artifacts: finish
the epic layer, then one epic's features, then that feature's children. (An earlier `nextReadyScaffold`
did this over intent dependency edges and was deleted once the chain subsumed it — a tested function
with no caller is a claim about a design that moved.) That is the upstream fix
asked for after `attention-queue` was minted against a table only `statement-import-tieout`
creates — "the program-decomposer should not mint an intent whose acceptance depends on a sibling it
minted in the same breath." With the edge declared, ordering is enforced rather than discovered by a
grade failure no unit could close.

`done`, not `decomposed`, on purpose: a dependency still landing units is one whose interfaces are
still moving, and writing acceptance against a moving tree is the failure late acceptance exists to
prevent.

### What the gate covers, and what it does not (measured 2026-09-13)

**It indexes the PRD's §4 success criteria and nothing else.** That is a narrower claim than
"completeness", and the measurement on the second target is why the distinction has to be written down:
of **182 acceptance entries across 21 intents, only 47 grade a §4 criterion.**

The other 135 decompose, and most of them are not a hole:

- **49 (27%) are three standing manifest gates** — `npm test`, `npm run typecheck`,
  `node scripts/design-conformance.mjs src` — carried once per intent as regression guards. New
  evidence about nothing; they are the floor every intent stands on.
- **86 are one-off evidence citing the ARCH, its pinned decisions, `context/contracts.md`, or PRD
  sections outside §4.** Read a sample of ten: three were the *same* rule (ARCH §7, "a unit that
  adds a view registers it in the same unit") acting as a fourth standing gate, two were invariants
  ("no query reads a source table directly"), one was bookkeeping, and four were structural
  deliverables — a table's schema row, a function's pinned shape, a route.

**Most structural deliverables do not need ids of their own, because they are covered
transitively.** `decide` exists to serve C2.1; if C2.1's acceptance passes, `decide` works. Indexing
the ARCH would mean giving 52KB of prose stable ids to re-prove what a criterion already proves. §4
is where *done* is defined, and coverage of done is the property worth gating.

**"Most" is doing real work in that sentence, and the counterexample is below.** I asked reviewers
of `doctrine#69` to attack the transitive claim by finding a deliverable whose absence no criterion
would catch, and `chart-of-accounts` is one — found in the intent this memo had already dismissed as
legitimate zero-coverage work. Transitive coverage holds wherever a criterion exercises the
structure beneath it, and fails wherever the PRD presupposes structure in prose. The second case is
a PRD defect, not an argument for ARCH ids.

### "Necessary work that advances no PRD criterion" is a contradiction, not a category

That sentence was in the first draft of this section, describing the second target's three intents with an
empty `covers`. The operator asked how work can be both, and it cannot. **Necessary work is
necessary FOR something, and that something is either in the program or it is not.** There is no
third option, so an empty `covers` always resolves to exactly one of two findings — and never to
"this is fine".

**1. The ledger under-indexes the PRD.** `harness` builds, item for item, what PRD §5 step 0 names:
"Test runner, fixture layout, QBO sandbox wiring, the AI seam stub and the labeled fixture ledger
that calibrates roles 2 and 3, and the design contract plus conformance gate." It advances the PRD;
the arithmetic reads §4. `calibration-off-the-books` is the same sentence's "labeled fixture ledger"
and is *also* the precondition named inside C2.4's own text — "precision at or above the bar set at
calibration". Neither of these is zero-coverage work. They are work this instrument cannot see.

**2. The PRD under-specifies.** `chart-of-accounts` is the real one, and it breaks the
"covered transitively" argument made above. It builds `qbo_accounts` because C2's preamble says
"Every transaction gets a QBO account category" — prose, not a criterion. Ask the falsifiable
question: **which criterion would fail if this work were deleted?** C2.1 asks only that a
transaction "receives its approved category from rules alone", which free integers satisfy. C10.1
is not it either, and the intent's own acceptance *proves* that: it deliberately took the route of
importing the chart **outside** `runSync` and grades that `qbo_accounts` stays out of C10.1's step
list and that `SyncStep`'s union carries no member for it. So the answer is **none** — real,
necessary, architecturally deliberate work whose absence no success criterion would catch.

That is a defect report against the PRD. `docs/program/**` is the operator's document, so the loop
reports it and mints against the program as it stands — the same law `program-decomposer.md` already
states for bad inputs.

**So `covers: []` is legal, reported, and never shrugged at.** `parseIntent` used to reject an empty
`covers` on a scaffold; external review found that this makes the signal unreachable — the ACT must
attach a criterion it does not grade, which is coverage typed into existence, the exact failure the
invented-id check exists to stop. The requirement was also redundant: completeness is a property of
the **set**, and `lintCoverage` already fails when a criterion reaches no intent, so an intent
covering nothing can never hide a gap. `structuralIntents` reports them as flags instead.

On the second target that is 3 intents of 21 and **$72.46, 4.0% of attributed spend** — two of them
finding 1 and one of them finding 2. This is also the *bloat* direction, the other half of what
upfront decomposition buys, and at 4% it is worth reporting rather than gating.

**Rejected: an `enables:` field** naming the criteria an infrastructure intent is "in service of."
It reads as the fix and it is unfalsifiable — no lint can test "in service of" and no judge can
refuse one, so it becomes prose in a frontmatter field. `covers` is checkable (does an acceptance
entry grade this criterion?) precisely because it is narrow. Same objection retires
`kind: infrastructure`: a self-declared label with no check behind it.

**One observation, n=1, recorded as a hypothesis rather than a finding.**
`in-2026-09-09-chart-of-accounts` is both the only substantial intent covering no criterion *and*
the intent whose acceptance commands cannot execute at all — every unit built and merged, ungradable
forever (see the requirements-ladder section). An intent with no criterion to grade against has
nothing disciplining what its acceptance list may contain. That may be causal or may be coincidence;
the other two zero-coverage intents were uneventful. Worth watching on the next target, not worth
building against yet.

### Three consequences, recorded rather than discovered later

1. **A `draft` criterion counts for coverage and never counts as done.** The asymmetry is
   deliberate and was a real bug in the first draft of `programProgress`. Coverage counts draft
   criteria because a requirement without a machine check is still a requirement and must reach an
   intent — dropping them would redefine "the program" as "the testable part of the program". But
   completion cannot count them: an intent reaches `done` when its *acceptance* passes, and a draft
   criterion is by definition one no acceptance entry grades, so it would flip to done having been
   verified by nothing. That is "an acceptance list where nothing fails grades nothing" reappearing
   one rung up, inside the gate built to prevent it. `ProgramProgress.unverifiable` lists them
   permanently, which is what the rule "surfaced to the observer, never silently dropped, never
   blocking" actually asks for.

2. **The scaffold serializes the program, and that is the price of late acceptance.** Today two
   intents can be in flight (`dispatch.ts:1865`). The program rung is gated on `!openIntent &&
   !openUnit`, and `nextReadyScaffold` requires dependencies to be `done` — compose those and
   completion runs only when nothing is in flight, so the scaffold's dependency chain becomes the
   build order. This is a throughput change to a live loop, not a neutral refactor. It is accepted
   because it is the same reason acceptance is written late at all; it should be measured on burn
   rate after the first scaffolded program, not assumed free.

3. **A program minted before the scaffold rung has no `covers` and the arithmetic reads it as
   zero.** The second target has 21 intents, 14 of them `done`, none carrying `covers`; `lintCoverage`
   against that target would report every criterion uncovered and `programProgress` would report
   `done: 0`. So the gate is **opt-in per target by having a scaffold at all** — a pre-scaffold
   program is unaffected, and migrating one is a one-time hand-authored `covers` backfill, which is
   the coverage judgement done backwards and therefore the operator's call, not the loop's.
   **Explicitly refused:** a "criteria outside the scaffold's scope" escape hatch. It is the obvious
   fix for a red lint at 2am and it reintroduces exactly the silent-denominator failure that makes
   `parseCriteria` fail on unlabelled bullets rather than skip them.

### What was actually built (2026-09-13), and where the sketch was wrong

The section above planned two rungs — a scaffold ACT minting every intent at once, then a completion
ACT giving one of them acceptance. **That was the same mistake it was written to diagnose**, one
level up: putting the whole program into a single artifact. The operator's correction supplied the
missing layer, and four levels is what shipped:

- **`engine/src/envelope.ts`** — one YAML frontmatter every level carries: `id`, `level`, `title`,
  `status`, `parent`, `covers`. One field name for "linked to" at every level, because `parent` on a
  feature and `feature` on an intent is two names for one edge, which is how a check gets written for
  one level and not its sibling. It parses a **string**, so a file today and an issue body tomorrow
  are the same input — there is a test asserting both produce identical results.
- **`engine/src/narrowing.ts`** — the epic/feature artifact and the three hop lints. One mechanism,
  two levels; one decomposer prompt and one judge prompt, parameterised by which (document, parent)
  pair they are handed. That is not a mode flag: one standard grading two artifacts, rather than one
  artifact graded by two standards.
- **`engine/src/narrowing-store.ts`** — the storage seam, three operations, two implementations
  (file and in-memory). It is this small because the ACT stopped writing into the store: it writes to
  a **scratch directory** and only an accepted document is ever published. The revert machinery — and
  with it the compensating-close and reconciliation work a GitHub-issue store seemed to need — turned
  out to be an argument about the ACT's working directory, not about the store.
- **`engine/src/narrowing-act.ts`** — lint first (free, and decides what a judge reading prose is
  worst at), then judge, then publish.

**Kept from the sketch:** the coverage/readiness split, `scaffold` as a status whose parser refuses
acceptance evidence, the draft-criterion asymmetry, and structural intents being reported rather than
refused.

**Dropped:** the whole-program scaffold, `nextReadyScaffold`, and the separate scaffold-judge. The
"two judge prompts, not one" argument still holds for the case it was made about and does not apply
here, for the reason given above.

**Not built, and named so nobody infers otherwise from the code existing:** `programProgress` has no
caller. The chain's `complete` arm means every criterion reaches a feature and every feature has
intents — a statement about PLANNING, not about work being finished. Program-done is that function
returning `done: true`, and the rung that should ask it does not exist yet.

### Precondition: PRD criteria need ids

`parseCriteria` reads `- **machine** \`C1.1\` <text>`. Criteria today are anonymous bullets under
`### C1.` headings. An unlabelled bullet **fails the lint** rather than being skipped, for the same
reason `chart-of-accounts` matters one rung down: a tolerant parser shrinks the denominator, and a
coverage gate measuring half a PRD reports green for the half it cannot see. `docs/program/**` is
guarded from ACTs, so this edit is the operator's either way.


## Explicitly out of scope for v1

The inherited SDLC document pipeline and its doc-validates-doc conformance skills; the prose-nit merge gate. These are cut
because they validate plans against plans or police prose. The operational safety machinery (budgets,
spend-gates, mechanical reversibility guardrails, verified-artifact commits) is **in** scope — autonomy
requires it.

## History

Prior revisions — the human-present first draft, then the autonomy correction and the Q1/Q2 resolution —
are in git history. This document reflects the current autonomous direction only.
