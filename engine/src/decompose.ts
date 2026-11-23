import { readFileSync, writeFileSync } from "node:fs";
import { agentLaw, changedFiles, git, revertAll } from "./act.js";
import { readOutstandingFindings } from "./program.js";
import { join } from "node:path";
import { buildClaudeArgv } from "./argv.js";
import { describeTampering, engineStateTampering, restoreEngineState, snapshotEngineState } from "./engine-state.js";
import { engineCommit, stagePaths } from "./git-commit.js";
import { namedBy, type Slice } from "./depends.js";
import type { Intent } from "./intent.js";
import { lintPlan } from "./intent.js";
import type { RunAgentFn } from "./judge.js";
import { runPlanJudge } from "./plan-judge.js";
import { classifySpawn, runAgent as productionRunAgent } from "./spawn.js";
import { parseWorkUnit, type WorkUnit } from "./work-unit.js";

/**
 * The decompose ACT: one budgeted planner run turns a ready intent
 * into draft units; the MECHANICAL plan lint — not a human, not an LLM — promotes
 * draft → ready. A decomposer that touches anything beyond work/*.md and
 * context/contracts.md is reverted wholesale.
 */

export interface DecomposeContext {
  intent: Intent;
  arenaDir: string;
  logPath: string;
  agentDefinitionPath: string;
  /** The plan-judge gate on promotion: mandatory, not a knob. */
  planJudgeAgentPath: string;
  planJudgeBudgetUsd?: number;
  budgetUsd: number;
  /**
   * Every slice that declares coverage — the intents — so both the prompt below and
   * `lintPlan` resolve a unit's `depends_on` through the SAME index. It used to be the set
   * of merged unit ids, which after ADR-0004 named nothing a unit is allowed to depend on:
   * the prompt was telling the decomposer to write edges the lint would then refuse.
   */
  slices: readonly Slice[];
  /** Grade-failure output from a prior intent-grade — the gap-decompose input. */
  gradeFailureLog?: string;
  /**
   * Units of this intent a judge REFUSED to rule on, with its reasons.
   *
   * An escalation is the judge saying the unit cannot be built as specified — which makes
   * it a message to whoever writes specs, and that is this agent. Without it the gap
   * decomposer sees only that some acceptance command failed and re-mints a unit with the
   * same defect in it: the same "a retry is a second attempt at the same attempt" failure
   * the implementer had before `priorFailures`.
   */
  escalatedUnits?: readonly string[];
  /** The plan-judge's objections to this intent's LAST plan — the convergence edge
   *  (added 2026-08-24): a rejected plan reverts wholesale, so without this the
   *  retry re-mints the same plan until the failure halt trips. */
  priorRejection?: string;
  timeoutMs?: number;
  /**
   * The containment deny profile. REQUIRED in production and passed by every dispatch site:
   * without it this ACT holds `Write` with nothing between it and the doors — `.env*`, `data/**`,
   * and on one target a directory of live financial records — and a write into a
   * gitignored door is invisible to the lane check, which reads `git status`. It is also what
   * makes `.doctrine/pause` unwritable to an ACT, which `engine-state.ts` relies on to tell the
   * observer's pause from the ACT's. Missing here until PR #98's review found it.
   */
  settingsPath?: string;
  runAgent?: RunAgentFn;
}

/**
 * How long a decompose ACT gets, derived from its own budget.
 *
 * The important thing is which of the two limits is meant to stop the run. **The budget
 * is the money bound** — the ACT self-limits at `--max-budget-usd` and returns a result
 * message saying what it spent. The timeout is only there to catch a hang, and when it
 * fires instead, two things go wrong at once: productive work is thrown away, and the
 * killed run returns no result message, so real spend is recorded as $0 and the daily
 * gate cannot see it.
 *
 * So the clock must comfortably EXCEED the time it takes to exhaust the budget, not sit
 * at it. Measured on a target, a clean program ACT ran at ~$0.36/min
 * ($8.70 over 24 minutes), so the $10 decompose ceiling is about 28 minutes of work —
 * which is why 30 was still the wrong number, only less wrong than 15. At `budget × 4`
 * a $10 ACT gets 40 minutes and the budget is what stops it, which is the intent.
 *
 * 15 stays the floor (it fit the arena and one target), 45 the ceiling, so a hung run is
 * still caught in under an hour.
 */
export function decomposeTimeoutMs(actBudgetUsd: number): number {
  return Math.min(45, Math.max(15, actBudgetUsd * 4)) * 60_000;
}

/**
 * The criteria a unit of THIS intent may legally wait on: every criterion some slice
 * delivers or renders, less the ones this intent delivers or renders itself.
 *
 * Exported because two callers need the identical list and they are in different files.
 * The decompose prompt states it, and `dispatch` hashes it into the gap-decompose skip
 * signature — that signature's whole claim (PR #85) is that re-asking buys the same answer
 * only when nothing the decomposer is TOLD has moved, so a list that appears in the prompt
 * and not in the hash is a suppression waiting to happen: mint a new intent, and the
 * criteria available to depend on grow while the signature says nothing changed.
 */
export function dependableCriteria(intent: Intent, slices: readonly Slice[]): string[] {
  const own = new Set([...intent.delivers, ...intent.renders]);
  return [...namedBy(slices).keys()].filter((c) => !own.has(c)).sort();
}

export type DecomposeOutcome =
  | { kind: "decomposed"; unitIds: string[]; promoted: number; spendUsd: number }
  | { kind: "empty"; detail: string; spendUsd: number }
  | { kind: "failed"; reason: string; outage: boolean; problems: string[]; spendUsd: number };

export function assembleDecomposerPrompt(ctx: DecomposeContext): string {
  const acceptance = ctx.intent.evidence
    .map((e, i) => `${i}. [${e.kind}] run: ${e.run}\n   expect: ${e.expect}`)
    .join("\n");
  const gap =
    ctx.gradeFailureLog !== undefined
      ? `\n## Gap input — the last intent-grade FAILED; your units must close this:\n${ctx.gradeFailureLog}\n`
      : "";
  const escalated = (ctx.escalatedUnits ?? []).filter((e) => e.trim().length > 0);
  const escalations = escalated.length === 0 ? "" : `
## Units a judge REFUSED to rule on — their SPECS are the defect, not the code

The judge did not fail these units; it declined to judge them, because it found the unit
itself unbuildable as written. Its reasoning is below. A replacement must fix what it
names — re-minting a unit that carries the same defect will escalate again, at full price.

${escalated.map((e, i) => `${i + 1}. ${e}`).join("\n\n")}
`;
  // Deferred findings reach the UNIT planner too, not only the program rung. A target
  // configured without `manifest.program` — hand-written intents, which is how a PR-review
  // target runs — never invokes the program decomposer at all, so feeding them only there
  // left exactly those targets with a directory nobody reads, which is the bug being fixed.
  const owed = readOutstandingFindings(ctx.arenaDir);
  const maintenance = owed.length === 0 ? "" : `
## Defects already recorded against this code

Findings the loop merged past rather than fixed. Where a unit you are planning touches the code
one of these names, its evidence should cover the corrected behaviour — that is how the defect
gets paid off, as part of work that was going to happen anyway. Do not add units whose only
purpose is these, and do not widen the intent to reach them.

${owed}
`;
  const rejection =
    ctx.priorRejection !== undefined
      ? `\n## Prior plan REJECTED — the plan-judge refused this intent's last plan for the reasons below. Address every objection; do not resubmit the rejected unit(s):\n${ctx.priorRejection}\n`
      : "";
  return `${agentLaw(ctx.agentDefinitionPath)}

---

# Your intent

id: ${ctx.intent.id}
title: ${ctx.intent.title}
budget_usd: ${ctx.intent.budgetUsd}
tier_default: ${ctx.intent.tier}

## Brief
${ctx.intent.body}

## Acceptance evidence (the engine runs these after your units merge)
${acceptance}
${gap}${escalations}${maintenance}${rejection}
Criteria you may depend on: ${dependableCriteria(ctx.intent, ctx.slices).join(", ") || "(none)"}

Write the next slice of work/<unit-id>.md drafts (and contracts.md additions if
needed) in the repository you are in. Nothing else.`;
}

const ALLOWED_TOUCH = /^(work\/[^/]+\.md|context\/contracts\.md)$/;

export async function runDecompose(ctx: DecomposeContext): Promise<DecomposeOutcome> {
  const invoke = ctx.runAgent ?? productionRunAgent;
  // Taken BEFORE the ACT runs: the only question is what the ACT changed, and the
  // engine's own scheduler writes are legitimately uncommitted between ticks.
  const stateBefore = snapshotEngineState(ctx.arenaDir);
  const spawned = await invoke(assembleDecomposerPrompt(ctx), {
    argv: buildClaudeArgv({
      maxBudgetUsd: ctx.budgetUsd,
      allowedTools: ["Read", "Grep", "Glob", "Write"],
      permissionMode: "dontAsk",
      ...(ctx.settingsPath !== undefined ? { settingsPath: ctx.settingsPath } : {}),
    }),
    cwd: ctx.arenaDir,
    // Scaled with the intent, exactly as the budget above it is, and for the same
    // reason: a flat default sized on the arena truncates on a real one. The program
    // rung learned this first and had to go from 15 to 30 — "a killed run never returns
    // a result message to bill from", so the money is spent and the ledger records $0,
    // which also means the daily spend gate cannot see it. This rung then hit it on
    // one target's walking-skeleton intent: 17 minutes in, a 684KB transcript of real
    // work, killed at the flat 15. A big intent is a bigger plan, and 30 is the number
    // the sibling rung proved.
    timeoutMs: ctx.timeoutMs ?? decomposeTimeoutMs(ctx.budgetUsd),
    logPath: ctx.logPath,
  });

  const actSpend = spawned.resultMessage?.total_cost_usd ?? 0;

  // Engine-owned state, before anything else looks at the run. This rung skips
  // `.doctrine/` when deciding what the ACT touched and when reverting — it treats that
  // tree as runtime state an ACT could not have caused — so an edit there would survive
  // a run that returned empty or failed. An `intents-settled.json` pre-set to the
  // current HEAD marks other intents as already answered, and they are simply never
  // asked again: no rejected diff, nothing to see (doctrine#24 review).
  const tampered = engineStateTampering(ctx.arenaDir, stateBefore);
  if (tampered.length > 0) {
    restoreEngineState(ctx.arenaDir, stateBefore);
    revertAll(ctx.arenaDir);
    return {
      kind: "failed",
      reason: "the ACT modified engine-owned state",
      outage: false,
      problems: describeTampering(tampered),
      spendUsd: actSpend,
    };
  }
  const spawnFailure = classifySpawn(spawned);
  if (spawnFailure !== null) {
    revertAll(ctx.arenaDir);
    return { kind: "failed", reason: spawnFailure, outage: spawned.outage, problems: [], spendUsd: actSpend };
  }

  const { allowed, forbidden } = changedFiles(ctx.arenaDir, ALLOWED_TOUCH);
  if (forbidden.length > 0) {
    revertAll(ctx.arenaDir);
    return {
      kind: "failed",
      reason: "decomposer touched files outside work/ and contracts.md — reverted wholesale",
      outage: false,
      problems: forbidden,
      spendUsd: actSpend,
    };
  }
  const unitFiles = allowed.filter((f) => f.startsWith("work/"));
  if (unitFiles.length === 0) {
    return { kind: "empty", detail: "decomposer wrote no units — an honest empty plan", spendUsd: actSpend };
  }

  // Parse + lint the plan.
  const children: WorkUnit[] = [];
  const problems: string[] = [];
  for (const f of unitFiles) {
    const parsed = parseWorkUnit(readFileSync(join(ctx.arenaDir, f), "utf8"));
    if (!parsed.ok) {
      problems.push(`${f}: ${parsed.errors.join("; ")}`);
      continue;
    }
    if (parsed.unit.status !== "draft") {
      problems.push(`${f}: decomposer must write drafts, found status "${parsed.unit.status}"`);
      continue;
    }
    children.push(parsed.unit);
  }
  const lint = children.length > 0 ? lintPlan(ctx.intent, children, ctx.slices) : { ok: false, problems: ["no parseable units"], flags: [] };
  if (problems.length > 0 || !lint.ok) {
    revertAll(ctx.arenaDir);
    return { kind: "failed", reason: "plan lint failed", outage: false, problems: [...problems, ...lint.problems], spendUsd: actSpend };
  }

  // Plan-fidelity gate: lint checked shape; the plan-judge
  // checks MEANING — every unit traces to cited intent text, no invented scope,
  // no rival to an existing contract. The last unreviewed artifact class, closed.
  const pjRunDir = join(ctx.arenaDir, ".doctrine", "runs", `plan-${ctx.intent.id}-${Date.now()}`);
  const pj = await runPlanJudge({
    intent: ctx.intent,
    children,
    unitFiles,
    arenaDir: ctx.arenaDir,
    agentDefinitionPath: ctx.planJudgeAgentPath,
    budgetUsd: ctx.planJudgeBudgetUsd ?? 5,
    logPath: join(pjRunDir, "plan-judge.log"),
    verdictPath: join(pjRunDir, "plan-verdict.json"),
    ...(ctx.runAgent !== undefined ? { runAgent: ctx.runAgent } : {}),
  });
  if (pj.kind === "failed") {
    revertAll(ctx.arenaDir);
    return { kind: "failed", reason: `plan-judge ${pj.reason}`, outage: pj.outage, problems: pj.errors, spendUsd: actSpend + pj.spendUsd };
  }
  if (pj.kind === "fail") {
    revertAll(ctx.arenaDir);
    return { kind: "failed", reason: "plan-judge rejected the plan", outage: false, problems: pj.problems, spendUsd: actSpend + pj.spendUsd };
  }

  // Mechanical promotion: draft -> ready, plus intent ready -> decomposed, one commit.
  for (const f of unitFiles) {
    const path = join(ctx.arenaDir, f);
    writeFileSync(path, readFileSync(path, "utf8").replace(/^status:\s*draft/m, "status: ready"));
  }
  const intentPath = join(ctx.arenaDir, "work", "intents", `${ctx.intent.id}.md`);
  try {
    writeFileSync(intentPath, readFileSync(intentPath, "utf8").replace(/^status:\s*ready/m, "status: decomposed"));
  } catch { /* intent file may live elsewhere in tests; the commit below still records the plan */ }
  stagePaths(ctx.arenaDir, ["work", join("context", "contracts.md")]);
  engineCommit(ctx.arenaDir, `doctrine: decompose ${ctx.intent.id} (+${children.length} units, lint-promoted)`);

  return { kind: "decomposed", unitIds: children.map((u) => u.id), promoted: children.length, spendUsd: actSpend + pj.spendUsd };
}
