# ADR-0010 — The retro turns run artifacts into intake

**Status:** Proposed 2026-10-19. Depends on D7 Phase 1 (`docs/design.md`, the ratcheting
decision and defect log) and on principle 4's defect registry.

## Context

**Every Doctrine fix in the last C12 run was found by a person reading logs.** From 2026-10-17 to
2026-10-19 the second target's loop landed seven epics. Each process defect below was noticed by the
observer, diagnosed by hand, and fixed in a session:

| defect | how it showed | fix |
|---|---|---|
| The design judge wrote crop notes into `screens`, so its verdict was malformed. The attempt was refunded, so it could re-roll without limit. | two identical `design-judge-failed` ticks | doctrine #106 |
| The epic planner never scaffolded the journey its own `evidence:` runs. | the same `epic-graded-fail+gap-scaffolded` on three epics in a row | doctrine #107 |
| A judge backgrounded its evidence and exited, writing no verdict. | `judge-failed — missing-verdict` | doctrine #108 |
| An epic's evidence ran the whole-program surface check, which cannot pass inside one epic's grade. | `epic-graded-fail+gap-empty` | observer edit 88a86c8 |
| Orphaned e2e fixture servers locked `node_modules`, so `npm ci` failed. | three `tick-threw` ticks plus a judge-setup failure | a fix in the target's own repository |
| The engine's merge raced its own push. | `parked … Head branch is out of date` | manual merge of the PR (known as doctrine #92) |

Every one of these was visible in `.doctrine/ticks.jsonl` and in the run directories before anyone
looked. **The pattern was in the artifacts, and nothing read them.** This is a rule
not yet honoured: audits belong in the loop, not done heroically and ad hoc.

**The registry that should hold these has stopped being written.** Principle 4's ratcheting defect
registry is `context/defects/`. `writeDefectRecord` (`engine/src/merge.ts`) writes one at land only
when `priorFailures` is non-empty. That list is built by `failedAttempts`
(`engine/src/dispatch.ts`) from metrics rows with `outcome: "failed"` only. Since judge findings
started being fixed on the unit's own branch, a corrected unit records no failed attempt. The
evidence:

- The target's newest defect record is dated **2026-09-11**.
- From 2026-09-12 to 2026-10-19 the tick ledger shows **65 `unit-fixed`, 72 `review-fixed` and
  4 escalations**, and **zero** new defect records.
- The findings those rounds fixed live only in the gitignored `.doctrine/runs/`.

The registry has been empty for five weeks, and nothing said so.

**The observer's own actions leave almost no trace.** The run also needed these interventions:

- killed orphan processes;
- removed stale leases;
- relaunched the supervisor after it stopped while paused;
- merged a PR by hand;
- closed an orphan PR.

Only 7 commits since 2026-09-12 carry the `observer:` prefix. The rest exist only in a chat
transcript. Interventions are the strongest signal of what the loop cannot do for itself, and they
are the least recorded.

**Prior art, as an idea only.** Matt Pocock's public `/retro` skill suggests improvements to the
agent's environment after a session, most severe first. Doctrine takes the idea and none of the
text. It also applies the idea at a different place: after an epic in an unattended loop, not after
an interactive session.

## Decision

1. **Restore the ratchet first.** A unit that lands after any in-branch correction (unit-fix or a
   review-fix that changed code) gets a defect record, whose text is the findings the corrections
   answered.
   - It applies on **every** landing path. Review-fixes happen only when a unit lands through a PR.
   - Every correction a unit received is collected into the record, and none overwrites another.

   This is the same record and the same directory as before, with one more trigger. It is
   mechanical, costs nothing, and is a precondition for everything below.
2. **The observer writes down what they do.** A one-line command appends to
   `.doctrine/observer.jsonl`: time, the action, the unit or path it touched, and why. Interactive
   sessions acting as observer are bound to use it for every intervention, including
   ones outside git (process kills, lease removals, restarts). `observer:` commits stay as they
   are. The log is the part that captures what git cannot.
3. **A mechanical digest, after every epic grade that passes and at `program-done`.** No model is
   involved. The engine reads, for the window since the previous digest:
   - ticks, metrics and grade records;
   - verdict escalations;
   - refunded instrument failures, by reason;
   - `tick-threw` and `awaits_observer` ticks;
   - parks, **deduplicated by unit and reason**, so a 187-tick park loop is one row;
   - epic-level gap scaffolds;
   - the new defect records;
   - the observer log.

   It writes `.doctrine/retro/<epic>.digest.json`. The program-done digest has a file of its own,
   and is written only if its window holds anything. Every row cites the artifact it came from.
4. **A retro ACT ranks and routes the digest.** It is read-only, plus one output file. It reads the
   digest and the artifacts it cites. It returns findings, most severe first, and classifies each
   one:
   - **target**: a defect in the target's code, fixtures or specs. It becomes an issue on the target
     repo, which the existing ticket intake triages.
   - **process**: a defect in a Doctrine law, the engine or a manifest. It becomes an issue on
     Doctrine's own repository, labelled `retro`.

   Each finding carries a signature. A repeat adds a comment and a count to the open issue instead
   of opening another.
5. **The retro is never a gate and never edits anything.** It waits on nothing, and nothing waits
   on it. It cannot touch a law, the engine or a spec. It is intake, under the same law as review
   findings: a bug becomes a ticket, not a stall. Process fixes still go through a Doctrine PR and
   its review.
6. **It is calibrated before it is trusted**, like every judge. Its first measurement is a backtest
   on the second target's 2026-10-17 to 2026-10-19 artifacts, and it must surface the six process
   defects in the table above. Its recall is recorded in `docs/calibration/retro.md` and re-measured
   after any change to its law.

## Consequences

- **The next #106/#107/#108 arrives as an issue, not as an observer's diagnosis.** Repeats become
  counts. A defect that recurs across epics rises to the top by itself, which is the ratchet that
  principle 4 promised and has not been delivering.
- **Cost:** the digest is free. The ACT is one cheap read-only spawn per epic, at single dollars
  against epics that have cost $26–$117 each. Issue creation reaches GitHub, but only the
  operator's private repos.
- **The observer log is a discipline the engine cannot enforce.** An intervention that is not
  logged is invisible to the retro. The backtest will show how much that matters, because several
  of its target findings came from unlogged interventions.
- **Doctrine-wide memory stays out of scope.** The retro files issues per target and on the
  Doctrine repo. It does not reopen the deferred knowledge substrate (`docs/design.md`, "Deferred
  2026-08-12"). The substrate graduates from accumulated records, and this ADR is what starts
  producing them again.
