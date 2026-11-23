import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runSetup } from "./setup.js";
import { runJudge, judgePaths, type JudgeContext, type JudgeOutcome } from "./judge.js";
import { parseWorkUnit, type WorkUnit } from "./work-unit.js";

/**
 * The canary harness: seed a known defect on a sacrificial branch, run the
 * judge, require it to catch it. This is how the judge's recall becomes a MEASURED
 * number — the graduation criterion for unattended operation — and it runs forever,
 * because gate rot happens during operation, not just before it.
 */

export interface CanaryExpect {
  verdict: "fail" | "escalate";
  /** What the verdict must flag, any-of: "evidence[0]" or "coherence:<criterion-substring>". */
  must_flag?: string | string[];
  /**
   * The arena commit this canary was authored against. A canary is a fixture of a
   * specific tree (calibration lesson: fixtures authored from memory rot); pinning it
   * keeps the sweep measuring the JUDGE, not the arena's drift. Unpinned canaries run
   * against the manifest's base branch head.
   */
  base?: string;
}

export type CanaryResult = "caught" | "missed" | "error";

export interface CanaryRun {
  canaryId: string;
  result: CanaryResult;
  detail: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** True when `ref` (branch, tag, or sha) resolves to a commit in the arena. */
export function commitExists(arenaDir: string, ref: string): boolean {
  try {
    git(arenaDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export interface Sacrifice {
  baseDir: string;
  headDir: string;
  baseSha: string;
  headSha: string;
  diffPath: string;
  cleanup: () => void;
}

/**
 * Deregister and delete one worktree directory, best-effort at every step.
 * `git worktree remove` chokes on Windows junctions and locked files, and so can the
 * delete that follows it — so nothing here is allowed to throw. Whatever survives is
 * pruned on the next run.
 */
export function sweepWorktree(arenaDir: string, dir: string): void {
  try {
    git(arenaDir, ["worktree", "remove", "--force", dir]);
  } catch { /* fall through to rmSync */ }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* leftover dirs are pruned on the next run */ }
  try {
    git(arenaDir, ["worktree", "prune"]);
  } catch { /* best effort */ }
}

/**
 * Build the sacrificial pair: base worktree at `baseRef` (the canary's pinned commit, or
 * the arena's base branch), head worktree
 * with the canary's seeded defect applied and committed (mechanical commit, no story —
 * the judge must never read history anyway).
 */
export function prepareSacrifice(arenaDir: string, patchPath: string, runDir: string, baseRef: string): Sacrifice {
  const baseDir = join(runDir, "base");
  const headDir = join(runDir, "head");
  const cleanup = (): void => {
    for (const dir of [headDir, baseDir]) sweepWorktree(arenaDir, dir);
  };

  // A crashed earlier run (patch failed to apply, process killed) must not poison this
  // one: sweep whatever it left at this runDir before building anew. Every delete here
  // is best-effort on purpose — a sweep that throws would let one crashed run poison
  // every sweep after it, which is the failure this whole block exists to prevent.
  cleanup();
  try {
    rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* the worktrees are already deregistered; git speaks up if residue still blocks the build */ }
  mkdirSync(runDir, { recursive: true });
  const baseSha = git(arenaDir, ["rev-parse", `${baseRef}^{commit}`]);

  try {
    git(arenaDir, ["worktree", "add", "--detach", headDir, baseSha]);
    git(headDir, ["apply", patchPath]);
    git(headDir, ["add", "-A"]);
    execFileSync(
      "git",
      ["-c", "user.name=doctrine-canary", "-c", "user.email=canary@doctrine.local", "commit", "-q", "-m", "canary"],
      { cwd: headDir, encoding: "utf8" },
    );
    const headSha = git(headDir, ["rev-parse", "HEAD"]);

    git(arenaDir, ["worktree", "add", "--detach", baseDir, baseSha]);

    const diffPath = join(runDir, "diff.patch");
    const diff = execFileSync("git", ["diff", baseSha, headSha], { cwd: headDir, encoding: "utf8" });
    appendFileSync(diffPath, diff);
    return { baseDir, headDir, baseSha, headSha, diffPath, cleanup };
  } catch (e) {
    cleanup(); // never leave a half-built sacrifice registered in the arena
    throw e;
  }
}

/** Judge-outcome vs expectation. Exported for offline tests. */
export function evaluateCatch(outcome: JudgeOutcome, expect: CanaryExpect): { result: CanaryResult; detail: string } {
  if (outcome.kind === "failed") {
    return { result: "error", detail: `judge run failed (${outcome.reason}): ${outcome.errors.join("; ")}` };
  }
  const v = outcome.verdict;
  if (v.verdict !== expect.verdict) {
    return { result: "missed", detail: `judge said "${v.verdict}", canary demands "${expect.verdict}"` };
  }
  const flags = expect.must_flag === undefined ? [] : Array.isArray(expect.must_flag) ? expect.must_flag : [expect.must_flag];
  if (flags.length === 0) return { result: "caught", detail: "verdict matched" };

  for (const flag of flags) {
    const evidenceMatch = /^evidence\[(\d+)\]$/.exec(flag);
    if (evidenceMatch) {
      const entry = v.evidence[Number(evidenceMatch[1])];
      if (entry !== undefined && !entry.ok) return { result: "caught", detail: `flagged ${flag}` };
      continue;
    }
    if (flag.startsWith("coherence:")) {
      const name = flag.slice("coherence:".length);
      if (v.coherence.some((c) => c.criterion.includes(name) && !c.ok)) {
        return { result: "caught", detail: `flagged ${flag}` };
      }
    }
  }
  return { result: "missed", detail: `verdict is "${v.verdict}" but none of [${flags.join(", ")}] was flagged` };
}

export interface CanaryDeps {
  arenaDir: string;
  canariesDir: string;
  runsDir: string;
  agentDefinitionPath: string;
  budgetUsd: number;
  /** Injected for offline tests; production default is runJudge. */
  judge?: (ctx: JudgeContext) => Promise<JudgeOutcome>;
}

interface Manifest {
  base_branch?: string;
  /** Deterministic worktree preparation (e.g. "pnpm install") run by the HARNESS in
   *  base and head before judging — dependency setup is not the judge's job. */
  setup?: string;
}

function readManifest(arenaDir: string): Manifest {
  return JSON.parse(readFileSync(join(arenaDir, ".doctrine", "manifest.json"), "utf8")) as Manifest;
}

function appendMetric(arenaDir: string, record: Record<string, unknown>): void {
  const dir = join(arenaDir, ".doctrine");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "metrics.jsonl"), `${JSON.stringify(record)}\n`);
}

export async function runCanary(canaryId: string, deps: CanaryDeps): Promise<CanaryRun> {
  const canaryDir = join(deps.canariesDir, canaryId);
  const unitRes = parseWorkUnit(readFileSync(join(canaryDir, "unit.md"), "utf8"));
  if (!unitRes.ok) {
    return { canaryId, result: "error", detail: `canary unit.md invalid: ${unitRes.errors.join("; ")}` };
  }
  const unit: WorkUnit = unitRes.unit;
  const expect = JSON.parse(readFileSync(join(canaryDir, "expect.json"), "utf8")) as CanaryExpect;

  const manifest = readManifest(deps.arenaDir);
  const baseRef = expect.base ?? manifest.base_branch ?? "development";
  if (!commitExists(deps.arenaDir, baseRef)) {
    return { canaryId, result: "error", detail: `canary base "${baseRef}" is not a commit in the arena` };
  }
  const runDir = join(deps.runsDir, canaryId);
  const sacrifice = prepareSacrifice(deps.arenaDir, join(canaryDir, "patch.diff"), runDir, baseRef);
  try {
    // `setup` comes from the arena's CURRENT manifest, deliberately, while the tree itself is
    // built at the canary's pin. Setup is a property of the toolchain you are running today,
    // not of the fixture: at pin 9e10a34 the manifest carried no `setup` at all, so resolving
    // it from the pinned commit would judge ten fixtures with no `pnpm install` behind them.
    // The pin exists to stop the arena's SOURCE from rotting canaries, not to freeze how a
    // checkout is prepared. The residual risk is real though — a setup command the pinned tree
    // cannot run — so it lands the way an unresolvable pin does: this canary reports `error`,
    // no judge spend is burned on an unbuildable tree, and the sweep walks on to the next one.
    try {
      runSetup(manifest.setup, [sacrifice.baseDir, sacrifice.headDir]);
    } catch (e) {
      return { canaryId, result: "error", detail: `canary setup "${manifest.setup}" failed: ${String(e)}` };
    }
    const { verdictPath, logPath } = judgePaths(runDir);
    const outcome = await (deps.judge ?? runJudge)({
      unit,
      baseDir: sacrifice.baseDir,
      headDir: sacrifice.headDir,
      baseSha: sacrifice.baseSha,
      headSha: sacrifice.headSha,
      diffPath: sacrifice.diffPath,
      verdictPath,
      logPath,
      requiredGates: ["diff-read", "evidence-executed"],
      budgetUsd: deps.budgetUsd,
      agentDefinitionPath: deps.agentDefinitionPath,
    });
    const { result, detail } = evaluateCatch(outcome, expect);
    appendMetric(deps.arenaDir, {
      type: "canary",
      canary_id: canaryId,
      result,
      detail,
      at: new Date().toISOString(),
    });
    return { canaryId, result, detail };
  } finally {
    sacrifice.cleanup();
  }
}

export async function runAllCanaries(deps: CanaryDeps): Promise<{ runs: CanaryRun[]; recall: string }> {
  const ids = readdirSync(deps.canariesDir).filter((d) => existsSync(join(deps.canariesDir, d, "expect.json")));
  const runs: CanaryRun[] = [];
  for (const id of ids.sort()) {
    runs.push(await runCanary(id, deps));
  }
  const caught = runs.filter((r) => r.result === "caught").length;
  const errors = runs.filter((r) => r.result === "error").length;
  const recall = `${caught}/${runs.length}`;
  // Errors stay IN the denominator — 9 errors and 1 catch is not "1/1" — but they are counted
  // separately, so a reader of the trend can tell a collapsed judge from a broken toolchain.
  appendMetric(deps.arenaDir, { type: "canary-recall", recall, errors, at: new Date().toISOString() });
  return { runs, recall };
}
