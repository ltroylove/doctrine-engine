import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runDesignJudge, type DesignBlock, type DesignJudgeOutcome } from "./design-judge.js";
import { appendFileSync } from "node:fs";
import { metricsPath } from "./ledger.js";
import { prepareSacrifice } from "./canary.js";
import { runSetup } from "./setup.js";

/**
 * Design canaries: the design-judge gets a measured recall before it gates
 * anything, the same law the code-judge and the plan-judge already run under.
 *
 * A design canary is one seeded defect that **passes the conformance gate** — the
 * generator refuses any that does not, because anything the gate already catches needs
 * no judge, and a canary that measures the gate tells you nothing about the judge.
 *
 * One of them is a control: a real, harmless improvement the judge must PASS. Recall
 * without it is half a measurement — a judge that fails everything scores 100% and is
 * useless, and that failure mode is the likelier one here, because "this could be
 * better" is always available to say about a screen.
 */

export interface DesignCanaryExpect {
  verdict: "pass" | "fail";
  /**
   * Phrasings that count as having named the seeded defect. Absent on the control.
   *
   * A list, not a string, because the first calibration scored three catches as misses
   * on vocabulary alone: the judge said `wall-of-equal-weight-cards` for
   * `equal-weight-wall`, `radius-inconsistent` for `inconsistent-state`, and
   * `placeholder-content` for `placeholder-tone` — each describing the exact seeded
   * defect in the exact right place. Demanding one spelling measures the fixture
   * author's vocabulary, not the judge's sight.
   */
  must_flag?: string | string[];
  /** The arena commit this fixture was authored against. */
  base: string;
  why?: string;
}

export interface DesignCanaryRun {
  canaryId: string;
  result: "caught" | "missed" | "false-positive" | "error";
  detail: string;
  spendUsd: number;
}

export interface DesignCanaryDeps {
  arenaDir: string;
  canariesDir: string;
  runsDir: string;
  agentDefinitionPath: string;
  design: DesignBlock;
  setup?: string;
  budgetUsd: number;
  /** Injected for tests; production runs the real judge. */
  judge?: (ctx: Parameters<typeof runDesignJudge>[0]) => Promise<DesignJudgeOutcome>;
}

/**
 * Did the judge catch what was seeded, and did it leave the control alone?
 *
 * `must_flag` is matched against the rule AND the region of every failing finding, not
 * only the rule: a judge that describes the defect exactly but files it under a
 * different rule name has seen it, and scoring that a miss would be measuring
 * vocabulary rather than sight.
 */
export function evaluateDesignCatch(outcome: DesignJudgeOutcome, expect: DesignCanaryExpect): { result: DesignCanaryRun["result"]; detail: string } {
  if (outcome.kind === "failed") {
    return { result: "error", detail: `design-judge ${outcome.reason}: ${outcome.errors.join("; ").slice(0, 200)}` };
  }
  const v = outcome.verdict;
  const failing = v.findings.filter((f) => !f.ok);

  if (expect.verdict === "pass") {
    return v.verdict === "pass"
      ? { result: "caught", detail: "control passed, as it must" }
      : { result: "false-positive", detail: `control was failed: ${failing.map((f) => f.rule || f.region).join("; ").slice(0, 200)}` };
  }

  if (v.verdict !== "fail") {
    return { result: "missed", detail: "seeded defect passed" };
  }
  if (expect.must_flag === undefined) {
    return { result: "caught", detail: "failed as expected" };
  }
  const alternates = (Array.isArray(expect.must_flag) ? expect.must_flag : [expect.must_flag]).map((a) => a.toLowerCase());
  // A hyphen and a space are the same word boundary here. The judge writes rule names as
  // prose as often as slugs ("ban-list: inconsistent state"), and dc-07 scored a miss on
  // 2026-10-18 for a finding that named the seeded radii in the right place.
  const words = (x: string): string => x.toLowerCase().replace(/[-_\s]+/g, " ");
  const hit = failing.some((f) => {
    const text = words(`${f.rule} ${f.region} ${f.observed}`);
    return alternates.some((a) => text.includes(words(a)));
  });
  return hit
    ? { result: "caught", detail: `flagged ${alternates[0]}` }
    : { result: "missed", detail: `failed, but never named ${alternates.join(" / ")}: ${failing.map((f) => f.rule).join(", ").slice(0, 160)}` };
}

export async function runDesignCanary(canaryId: string, deps: DesignCanaryDeps): Promise<DesignCanaryRun> {
  const canaryDir = join(deps.canariesDir, canaryId);
  const expect = JSON.parse(readFileSync(join(canaryDir, "expect.json"), "utf8")) as DesignCanaryExpect;
  const runDir = join(deps.runsDir, canaryId);
  mkdirSync(runDir, { recursive: true });

  const sacrifice = prepareSacrifice(deps.arenaDir, join(canaryDir, "patch.diff"), runDir, expect.base);
  try {
    try {
      runSetup(deps.setup, [sacrifice.baseDir, sacrifice.headDir]);
    } catch (e) {
      return { canaryId, result: "error", detail: `setup failed: ${String(e).slice(0, 200)}`, spendUsd: 0 };
    }
    const outcome = await (deps.judge ?? runDesignJudge)({
      headDir: sacrifice.headDir,
      baseDir: sacrifice.baseDir,
      // A canary always patches an arena that already renders, so there is always a
      // baseline. The bootstrap path is a target's first UI unit, not a seeded defect.
      baselineEmpty: false,
      design: deps.design,
      verdictPath: join(runDir, "design-verdict.json"),
      logPath: join(runDir, "design-judge.log"),
      budgetUsd: deps.budgetUsd,
      agentDefinitionPath: deps.agentDefinitionPath,
    });
    const { result, detail } = evaluateDesignCatch(outcome, expect);
    const spendUsd = outcome.kind === "judged" ? outcome.spendUsd : outcome.spendUsd;
    const row = { type: "design-canary", canary_id: canaryId, result, detail, spend_usd: spendUsd, at: new Date().toISOString() };
    appendFileSync(metricsPath(deps.arenaDir), `${JSON.stringify(row)}\n`);
    return { canaryId, result, detail, spendUsd };
  } finally {
    sacrifice.cleanup();
  }
}

export async function runAllDesignCanaries(deps: DesignCanaryDeps): Promise<{ runs: DesignCanaryRun[]; recall: string }> {
  const ids = readdirSync(deps.canariesDir)
    .filter((d) => existsSync(join(deps.canariesDir, d, "expect.json")))
    .sort();
  const runs: DesignCanaryRun[] = [];
  for (const id of ids) runs.push(await runDesignCanary(id, deps));

  // Recall counts seeded defects only; the control is reported but never inflates it.
  const seeded = runs.filter((r) => {
    const e = JSON.parse(readFileSync(join(deps.canariesDir, r.canaryId, "expect.json"), "utf8")) as DesignCanaryExpect;
    return e.verdict === "fail";
  });
  const caught = seeded.filter((r) => r.result === "caught").length;
  return { runs, recall: `${caught}/${seeded.length}` };
}
