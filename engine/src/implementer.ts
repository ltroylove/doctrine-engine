import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildClaudeArgv } from "./argv.js";
import type { RunFailureReason } from "./outcome.js";
import { classifySpawn, runAgent as productionRunAgent } from "./spawn.js";
import type { RunAgentFn } from "./judge.js";
import type { WorkUnit } from "./work-unit.js";

export interface ImplementContext {
  unit: WorkUnit;
  arenaDir: string;
  baseBranch: string;
  /** Worktree + branch are created here by the runner. */
  worktreeDir: string;
  logPath: string;
  agentDefinitionPath: string;
  /**
   * What the judges said about earlier attempts at THIS unit.
   *
   * Without it a retry is not a second attempt at the problem — it is the same attempt
   * a second time, an independent re-roll of one spec. Observed on one target's
   * first UI unit: two runs at ~$17 each, five design findings fixed by chance, five
   * new ones introduced, and the two structural ones untouched both times, because
   * nothing carried the first verdict into the second run.
   *
   * The decompose rung has had `priorRejection` since 2026-08-24 and the program rung
   * since #18; this is the same channel for the rung that writes the code.
   */
  priorFailures?: readonly string[];
  /** Deny-rules settings file (one-way doors) passed to the CLI. */
  settingsPath?: string;
  timeoutMs?: number;
  runAgent?: RunAgentFn;
}

export type ImplementOutcome =
  | {
      kind: "implemented";
      branch: string;
      baseSha: string;
      headSha: string;
      worktreeDir: string;
      spendUsd: number;
      logPath: string;
    }
  | {
      kind: "failed";
      reason: RunFailureReason;
      outage: boolean;
      detail: string;
      logPath: string;
      /**
       * The worktree still holds work that could not be committed. The caller must NOT
       * force-remove it: at this point the worktree is the only copy.
       */
      preserveWorktree?: boolean;
    };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function agentLaw(path: string): string {
  const text = readFileSync(path, "utf8");
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return (m ? m[1]! : text).trim();
}

export function assembleImplementerPrompt(ctx: ImplementContext): string {
  const evidence = ctx.unit.evidence
    .map((e, i) => `${i}. [${e.kind}] run: ${e.run}\n   expect: ${e.expect}`)
    .join("\n");
  const contextDir = join(ctx.worktreeDir, "context");
  const contextNote = existsSync(contextDir)
    ? "\nA context/ directory exists in your worktree — read contracts.md, decisions.md, and defects/ before you design anything.\n"
    : "";
  const priors = (ctx.priorFailures ?? []).filter((f) => f.trim().length > 0);
  const priorNote = priors.length === 0 ? "" : `
## Earlier attempts at this unit were rejected — do not repeat them

You have been here before. These are the verdicts, newest last. Read them as a list of
things that must be TRUE of what you write now, not as a list of edits to make to code
that no longer exists: each attempt started from the same base you did, so none of the
fixes survive and every one of these can recur.

${priors.map((f, i) => `${i + 1}. ${f}`).join("\n\n")}

Where a finding names a structural problem — a figure the screen promises and does not
show, a label that disappears at a breakpoint — solve THAT before polishing anything a
later finding mentions. Those are the ones that survived the previous attempts, and they
survived because they are the work.
`;
  return `${agentLaw(ctx.agentDefinitionPath)}

---

# Your unit

id: ${ctx.unit.id}
title: ${ctx.unit.title}
tier: ${ctx.unit.tier}
budget_usd: ${ctx.unit.budgetUsd}

## Intent
${ctx.unit.body}

## Evidence specs (the judge executes exactly these)
${evidence}
${contextNote}${priorNote}
You are already in your worktree on your branch. Build the unit, run the evidence
yourself, commit your work. Nothing else.`;
}

/**
 * Run the implementer for one unit: cut branch + worktree from base, one budgeted
 * ACT, then trust artifacts only — the branch head must have moved. Uncommitted
 * leftovers are salvage-committed by the ENGINE (they are part of the diff the judge
 * must see; silently losing them would make the artifact lie).
 */
export async function runImplementer(ctx: ImplementContext): Promise<ImplementOutcome> {
  const invoke = ctx.runAgent ?? productionRunAgent;
  const baseSha = git(ctx.arenaDir, ["rev-parse", ctx.baseBranch]);
  const branch = `doctrine/${ctx.unit.id}-${Date.now()}`;
  git(ctx.arenaDir, ["worktree", "add", "-b", branch, ctx.worktreeDir, baseSha]);

  const spawned = await invoke(assembleImplementerPrompt(ctx), {
    argv: buildClaudeArgv({
      maxBudgetUsd: ctx.unit.budgetUsd,
      allowedTools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
      permissionMode: "dontAsk",
      ...(ctx.settingsPath !== undefined ? { settingsPath: ctx.settingsPath } : {}),
    }),
    cwd: ctx.worktreeDir,
    timeoutMs: ctx.timeoutMs ?? 30 * 60_000,
    logPath: ctx.logPath,
  });

  const spawnFailure = classifySpawn(spawned);

  // Salvage uncommitted work — the judge must see the real diff, not a partial one.
  //
  // This runs BEFORE the spawn-failure return, and the order is the whole point. A
  // killed run is the case that most needs salvaging: the wall clock fires wherever it
  // fires, and landing between the last edit and the commit is ordinary. Returning
  // first left those edits in a worktree that the caller then force-removes, so "the
  // process died" and "it built nothing" became the same outcome — and one of them is
  // a finished unit. Now whatever exists is committed first, and the caller keeps any
  // branch that has a commit for rung 0 to judge.
  // The probe is inside the guard too. An unreadable or corrupt index makes `status`
  // itself throw, and that throw would escape before anything could say the work needs
  // keeping — the same loss, one line earlier. A question that cannot be answered is
  // treated as "there may be work here", which is the only safe reading of it.
  let dirty: string;
  try {
    dirty = git(ctx.worktreeDir, ["status", "--porcelain"]);
  } catch (e) {
    return {
      kind: "failed",
      reason: spawnFailure ?? "no-commit",
      outage: spawned.outage,
      detail: `implementer worktree could not be inspected (${String(e).slice(0, 200)}) — it may still hold uncommitted work`,
      logPath: ctx.logPath,
      preserveWorktree: true,
    };
  }
  if (dirty.length > 0) {
    // The message says the run was interrupted, because that changes how the diff
    // should be read: it may be a half-written thought rather than a finished one. The
    // judge still decides on the artifacts — a salvaged branch is judged, not trusted.
    const message = spawnFailure === null
      ? "salvage: uncommitted implementer changes"
      : `salvage: implementer interrupted (${spawnFailure}) — this work may be incomplete`;
    try {
      // `add` is inside the try with the commit, because it fails for the same reasons
      // the commit does — a held index lock stops both — and a throw from here would
      // escape the salvage entirely and take the work with it.
      git(ctx.worktreeDir, ["add", "-A"]);
      execFileSync(
        "git",
        [
          "-c", "user.name=doctrine-engine", "-c", "user.email=engine@doctrine.local",
          // --no-verify, because a hook must not be able to destroy work. Salvage is the
          // engine preserving artifacts for judgement, not the unit claiming to be done —
          // and a target's pre-commit hook is precisely the thing that would reject an
          // interrupted tree, which is the tree that most needs keeping. The unit's real
          // gates are its evidence specs, and the judge executes those either way.
          "commit", "-q", "--no-verify", "-m", message,
        ],
        { cwd: ctx.worktreeDir, encoding: "utf8" },
      );
    } catch (e) {
      // Even so: a commit that cannot be made must not take the work with it. The
      // worktree still holds every edit, so say so and let the caller keep it rather
      // than force-removing it on the way past.
      return {
        kind: "failed",
        reason: spawnFailure ?? "no-commit",
        outage: spawned.outage,
        detail: `implementer work could not be salvage-committed (${String(e).slice(0, 200)}) — the worktree still holds it`,
        logPath: ctx.logPath,
        preserveWorktree: true,
      };
    }
  }

  if (spawnFailure !== null) {
    return {
      kind: "failed",
      reason: spawnFailure,
      outage: spawned.outage,
      detail: `implementer run failed at spawn level: ${spawnFailure}`,
      logPath: ctx.logPath,
    };
  }

  const headSha = git(ctx.worktreeDir, ["rev-parse", "HEAD"]);
  if (headSha === baseSha) {
    return {
      kind: "failed",
      reason: "no-commit",
      outage: false,
      detail: "implementer ran but the branch head never moved — an empty branch is an honest failure",
      logPath: ctx.logPath,
    };
  }

  return {
    kind: "implemented",
    branch,
    baseSha,
    headSha,
    worktreeDir: ctx.worktreeDir,
    spendUsd: spawned.resultMessage?.total_cost_usd ?? 0,
    logPath: ctx.logPath,
  };
}
