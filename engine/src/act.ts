import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * The workspace discipline every budgeted ACT shares: what it touched, and undoing it.
 *
 * Lifted out of `decompose.ts` unchanged when `build-out.ts` arrived. Copying it was the
 * alternative, and it is the one this engine has paid for repeatedly — `revertAll` below
 * carries two production bugs' worth of hard-won detail, and a second copy would have been
 * a second place to fix them. It lives here rather than being exported from `decompose.ts`
 * because the decompose rung is LEGACY: it dies at cutover, and nothing that
 * outlives it should import from it.
 *
 * No ACT-specific knowledge in here. Which files an ACT may touch is the ACT's own law and
 * is passed in.
 */

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** An agent definition's prose, frontmatter stripped — the law handed to an ACT. */
export function agentLaw(path: string): string {
  const text = readFileSync(path, "utf8");
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return (m ? m[1]! : text).trim();
}

/**
 * What the ACT changed, split by whether its law allowed it.
 *
 * `allowed` is the ACT's lane as a pattern over repo-relative paths, and it is a PARAMETER
 * because the lanes genuinely differ: the decompose rung may write any unit plus
 * `contracts.md`, while build-out may write ONE named unit plus `contracts.md` — the
 * narrower lane a just-in-time ACT is supposed to work in.
 */
export function changedFiles(arenaDir: string, allowed: RegExp): { allowed: string[]; forbidden: string[] } {
  const lines = git(arenaDir, ["status", "--porcelain", "-uall"]).split(/\r?\n/).filter((l) => l.trim().length > 0);
  const ok: string[] = [];
  const forbidden: string[] = [];
  for (const line of lines) {
    // Porcelain v1: two status chars + space + path. The outer trim may have eaten a
    // leading space on the first line, so parse by pattern, not position.
    const m = /^[ MADRCU?!]{1,2}\s+(.+)$/.exec(line);
    if (!m) continue;
    const file = m[1]!.trim().replace(/^"|"$/g, "");
    if (file.startsWith(".doctrine/")) continue; // engine-owned runtime state, not the ACT's doing
    (allowed.test(file) ? ok : forbidden).push(file);
  }
  return { allowed: ok, forbidden };
}

/**
 * Undo everything the ACT did — deriving what that IS, rather than being told.
 *
 * `git checkout -- .` restores tracked files; an untracked one needs `git clean`, and the
 * clean has to be given paths. This function cleaned a fixed `work context` list, so a
 * decomposer that created a file outside its lane was correctly detected, honestly
 * reported as "reverted wholesale", and left on disk for the next tick to inherit — a lie
 * in the one place the loop has to be believed (`doctrine#67`).
 *
 * **It derives the paths instead of taking them, and that is the second fix, not the
 * first.** The first passed them in from the one branch that had already computed them —
 * and there are six cleanup branches. A timeout, a nonzero exit or an engine-state tamper
 * all revert BEFORE `changedFiles` is ever called, so an ACT could write a stray file and
 * then fail, and five of six paths would still leave it behind. That is the same
 * one-path-not-its-sibling shape the fix was for, reappearing among the call sites of the
 * function being fixed, and external review caught it.
 *
 * Deriving makes it unforgettable: there is no argument a caller can omit.
 *
 * Exclude `.doctrine`: `checkout -- .` was silently reverting UNCOMMITTED ledger appends,
 * so each failed decompose wiped the previous failure's metrics row and the
 * consecutive-failures halt could never trip (observed live 2026-08-24 — three straight
 * failures, trailing count never exceeded 1).
 */
export function revertAll(arenaDir: string): void {
  const touched = git(arenaDir, ["status", "--porcelain", "-uall"])
    .split(/\r?\n/)
    .map((line) => /^[ MADRCU?!]{1,2}\s+(.+)$/.exec(line)?.[1]?.trim().replace(/^"|"$/g, ""))
    .filter((f): f is string => f !== undefined && f.length > 0 && !f.startsWith(".doctrine/"));
  git(arenaDir, ["checkout", "--", ".", ":(exclude).doctrine"]);
  const targets = ["work", "context", ...touched];
  try {
    git(arenaDir, ["clean", "-fd", "--", ...targets]);
  } catch {
    git(arenaDir, ["clean", "-fd", "--", "work", "context"]); // a path git will not accept must not block the revert
  }
}
