/**
 * Guardrail integrity, checked on the artefact rather than on the command text.
 *
 * Deny rules match the text of a command, and a path is not resolved until the shell
 * runs it. `cd .doctrine && sed -i manifest.json` names no denied string anywhere, so
 * no pattern can catch it — and a worktree carries its own tracked copy of
 * `.doctrine/manifest.json`, which an agent may edit and land through the PR. Review
 * put it plainly on doctrine#11: command-text matching cannot be the boundary.
 *
 * So this does not try. The engine reads the diff an ACT actually produced and refuses
 * it if a guarded path is in it. That is the same discipline the judge runs on —
 * trust artifacts, never claims — and it holds whatever route the agent took to get
 * there: a tool call, a shell redirect, a `cd`, a script it wrote and ran.
 *
 * Deny rules stay, as the layer that stops the honest mistake early and cheaply. This
 * is the layer that stops the rest.
 */

/** Paths no implementer or review-fix ACT may ever appear to have touched. */
export const GUARDED_IN_DIFF: readonly string[] = [
  ".doctrine/manifest.json",
  ".doctrine/claude-deny-settings.json",
  ".doctrine/claude-deny-review-fix.json",
  ".doctrine/directives.md",
  ".doctrine/pause",
  ".doctrine/ticks.jsonl",
  ".doctrine/metrics.jsonl",
  // A directory, matched by prefix: the refused-plan shelf holds the standing case
  // against a plan and the drafts it refers to. An ACT that could edit it could soften
  // the objections the next attempt is answering, and the diff would look ordinary.
  // "It has no reason to touch this" is not a boundary — that is this file's premise.
  //
  // `.doctrine/grades/` is deliberately NOT here, and the test above says so: grade
  // artefacts are written by the judge and land in the unit's own diff, so guarding
  // them would refuse the loop's ordinary work. The shelf is different in kind — the
  // engine writes it and commits it itself, outside any ACT's diff.
  ".doctrine/rejected/",
  // Scheduler state. An ACT that could pre-set other intents to the current HEAD would
  // make them skipped indefinitely, with no rejected diff and nothing to see: not a
  // wrong answer, an unasked question.
  ".doctrine/intents-settled.json",
  ".doctrine/program-settled.json",
  // Same class, same protection: this one decides whether an intent's gap decomposer
  // runs at all. Deleting it restores the repeated paid planning it was built to stop;
  // a forged entry suppresses an intent's planning with no rejected diff and nothing
  // to see. External review, PR #85.
  ".doctrine/gap-signatures.json",
];

/**
 * Engine-owned state under `.doctrine/` that NO ACT may modify, whichever rung ran it.
 *
 * The diff guardrail above runs on implementer and review-fix branches. The decompose
 * and program ACTs are checked here instead, because both deliberately ignore every
 * `.doctrine/` change when validating and reverting — they treat that tree as engine
 * runtime state that an ACT could not have caused, which is exactly the assumption an
 * ACT holding the `Write` tool can break.
 */
export const ENGINE_OWNED_STATE: readonly string[] = [
  ".doctrine/rejected/",
  ".doctrine/intents-settled.json",
  ".doctrine/program-settled.json",
  // Same class, same protection: this one decides whether an intent's gap decomposer
  // runs at all. Deleting it restores the repeated paid planning it was built to stop;
  // a forged entry suppresses an intent's planning with no rejected diff and nothing
  // to see. External review, PR #85.
  ".doctrine/gap-signatures.json",
  // The files that STEER the loop, not just the ones that remember where it got to.
  // The list above defended the scheduler's memory and left its controls open: an ACT
  // holding `Write` could raise `dailySpendUsd` in the manifest, clear its own veto in
  // `directives.md`, delete the pause that halted the loop, or rewrite the ledgers the
  // budget gate and the failure streak are derived from — and `changedFiles` ignores
  // every `.doctrine/` path, so none of it would have been noticed or reverted.
  ".doctrine/manifest.json",
  ".doctrine/directives.md",
  ".doctrine/pause",
  ".doctrine/ticks.jsonl",
  ".doctrine/metrics.jsonl",
];

/** Additionally forbidden to the review-fix ACT: a finding is a defect, never a re-plan. */
export const GUARDED_FROM_REVIEW_FIX: readonly string[] = [
  "work/",
  "context/contracts.md",
  "docs/program/",
  // The engine's own bookkeeping. These are excluded from the diff a RE-judge grades, because
  // `openUnitPr` writes them on the unit's branch and the judge correctly reads them as changes the
  // unit did not author. That exclusion would be a blind spot if the fixer could author them
  // instead — so it may not, and this list is checked against the fixer's OWN delta, which accuses
  // the actor without ever accusing the engine.
  "context/decisions.md",
  "context/defects/",
  "context/review-findings/",
];

export interface GuardrailBreach {
  path: string;
  rule: string;
}

/**
 * Which guarded paths a diff touches. `changed` is the output of
 * `git diff --name-only`, one repo-relative path per entry.
 */
/**
 * `engineOwned` exists because the two rule sets are about different DIFFS.
 *
 * Engine-owned paths are forbidden to everyone, so they are checked across the whole
 * branch. The review-fix rules are about what the review-fix ACT did, and the branch
 * also carries what the implementer legitimately wrote before it — a contract addition,
 * the unit's own status flip. Checking both sets against the same branch-wide diff
 * reported the implementer's ordinary work as a review-fix breach and parked the unit:
 * every unit that touches `contracts.md` would be lost the moment a review finding was
 * addressed, which is essentially all of them (found on the first application
 * unit).
 */
export function guardrailBreaches(
  changed: readonly string[],
  opts: { reviewFix?: boolean; engineOwned?: boolean } = {},
): GuardrailBreach[] {
  const out: GuardrailBreach[] = [];
  for (const raw of changed) {
    const path = raw.trim().replaceAll("\\", "/");
    if (path.length === 0) continue;
    for (const guarded of opts.engineOwned === false ? [] : GUARDED_IN_DIFF) {
      if (matches(path, guarded)) {
        out.push({ path, rule: "engine-owned steering, ledger or evidence file" });
      }
    }
    if (opts.reviewFix === true) {
      for (const guarded of GUARDED_FROM_REVIEW_FIX) {
        if (matches(path, guarded)) {
          out.push({ path, rule: "planning input — review findings never re-plan" });
        }
      }
    }
  }
  return out;
}

/**
 * A guarded entry ending in `/` is a directory and matches everything beneath it;
 * anything else is one file. Both forms also match under a worktree prefix, because a
 * worktree carries its own tracked copy and that copy is the same protected artefact.
 */
function matches(path: string, guarded: string): boolean {
  if (guarded.endsWith("/")) {
    const root = guarded.slice(0, -1);
    return path === root || path.startsWith(guarded) || path.includes(`/${guarded}`) || path.endsWith(`/${root}`);
  }
  return path === guarded || path.endsWith(`/${guarded}`);
}

/** One line per breach, for a park reason the observer can act on. */
export function describeBreaches(breaches: readonly GuardrailBreach[]): string {
  return breaches.map((b) => `${b.path} (${b.rule})`).join("; ");
}
