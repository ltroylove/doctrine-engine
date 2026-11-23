import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildClaudeArgv } from "./argv.js";
import type { RunFailureReason } from "./outcome.js";
import { runSetup } from "./setup.js";
import { classifySpawn, runAgent as productionRunAgent } from "./spawn.js";
import type { RunAgentFn } from "./judge.js";
import type { WorkUnit } from "./work-unit.js";

/**
 * ONE budgeted pass that addresses findings ON THE UNIT'S OWN BRANCH.
 *
 * **Two callers, one mechanism, and that is deliberate.** It began as the review-fix ACT,
 * addressing external review findings after a PR was open. The code-judge now sends its own findings through the same pass, before the PR
 * exists — because the job is identical: here is a branch, here is a list of what is
 * wrong with it, change those things.
 *
 * Writing it twice was the alternative and it is the shape this repo has paid for six
 * times: two implementations of one rule, one of which gets the next fix. What legitimately
 * differs is the LAW (`review-fixer.md` answers a person; `unit-fixer.md` conforms a diff
 * to its spec) and three sentences of framing, which `source` selects.
 *
 * **What this deliberately is not.** It does not read the intent, it does not touch
 * `work/`, and it cannot edit `context/contracts.md` or the target's program
 * documents — `REVIEW_FIX_DENY` takes those away at the permission layer. The failure
 * being designed out: an earlier loop that fed PR comments into its
 * planning documents, rewrote them, and then built against the rewrite, so review
 * feedback became re-planning churn and the unit under review was never finished. A
 * finding is a defect in one diff. Fixing it is a diff. If a finding is genuinely new
 * scope, the honest answer is to say so in the reply and leave it — a maintenance
 * unit is where new scope goes, on a later tick, through intake.
 */

export interface ReviewFixContext {
  unit: WorkUnit;
  arenaDir: string;
  /** The unit's existing branch — this ACT amends it, it never cuts a new one. */
  branch: string;
  /** Worktree created here by the runner, checked out ON `branch`. */
  worktreeDir: string;
  /**
   * What is wrong with the branch, one entry per thing, already written to be acted on.
   *
   * Strings rather than review threads because the code-judge's findings are not threads
   * and never will be. The review rung formats its threads with `formatThread` before
   * calling; that keeps the anchor (`path:line — by author`) it had, and stops this
   * function knowing anything about GitHub.
   */
  findings: readonly string[];
  /** Which caller, and therefore which three sentences of framing the prompt carries. */
  source: "review" | "judge";
  logPath: string;
  agentDefinitionPath: string;
  /**
   * The target's setup command, run in the fix worktree before the ACT.
   *
   * It was not, and that was a hole rather than an economy: this pass holds `Bash` and
   * both its laws tell it to run the failing command and then re-run the evidence. A
   * fresh worktree has no `node_modules`, so every one of those runs failed on the
   * harness, and a fixer that cannot reproduce a finding is guessing at it.
   */
  setup?: string;
  /** Deny-rules settings: floor + target doors + REVIEW_FIX_DENY. */
  settingsPath?: string;
  timeoutMs?: number;
  runAgent?: RunAgentFn;
  /** Budget for this pass; defaults to half the unit's, since it is a fix, not a build. */
  budgetUsd?: number;
}

/**
 * Findings the ACT answered with an argument instead of a diff, one line each.
 *
 * Declared with a `Deferred-to-intake:` trailer on the review-fix commit. A trailer
 * rather than a new artifact because the commit message is ALREADY the channel — it is
 * what `answer` carries to the reviewer — and this only makes one part of it legible to
 * the engine.
 *
 * It exists because a reasoned refusal was silently lost. On one PR the fixer
 * addressed two findings, argued the third was real but belonged to a unit that does
 * not exist yet, and wrote "This belongs in intake as a maintenance unit. It is not
 * filed from this branch" — correctly, since `work/**` is denied to it. Nothing else
 * filed it either: `recordUnaddressed` fires only on threads still OPEN at round
 * exhaustion, and the fixer had answered and resolved all three. The finding survived
 * only as prose in a commit message, and the production break it described was real.
 */
export type ReviewFixOutcome =
  | { kind: "fixed"; headSha: string; spendUsd: number; logPath: string; answer: string; deferred: string[] }
  /** No commit — the ACT argued rather than edited. `answer` is that argument, and it
   *  is the ONLY channel to the reviewer, so it is carried out of the run explicitly
   *  rather than read back off the branch, where the newest commit is the engine's own
   *  bookkeeping and has nothing to do with the finding. */
  | { kind: "no-change"; spendUsd: number; logPath: string; answer: string; deferred: string[] }
  | { kind: "failed"; reason: RunFailureReason; outage: boolean; detail: string; logPath: string };

/** A newline. A literal one here has been mangled by every shell edit this file saw. */
const LF = String.fromCharCode(10);

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function agentLaw(path: string): string {
  const text = readFileSync(path, "utf8");
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return (m ? m[1]! : text).trim();
}

export function assembleReviewFixPrompt(ctx: ReviewFixContext): string {
  const evidence = ctx.unit.evidence
    .map((e, i) => `${i}. [${e.kind}] run: ${e.run}\n   expect: ${e.expect}`)
    .join(LF);
  const n = ctx.findings.length;
  const numbered = ctx.findings.map((f, i) => `${i + 1}. ${f.trim()}`).join(LF + LF);
  const heading = ctx.source === "review"
    ? `## What the reviewer found (${n} thread${n === 1 ? "" : "s"})`
    : `## What the judge found (${n} finding${n === 1 ? "" : "s"}) — this is the complete list`;
  const wrong = ctx.source === "review"
    ? `A finding you judge to be wrong is not addressed by changing the code — leave it and
say why in your commit message; the engine puts that in the reply.`
    : `A finding you judge to be wrong is not addressed by changing the code — leave it and
say why in your commit message. But be slow to reach for that: the judge executed the
evidence and read the diff, and "the finding is mistaken" is the one answer nothing else
checks.`;
  return `${agentLaw(ctx.agentDefinitionPath)}

---

# The unit

id: ${ctx.unit.id}
title: ${ctx.unit.title}

## Its evidence specs — unchanged, and still binding after your fix
${evidence}

${heading}

${numbered}

---

You are in a worktree on this unit's own branch, with its diff already in it. Address
each finding in the code, run the evidence specs above yourself, and commit.

${wrong} A finding that is correct but is new scope rather than a defect in this diff is
the same: it belongs to a maintenance unit through intake, not to this branch.

**Anything you do not fix, declare.** Put one \`Deferred-to-intake: <what and why>\`
trailer in your commit message per finding you are leaving, and the engine records it as
maintenance intake rather than losing it. A finding silently left alone is the one
failure mode here that nothing downstream can see.

You cannot edit the unit file, the intent, the contracts, or the program documents, and
that is deliberate. A finding is a defect in one diff; it is never a reason to re-plan.`;
}

/**
 * One review-fix pass. Trust artifacts, never claims: the branch head must have moved
 * for this to count as a fix, and `no-change` is an honest, non-failing outcome —
 * some findings are correctly answered with an argument rather than a diff.
 */
export async function runFixPass(ctx: ReviewFixContext): Promise<ReviewFixOutcome> {
  const invoke = ctx.runAgent ?? productionRunAgent;
  const startSha = git(ctx.arenaDir, ["rev-parse", ctx.branch]);
  git(ctx.arenaDir, ["worktree", "add", ctx.worktreeDir, ctx.branch]);
  if (ctx.setup !== undefined) runSetup(ctx.setup, [ctx.worktreeDir]);

  const spawned = await invoke(assembleReviewFixPrompt(ctx), {
    argv: buildClaudeArgv({
      maxBudgetUsd: ctx.budgetUsd ?? Math.max(1, ctx.unit.budgetUsd / 2),
      allowedTools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
      permissionMode: "dontAsk",
      ...(ctx.settingsPath !== undefined ? { settingsPath: ctx.settingsPath } : {}),
    }),
    cwd: ctx.worktreeDir,
    timeoutMs: ctx.timeoutMs ?? 30 * 60_000,
    logPath: ctx.logPath,
  });

  const spawnFailure = classifySpawn(spawned);
  if (spawnFailure !== null) {
    return {
      kind: "failed",
      reason: spawnFailure,
      outage: spawned.outage,
      detail: `review-fix run failed at spawn level: ${spawnFailure}`,
      logPath: ctx.logPath,
    };
  }

  const dirty = git(ctx.worktreeDir, ["status", "--porcelain"]);
  if (dirty.length > 0) {
    git(ctx.worktreeDir, ["add", "-A"]);
    execFileSync(
      "git",
      ["-c", "user.name=doctrine-engine", "-c", "user.email=engine@doctrine.local", "commit", "-q", "-m", "salvage: uncommitted review-fix changes"],
      { cwd: ctx.worktreeDir, encoding: "utf8" },
    );
  }

  const headSha = git(ctx.worktreeDir, ["rev-parse", "HEAD"]);
  const spendUsd = spawned.resultMessage?.total_cost_usd ?? 0;
  if (headSha === startSha) {
    const said = spawned.resultMessage?.result?.trim() ?? "";
    return {
      kind: "no-change",
      spendUsd,
      logPath: ctx.logPath,
      answer: said.length > 0 ? said : "The review-fix pass made no change and gave no explanation.",
      deferred: deferredFrom(said),
    };
  }
  const answer = git(ctx.worktreeDir, ["log", "-1", "--format=%B"]).trim();
  return { kind: "fixed", headSha, spendUsd, logPath: ctx.logPath, answer, deferred: deferredFrom(answer) };
}

/** `Deferred-to-intake:` trailers, in order, trimmed and de-duplicated. */
export function deferredFrom(message: string): string[] {
  const out: string[] = [];
  for (const line of message.split(/\r?\n/)) {
    const m = /^\s*Deferred-to-intake:\s*(.+?)\s*$/i.exec(line);
    if (m && !out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}
