import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { engineCommit, stagePaths } from "./git-commit.js";
import type { WorkUnit } from "./work-unit.js";
import type { Verdict } from "./verdict.js";
import { findOpenPr, type OpenPr } from "./review.js";

/**
 * Land a verified unit: merge the unit branch into the base
 * branch, flip the unit's status in the SAME landing commit, and append the capture
 * records (decisions.md always; a defect record when earlier attempts failed).
 * Capture is a tick STEP, not a satellite agent.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const commitAs = engineCommit;

export interface LandContext {
  arenaDir: string;
  baseBranch: string;
  unit: WorkUnit;
  branch: string;
  headSha: string;
  verdict: Verdict;
  spendUsd: number;
  /** Summaries of earlier failed attempts on this unit — becomes a defect record. */
  priorFailures?: string[];
}

export type LandResult = { landed: true; mergeSha: string } | { landed: false; reason: string };

/**
 * Everything a landing may write, and nothing else. The engine's ledgers
 * (`.doctrine/ticks.jsonl`, `.doctrine/metrics.jsonl`) are deliberately absent: they
 * are appended every tick, so sweeping them onto a unit branch makes the branch track
 * a snapshot the base branch does not, and the next checkout of that branch refuses.
 */
function bookkeepingPaths(unitId: string): string[] {
  return [
    join("work", `${unitId}.md`),
    join("context", "decisions.md"),
    join("context", "defects"),
    join("context", "review-findings"),
  ];
}

/**
 * Ensure the unit's status IS `to`. Already being there is success — the review loop
 * re-enters `openUnitPr` on a branch whose unit already says `in-review`, and treating
 * a no-op write as bookkeeping drift would park a perfectly healthy unit.
 */
function flipUnitStatus(arenaDir: string, unitId: string, to: string): boolean {
  const path = join(arenaDir, "work", `${unitId}.md`);
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  const flipped = text.replace(/^status:\s*\S+/m, `status: ${to}`);
  if (flipped === text) return new RegExp(`^status:\\s*${to}\\s*$`, "m").test(text);
  writeFileSync(path, flipped);
  return true;
}

function appendDecision(arenaDir: string, line: string): void {
  const dir = join(arenaDir, "context");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "decisions.md");
  if (!existsSync(path)) {
    writeFileSync(path, "# Decisions (append-only; supersede, don't delete)\n\n");
  }
  appendFileSync(path, `${line}\n`);
}

function writeDefectRecord(arenaDir: string, unit: WorkUnit, priorFailures: string[]): string {
  const dir = join(arenaDir, "context", "defects");
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = join(dir, `${date}-${unit.id}.md`);
  writeFileSync(
    path,
    `# Defect record — ${unit.id}

**What happened.** ${priorFailures.length} failed attempt(s) before the verified fix landed.

**Failures observed.**
${priorFailures.map((f) => `- ${f}`).join("\n")}

**Guard (ratchet).** The unit's evidence specs now pass under the judge; if this class of
failure recurs, promote the failing observation into a canary.
`,
  );
  return path;
}

/**
 * Merge the verified branch. ff-only is preferred (the branch was cut from base);
 * a moved base falls back to a merge commit; a conflict aborts cleanly and reports —
 * the loop parks the unit rather than resolving conflicts unattended at v1.
 */
export function landUnit(ctx: LandContext): LandResult {
  const { arenaDir } = ctx;
  git(arenaDir, ["checkout", "-q", ctx.baseBranch]);

  try {
    git(arenaDir, ["merge", "--ff-only", ctx.branch]);
  } catch {
    try {
      execFileSync(
        "git",
        ["-c", "user.name=doctrine-engine", "-c", "user.email=engine@doctrine.local", "merge", "--no-ff", "-q", "-m", `doctrine: merge ${ctx.branch}`, ctx.branch],
        { cwd: arenaDir, encoding: "utf8" },
      );
    } catch {
      try {
        git(arenaDir, ["merge", "--abort"]);
      } catch { /* no merge in progress */ }
      return { landed: false, reason: `merge conflict landing ${ctx.branch} — unit parked for the observer` };
    }
  }

  // Landing commit: status flip + capture records, verified as artifacts
  // (a unit must never be left marked in-progress with nothing working on it: the
  // state move is part of the landing).
  const flipped = flipUnitStatus(arenaDir, ctx.unit.id, "merged");
  appendDecision(
    arenaDir,
    `- ${new Date().toISOString().slice(0, 10)} **${ctx.unit.id}** — ${ctx.unit.title}. Landed ${ctx.headSha.slice(0, 8)} (judge: pass; $${ctx.spendUsd.toFixed(2)}).`,
  );
  if (ctx.priorFailures !== undefined && ctx.priorFailures.length > 0) {
    writeDefectRecord(arenaDir, ctx.unit, ctx.priorFailures);
  }
  stagePaths(arenaDir, bookkeepingPaths(ctx.unit.id));
  commitAs(arenaDir, `doctrine: land ${ctx.unit.id} (status: merged; captured)`);

  if (!flipped) {
    // Loud, not silent: landing succeeded but bookkeeping could not be verified.
    return { landed: false, reason: `${ctx.unit.id} merged but its work-unit file could not be status-flipped — bookkeeping drift, parked for the observer` };
  }

  // Guarded like the other two deletions in this file. The work is already merged at
  // this point, so a branch that refuses to go — held by a worktree somewhere, which a
  // preserved one now legitimately is — is untidiness, not a failed landing. Throwing
  // here would turn a successful merge into a thrown tick.
  try { git(arenaDir, ["branch", "-D", ctx.branch]); } catch { /* reaped next tick */ }
  return { landed: true, mergeSha: git(arenaDir, ["rev-parse", "HEAD"]) };
}

/**
 * PR landing (added 2026-08-18): on production targets the loop lands
 * each verified unit from a feature branch pushed to origin with a PR into the
 * base branch, MACHINE-MERGED on judge pass — no waiting, no thread-resolution
 * gate. The PR exists to harvest external bot review as a non-blocking
 * instrument; findings are triaged into maintenance units. Bookkeeping (status
 * flip + capture records) is committed ON the unit branch so the remote merge
 * lands code and state atomically — a merged PR can never leave the unit
 * looking un-merged (the remote form of a unit left marked in-progress with
 * nothing working on it).
 */

export type RunGhFn = (args: string[], cwd: string) => string;

export const productionRunGh: RunGhFn = (args, cwd) =>
  execFileSync("gh", args, { cwd, encoding: "utf8" }).trim();

export interface PrLandContext extends LandContext {
  /** Injected `gh` runner (tests); production shells out to `gh`, shell:false. */
  runGh?: RunGhFn;
  /** Backoff base for the merge retry (tests shrink it). Default 4000ms. */
  mergeRetryDelayMs?: number;
}

/** Synchronous sleep — the landing path is deliberately synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * GitHub computes a fresh PR's mergeability asynchronously; a merge fired right
 * after create/push races it and fails with "Pull Request is not mergeable"
 * (observed live on the first bridge unit). Retry ONLY that
 * class of failure, with linear backoff; anything else throws through.
 */
function ghMergeWithRetry(gh: RunGhFn, args: string[], cwd: string, delayMs: number): void {
  // 8 attempts with linear backoff is ~2.4 minutes at the 4s base, against ~40 seconds
  // at 5. The old window was measured against a fresh PR; a base branch that MOVED is
  // the slower case, and one PR outlasted 5 attempts and then merged by hand
  // about half a minute later. Waiting costs a sleeping tick; giving up costs a parked
  // unit that needs a person, which is the expensive direction in an unattended loop.
  const RETRIES = 8;
  let last: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      gh(args, cwd);
      return;
    } catch (e) {
      last = e;
      if (!/not mergeable|mergeability|base branch was modified/i.test(ghFailureText(e))) throw e;
      if (attempt < RETRIES) sleepSync(delayMs * attempt);
    }
  }
  throw last;
}

/**
 * Everything the failure actually said: the message AND `gh`'s stderr.
 *
 * `execFileSync` puts the diagnosis in `stderr` and only the command line in `message`,
 * so reading `message` alone is how a park reason ends up saying "Command failed" and
 * nothing else. Both callers here want the same thing — one to decide whether to retry,
 * the other to tell the observer what happened — and only one of them used to look.
 */
export function ghFailureText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
  const stdout = String((e as { stdout?: unknown }).stdout ?? "").trim();
  return [message, stderr, stdout].filter((x) => x.length > 0).join(" | ").replace(/\s*\r?\n\s*/g, " ");
}

/** Undo a failed PR landing: back to base, branch reset to the judged head so a
 *  resume re-judges clean code without the bookkeeping commit in the diff. */
function restoreBranch(arenaDir: string, baseBranch: string, branch: string, headSha: string): void {
  try { git(arenaDir, ["checkout", "-q", baseBranch]); } catch { /* best effort */ }
  try { git(arenaDir, ["branch", "-f", branch, headSha]); } catch { /* best effort */ }
}

export function landUnitViaPr(ctx: PrLandContext): LandResult {
  const { arenaDir } = ctx;
  const gh = ctx.runGh ?? productionRunGh;

  try {
    // 1. Publish the judged head and open the PR (URL is needed for the record).
    git(arenaDir, ["push", "-q", "-u", "origin", ctx.branch]);
    const prUrl = gh(
      [
        "pr", "create",
        "--base", ctx.baseBranch,
        "--head", ctx.branch,
        "--title", `doctrine: ${ctx.unit.id} — ${ctx.unit.title}`,
        "--body", `Machine-landed by the doctrine engine after a passing judge verdict (spend $${ctx.spendUsd.toFixed(2)}). Review is an instrument, not a gate: findings on this PR are triaged into maintenance units; they do not block the merge.`,
      ],
      arenaDir,
    );

    // 2. Bookkeeping ON the branch, inside what the PR merges: status flip,
    //    decision record (with the PR), defect record. Atomic with the code.
    git(arenaDir, ["checkout", "-q", ctx.branch]);
    if (!flipUnitStatus(arenaDir, ctx.unit.id, "merged")) {
      restoreBranch(arenaDir, ctx.baseBranch, ctx.branch, ctx.headSha);
      return { landed: false, reason: `${ctx.unit.id}: work-unit file could not be status-flipped — bookkeeping drift, parked for the observer (open PR: ${prUrl})` };
    }
    appendDecision(
      arenaDir,
      `- ${new Date().toISOString().slice(0, 10)} **${ctx.unit.id}** — ${ctx.unit.title}. Landed ${ctx.headSha.slice(0, 8)} (judge: pass; $${ctx.spendUsd.toFixed(2)}; PR ${prUrl}).`,
    );
    if (ctx.priorFailures !== undefined && ctx.priorFailures.length > 0) {
      writeDefectRecord(arenaDir, ctx.unit, ctx.priorFailures);
    }
    stagePaths(arenaDir, bookkeepingPaths(ctx.unit.id));
    commitAs(arenaDir, `doctrine: land ${ctx.unit.id} (status: merged; captured)`);
    git(arenaDir, ["push", "-q", "origin", ctx.branch]);

    // 3. The machine gate: merge the PR. The judge already passed; nothing waits
    //    (the retry absorbs GitHub's async mergeability computation, not review).
    ghMergeWithRetry(gh, ["pr", "merge", ctx.branch, "--merge"], arenaDir, ctx.mergeRetryDelayMs ?? 4000);
  } catch (e) {
    restoreBranch(arenaDir, ctx.baseBranch, ctx.branch, ctx.headSha);
    const detail = e instanceof Error ? e.message.split(/\r?\n/)[0]! : String(e);
    return { landed: false, reason: `PR landing failed (${detail.slice(0, 160)}) — unit parked for the observer` };
  }

  // 4. Sync the local base to the remote merge; clean up the branch.
  git(arenaDir, ["checkout", "-q", ctx.baseBranch]);
  try {
    git(arenaDir, ["fetch", "-q", "origin", ctx.baseBranch]);
    git(arenaDir, ["merge", "--ff-only", `origin/${ctx.baseBranch}`]);
  } catch {
    return { landed: false, reason: `${ctx.unit.id} merged on origin but the local base could not fast-forward — sync drift, parked for the observer` };
  }
  try { git(arenaDir, ["push", "-q", "origin", "--delete", ctx.branch]); } catch { /* remote GC */ }
  try { git(arenaDir, ["branch", "-D", ctx.branch]); } catch { /* reaped next tick */ }
  return { landed: true, mergeSha: git(arenaDir, ["rev-parse", "HEAD"]) };
}


/**
 * Two-phase PR landing. Phase 1: publish the judged
 * branch, open the PR, and STOP — the unit goes to `in-review` and the tick returns.
 * Phase 2 is a later tick (dispatch's review rung), after the review window.
 *
 * The pause lives between ticks rather than inside a sleeping landing call for the
 * reason the whole engine is built that way: state is re-derived from committed
 * artifacts every tick. A unit waiting for review is a unit whose file says
 * `in-review` and whose branch has an open PR — nothing is held in memory, and a
 * crash mid-window costs nothing.
 */
export function openUnitPr(ctx: PrLandContext): { opened: true; pr: OpenPr } | { opened: false; reason: string } {
  const { arenaDir } = ctx;
  const gh = ctx.runGh ?? productionRunGh;

  // Idempotent by construction: the review loop comes back through here after a fix
  // has been judged, and `gh pr create` on a branch that already has one fails. An
  // existing PR is the same PR — reuse it and push the new head into it.
  const existing = findOpenPr(gh, ctx.branch, arenaDir);
  if (!existing.looked) {
    return { opened: false, reason: `could not check for an existing PR on ${ctx.branch} (${existing.error}) — retried next tick` };
  }
  const reusing = existing.value !== null;

  try {
    git(arenaDir, ["push", "-q", "-u", "origin", ctx.branch]);
    const prUrl = reusing ? existing.value!.url : gh(
      [
        "pr", "create",
        "--base", ctx.baseBranch,
        "--head", ctx.branch,
        "--title", `doctrine: ${ctx.unit.id} — ${ctx.unit.title}`,
        "--body", `Machine-opened by the doctrine engine after a passing judge verdict (spend $${ctx.spendUsd.toFixed(2)}).\n\nThe loop is waiting for external review on this PR and will address what it finds on this branch, then merge. Review is an instrument with a bounded window, never a gate: after the configured rounds the unit merges regardless and any unaddressed thread is recorded. The human gate is ${ctx.baseBranch} → main.`,
      ],
      arenaDir,
    );

    // Bookkeeping ON the branch, as in the one-phase path — but the status is
    // `in-review`, not `merged`. The unit is not landed yet and must never look it.
    git(arenaDir, ["checkout", "-q", ctx.branch]);
    if (!flipUnitStatus(arenaDir, ctx.unit.id, "in-review")) {
      restoreBranch(arenaDir, ctx.baseBranch, ctx.branch, ctx.headSha);
      return { opened: false, reason: `${ctx.unit.id}: work-unit file could not be status-flipped to in-review — bookkeeping drift, parked for the observer (open PR: ${prUrl})` };
    }
    appendDecision(
      arenaDir,
      `- ${new Date().toISOString().slice(0, 10)} **${ctx.unit.id}** — ${ctx.unit.title}. Judged pass at ${ctx.headSha.slice(0, 8)} ($${ctx.spendUsd.toFixed(2)}); PR ${prUrl} ${reusing ? "re-judged after a review fix" : "open for review"}.`,
    );
    if (ctx.priorFailures !== undefined && ctx.priorFailures.length > 0) {
      writeDefectRecord(arenaDir, ctx.unit, ctx.priorFailures);
    }
    stagePaths(arenaDir, bookkeepingPaths(ctx.unit.id));
    if (git(arenaDir, ["diff", "--cached", "--name-only"]).length > 0) {
      commitAs(arenaDir, `doctrine: ${ctx.unit.id} judged pass, PR ${reusing ? "updated" : "open"} (status: in-review)`);
    }
    git(arenaDir, ["push", "-q", "origin", ctx.branch]);
    git(arenaDir, ["checkout", "-q", ctx.baseBranch]);
  } catch (e) {
    restoreBranch(arenaDir, ctx.baseBranch, ctx.branch, ctx.headSha);
    const detail = e instanceof Error ? e.message.split(/\r?\n/)[0]! : String(e);
    return { opened: false, reason: `opening the PR failed (${detail.slice(0, 160)}) — unit parked for the observer` };
  }

  const pr = findOpenPr(gh, ctx.branch, arenaDir);
  if (!pr.looked || pr.value === null) {
    return { opened: false, reason: `${ctx.unit.id}: PR was created but cannot be found for branch ${ctx.branch} — parked for the observer` };
  }
  return { opened: true, pr: pr.value };
}

export interface MergeOpenPrContext {
  arenaDir: string;
  baseBranch: string;
  unit: WorkUnit;
  branch: string;
  /** Recorded in the landing decision — e.g. how review was settled. */
  note: string;
  runGh?: RunGhFn;
  mergeRetryDelayMs?: number;
}

/**
 * Phase 2: flip the unit to `merged` on its own branch, then merge the PR, so the
 * remote merge lands code and state atomically — a merged PR can never leave the
 * unit looking un-merged (the remote form of a unit left marked in-progress
 * with nothing working on it).
 */
export function mergeOpenPr(ctx: MergeOpenPrContext): LandResult {
  const { arenaDir } = ctx;
  const gh = ctx.runGh ?? productionRunGh;
  const headSha = git(arenaDir, ["rev-parse", ctx.branch]);

  try {
    git(arenaDir, ["checkout", "-q", ctx.branch]);
    if (!flipUnitStatus(arenaDir, ctx.unit.id, "merged")) {
      restoreBranch(arenaDir, ctx.baseBranch, ctx.branch, headSha);
      return { landed: false, reason: `${ctx.unit.id}: work-unit file could not be status-flipped to merged — bookkeeping drift, parked for the observer` };
    }
    appendDecision(
      arenaDir,
      `- ${new Date().toISOString().slice(0, 10)} **${ctx.unit.id}** — ${ctx.unit.title}. Merged ${headSha.slice(0, 8)}. ${ctx.note}`,
    );
    stagePaths(arenaDir, bookkeepingPaths(ctx.unit.id));
    commitAs(arenaDir, `doctrine: land ${ctx.unit.id} (status: merged; ${ctx.note})`);
    git(arenaDir, ["push", "-q", "origin", ctx.branch]);
    ghMergeWithRetry(gh, ["pr", "merge", ctx.branch, "--merge"], arenaDir, ctx.mergeRetryDelayMs ?? 4000);
  } catch (e) {
    restoreBranch(arenaDir, ctx.baseBranch, ctx.branch, headSha);
    // gh's OWN words, not just the command line that produced them. The first line of
    // an execFileSync error is "Command failed: gh pr merge <branch> --merge" and says
    // nothing whatever about why — which is what an observer is handed when a unit
    // parks. It happened for real on one PR and the cause could not be
    // established afterwards, because the only party that knew was `gh` and its answer
    // had been discarded.
    return { landed: false, reason: `merging the reviewed PR failed (${ghFailureText(e).slice(0, 400)}) — unit parked for the observer` };
  }

  git(arenaDir, ["checkout", "-q", ctx.baseBranch]);
  try {
    git(arenaDir, ["fetch", "-q", "origin", ctx.baseBranch]);
    git(arenaDir, ["merge", "--ff-only", `origin/${ctx.baseBranch}`]);
  } catch {
    return { landed: false, reason: `${ctx.unit.id} merged on origin but the local base could not fast-forward — sync drift, parked for the observer` };
  }
  try { git(arenaDir, ["push", "-q", "origin", "--delete", ctx.branch]); } catch { /* remote GC */ }
  try { git(arenaDir, ["branch", "-D", ctx.branch]); } catch { /* reaped next tick */ }
  return { landed: true, mergeSha: git(arenaDir, ["rev-parse", "HEAD"]) };
}

/** Remove a worktree robustly (Windows node_modules junctions). */
export function removeWorktree(arenaDir: string, worktreeDir: string): void {
  try {
    git(arenaDir, ["worktree", "remove", "--force", worktreeDir]);
  } catch { /* fall through */ }
  try {
    rmSync(worktreeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* pruned next run */ }
  try {
    git(arenaDir, ["worktree", "prune"]);
  } catch { /* best effort */ }
}
