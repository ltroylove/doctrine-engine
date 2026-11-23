import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitExists, sweepWorktree } from "./canary.js";
import { parseIntent, type Intent } from "./intent.js";
import type { RunAgentFn } from "./judge.js";
import { runPlanJudge, type PlanJudgeOutcome } from "./plan-judge.js";
import { parseWorkUnit, type WorkUnit } from "./work-unit.js";

/**
 * Plan-canaries (a measurement obligation, built 2026-08-24): seed a known
 * plan defect — invented scope, inflation, a rival to a contract, a re-litigated
 * decision, a plausible drive-by — and require the plan-judge to catch it, plus a
 * clean plan it must NOT block. Same law as the code canaries: the judge's recall
 * is a measured number before it gates anything, and it stays measured forever.
 *
 * Cheap by construction: no patches, no setup, no builds — a detached worktree of
 * the arena, the canary's draft units written into work/, one plan-judge run.
 */

export interface PlanCanaryExpect {
  verdict: "pass" | "fail";
  /** Unit ids the verdict must mark ok:false (defect canaries). */
  must_fail?: string[];
  /** Unit ids the verdict must mark ok:true (precision — no collateral damage). */
  must_pass?: string[];
  class?: string;
  note?: string;
  /** The arena commit this canary was authored against (see CanaryExpect.base). */
  base?: string;
}

export type PlanCanaryResult = "caught" | "missed" | "error";

export interface PlanCanaryRun {
  canaryId: string;
  result: PlanCanaryResult;
  detail: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Outcome vs expectation. Exported for offline tests. */
export function evaluatePlanCatch(outcome: PlanJudgeOutcome, expect: PlanCanaryExpect): { result: PlanCanaryResult; detail: string } {
  if (outcome.kind === "failed") {
    return { result: "error", detail: `plan-judge run failed (${outcome.reason}): ${outcome.errors.join("; ")}` };
  }
  const got = outcome.kind; // "pass" | "fail"
  if (got !== expect.verdict) {
    return { result: "missed", detail: `plan-judge said "${got}", canary demands "${expect.verdict}"` };
  }
  const byId = new Map(outcome.verdict.units.map((u) => [u.id, u]));
  for (const id of expect.must_fail ?? []) {
    const u = byId.get(id);
    if (u === undefined || u.ok) {
      return { result: "missed", detail: `verdict is "${got}" but ${id} was not marked not-ok` };
    }
  }
  for (const id of expect.must_pass ?? []) {
    const u = byId.get(id);
    if (u === undefined || !u.ok) {
      return { result: "missed", detail: `collateral damage: faithful unit ${id} was not marked ok` };
    }
  }
  return { result: "caught", detail: "verdict and per-unit flags matched" };
}

export interface PlanCanaryDeps {
  arenaDir: string;
  canariesDir: string;
  runsDir: string;
  agentDefinitionPath: string;
  budgetUsd: number;
  /** Injected for offline tests; production default is the real plan-judge. */
  runAgent?: RunAgentFn;
}

interface Manifest {
  base_branch?: string;
}

function loadCanary(canaryDir: string): { intent: Intent; children: WorkUnit[]; unitTexts: Map<string, string>; expect: PlanCanaryExpect } {
  const intentRes = parseIntent(readFileSync(join(canaryDir, "intent.md"), "utf8"));
  if (!intentRes.ok) throw new Error(`canary intent.md invalid: ${intentRes.errors.join("; ")}`);
  const unitsDir = join(canaryDir, "units");
  const children: WorkUnit[] = [];
  const unitTexts = new Map<string, string>();
  for (const f of readdirSync(unitsDir).filter((f) => f.endsWith(".md")).sort()) {
    const text = readFileSync(join(unitsDir, f), "utf8");
    const parsed = parseWorkUnit(text);
    if (!parsed.ok) throw new Error(`canary ${f} invalid: ${parsed.errors.join("; ")}`);
    children.push(parsed.unit);
    unitTexts.set(`work/${parsed.unit.id}.md`, text);
  }
  const expect = JSON.parse(readFileSync(join(canaryDir, "expect.json"), "utf8")) as PlanCanaryExpect;
  return { intent: intentRes.intent, children, unitTexts, expect };
}

function appendMetric(arenaDir: string, record: Record<string, unknown>): void {
  const dir = join(arenaDir, ".doctrine");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "metrics.jsonl"), `${JSON.stringify(record)}\n`);
}

export async function runPlanCanary(canaryId: string, deps: PlanCanaryDeps): Promise<PlanCanaryRun> {
  let loaded: ReturnType<typeof loadCanary>;
  try {
    loaded = loadCanary(join(deps.canariesDir, canaryId));
  } catch (e) {
    return { canaryId, result: "error", detail: String(e) };
  }

  const manifest = JSON.parse(readFileSync(join(deps.arenaDir, ".doctrine", "manifest.json"), "utf8")) as Manifest;
  const runDir = join(deps.runsDir, canaryId);
  const tree = join(runDir, "tree");
  const baseRef = loaded.expect.base ?? manifest.base_branch ?? "development";
  if (!commitExists(deps.arenaDir, baseRef)) {
    return { canaryId, result: "error", detail: `canary base "${baseRef}" is not a commit in the arena` };
  }

  // Every path under runDir is stable per canary, and the `finally` below never runs if
  // the process is killed mid-flight. Two ways that poisons the next sweep: the tree stays
  // registered and `worktree add` dies at "already exists", and — worse, because it is
  // silent — a `plan-verdict.json` survives. runPlanJudge decides on that file existing, so
  // a judge that exits clean without writing one would be scored on the dead run's verdict:
  // a false catch inflating measured recall. Clear the whole runDir, the way prepareSacrifice
  // does, and never throw doing it: a sweep that throws is one crashed run poisoning all of
  // its successors, the failure this block exists to prevent.
  sweepWorktree(deps.arenaDir, tree);
  try {
    rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* the tree is already deregistered; git speaks up if residue still blocks the add */ }
  // Deleting the directory out from under git can outlive the prune inside sweepWorktree (its
  // own rmSync may have lost to a file lock). Prune again, or the next `worktree add` meets the
  // admin record of a tree that is no longer on disk.
  try { git(deps.arenaDir, ["worktree", "prune"]); } catch { /* best effort */ }
  mkdirSync(runDir, { recursive: true });
  git(deps.arenaDir, ["worktree", "add", "--detach", tree, baseRef]);

  try {
    // Materialize the plan as the decomposer would have left it: draft units in work/.
    mkdirSync(join(tree, "work"), { recursive: true });
    for (const [rel, text] of loaded.unitTexts) {
      writeFileSync(join(tree, rel), text);
    }
    const outcome = await runPlanJudge({
      intent: loaded.intent,
      children: loaded.children,
      unitFiles: [...loaded.unitTexts.keys()],
      arenaDir: tree,
      agentDefinitionPath: deps.agentDefinitionPath,
      budgetUsd: deps.budgetUsd,
      logPath: join(runDir, "plan-judge.log"),
      verdictPath: join(runDir, "plan-verdict.json"),
      ...(deps.runAgent !== undefined ? { runAgent: deps.runAgent } : {}),
    });
    const { result, detail } = evaluatePlanCatch(outcome, loaded.expect);
    appendMetric(deps.arenaDir, {
      type: "plan-canary",
      canary_id: canaryId,
      result,
      detail,
      at: new Date().toISOString(),
    });
    return { canaryId, result, detail };
  } finally {
    sweepWorktree(deps.arenaDir, tree);
  }
}

export async function runAllPlanCanaries(deps: PlanCanaryDeps): Promise<{ runs: PlanCanaryRun[]; recall: string }> {
  const ids = readdirSync(deps.canariesDir).filter((d) => existsSync(join(deps.canariesDir, d, "expect.json")));
  const runs: PlanCanaryRun[] = [];
  for (const id of ids.sort()) {
    runs.push(await runPlanCanary(id, deps));
  }
  const caught = runs.filter((r) => r.result === "caught").length;
  const errors = runs.filter((r) => r.result === "error").length;
  const recall = `${caught}/${runs.length}`;
  appendMetric(deps.arenaDir, { type: "plan-canary-recall", recall, errors, at: new Date().toISOString() });
  return { runs, recall };
}
