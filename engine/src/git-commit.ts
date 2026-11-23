import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Engine-authored commit. The NAME marks it machine-made in history; the EMAIL is
 * the clone's configured identity so GitHub can map the commit to an account —
 * an unverifiable engine@doctrine.local email made Vercel refuse to build loop
 * PRs ("GitHub couldn't verify an account for the commit", observed live).
 * Falls back to the placeholder only when the clone has no configured
 * identity (offline test repos).
 */
export function engineCommit(cwd: string, message: string): void {
  // Nothing staged is not an error, and must not be one. `git commit` exits 1 on an
  // empty index, and while every arena commit staged the whole tree that could not
  // happen — the ledgers always churned, so something was always there to commit.
  // With staging narrowed to the paths the engine actually wrote (see stagePaths), a
  // status flip that flips to the status already recorded stages nothing, and the
  // throw took the supervisor down with it on the tick after the first unit landed.
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], { cwd, encoding: "utf8" });
    return; // exit 0 from --quiet means no staged difference
  } catch { /* exit 1 means there IS something staged — carry on and commit it */ }

  let email = "engine@doctrine.local";
  try {
    const configured = execFileSync("git", ["config", "user.email"], { cwd, encoding: "utf8" }).trim();
    if (configured.length > 0) email = configured;
  } catch { /* unconfigured clone — placeholder identity */ }
  execFileSync(
    "git",
    ["-c", "user.name=doctrine-engine", "-c", `user.email=${email}`, "commit", "-q", "-m", message],
    { cwd, encoding: "utf8" },
  );
}

/**
 * Stage exactly the paths the engine wrote, and nothing else.
 *
 * `git add -A` in the arena root looked harmless and was not: it also swept
 * `.doctrine/ticks.jsonl` and `.doctrine/metrics.jsonl` — the engine's own ledgers,
 * appended after every tick — onto whichever unit branch happened to be checked out.
 * The branch then tracked a two-line snapshot of a file the base branch does not
 * track, so the next `git checkout <branch>` hit "untracked working tree files would
 * be overwritten by checkout" and refused. Landing failed and the unit parked, every
 * time, deterministically. Found on the first production unit.
 *
 * Paths that do not exist are skipped rather than erroring: a defect record or a
 * review-findings file only exists on the runs that produce one.
 *
 * A path that is GONE but tracked is not skipped, though — removing a file is as much
 * a thing the engine does as writing one, and `existsSync` alone could not tell the
 * two apart. It skipped the delete, so the removal stayed unstaged forever: the
 * rejected-draft shelf was cleared on disk when an intent was finally accepted, the
 * deletion was never committed, and the next clone brought the spent objection back to
 * argue about a plan that no longer existed. `-A` is scoped to these pathspecs, so
 * staging stays exactly as narrow as it was.
 */
export function stagePaths(cwd: string, relPaths: readonly string[]): void {
  const present = relPaths.filter((rel) => existsSync(join(cwd, rel)) || tracked(cwd, rel));
  if (present.length === 0) return;
  execFileSync("git", ["add", "-A", "--", ...present], { cwd, encoding: "utf8" });
}

/** Is git holding anything under this path? Then its removal is a change to record. */
function tracked(cwd: string, rel: string): boolean {
  try {
    return execFileSync("git", ["ls-files", "--", rel], { cwd, encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}
