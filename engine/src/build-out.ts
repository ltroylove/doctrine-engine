import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentLaw, changedFiles, revertAll } from "./act.js";
import { buildClaudeArgv } from "./argv.js";
import { lintContractAdditions } from "./contracts.js";
import { describeTampering, engineStateTampering, restoreEngineState, snapshotEngineState } from "./engine-state.js";
import { engineCommit, stagePaths } from "./git-commit.js";
import type { RunAgentFn } from "./judge.js";
import { classifySpawn, runAgent as productionRunAgent } from "./spawn.js";
import { narrowingDirRel } from "./narrowing-store.js";
import { lintBuildOut, type WorkUnit } from "./work-unit.js";

/**
 * The **build-out ACT** (ADR-0001): one budgeted run turns ONE scaffolded unit into a
 * ready one, by reading the tree as it then is and appending its spec below the scaffold.
 *
 * This is the rung that replaces decompose, and the difference is not cosmetic. The
 * decomposer was handed an intent and invented a whole plan of units; build-out is handed
 * a unit that already exists — minted with its epic, carrying what it delivers and why —
 * and may only write the half that was deliberately left blank. **Everything above the
 * line was settled before it ran, and `lintBuildOut` is what makes that true rather than
 * merely instructed.**
 *
 * **The lane is one file, not a directory.** The decompose rung's law allows any
 * `work/*.md`, because it is minting a set. A build-out ACT that writes a second unit is
 * doing the thing the scaffold rung exists to stop: planning at build time, against the
 * tree it happens to be looking at, with no coverage arithmetic anywhere near it. So the
 * lane is `work/<this unit>.md` plus `contracts.md`, and anything else is reverted
 * wholesale.
 *
 * **`contracts.md` is in the lane on purpose, and it is the larger exposure ADR-0001
 * names.** `plan-judge` loses its subject with the decompose rung, and its surviving
 * clause — mint no rival to a contract that already exists — lands on this ACT, which is
 * both the writer of contract additions and the fresh planner most able to duplicate one.
 * That check is `lintContractAdditions`, run below on what the ACT added to the file.
 */

export interface BuildOutContext {
  /** The scaffolded unit, exactly as committed. Its `id` names the one file in the lane. */
  unit: WorkUnit;
  arenaDir: string;
  logPath: string;
  agentDefinitionPath: string;
  budgetUsd: number;
  /** Repo-relative path of the unit file. Derived by the caller, which knows the store. */
  unitPath: string;
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

export type BuildOutOutcome =
  | { kind: "built"; unitId: string; spendUsd: number }
  | { kind: "failed"; reason: string; outage: boolean; problems: string[]; spendUsd: number };

/**
 * How long a build-out gets, derived from its own budget — the same rule, and the same
 * reason, as `decomposeTimeoutMs`. **The budget is the money bound**; the timeout only
 * catches a hang, and when it fires instead, productive work is thrown away AND the killed
 * run returns no result message, so real spend is recorded as $0 and the daily gate cannot
 * see it. So the clock must comfortably exceed the time it takes to exhaust the budget.
 *
 * The ceiling is 60 rather than decompose's 45 because a unit is now a much larger thing:
 * ADR-0001 projects ~8–12 code files and $35–40 per attempt, against a median of 2 code
 * files today. That projection is explicitly NOT a measurement, and this number is one of
 * the ones the ADR says must be re-derived from the first post-cutover epic before it is
 * trusted.
 */
export function buildOutTimeoutMs(actBudgetUsd: number): number {
  return Math.min(60, Math.max(15, actBudgetUsd * 4)) * 60_000;
}

/**
 * Where this unit's epic lives, from its `parent` (`<epic id>#<n.m>`).
 *
 * **The epic is the only place the ARCH bindings are written** — "What binds it" — and before
 * this, nothing downstream of the epic ACT ever read it: build-out was handed the unit's
 * scaffold and nothing else, and the implementer the unit's body. So a binding the epic named
 * reached no stage that builds anything (PR #97 review). Pointing build-out at its epic is what
 * makes that section an input rather than a note.
 */
export function epicPathOf(unit: WorkUnit): { epicPath: string; feature: string } | null {
  if (unit.parent === undefined || !unit.parent.includes("#")) return null;
  const epicId = unit.parent.slice(0, unit.parent.indexOf("#"));
  return { epicPath: `${narrowingDirRel("epic")}/${epicId}.md`, feature: unit.parent };
}

export function assembleBuildOutPrompt(ctx: BuildOutContext): string {
  const scaffold = readFileSync(join(ctx.arenaDir, ctx.unitPath), "utf8");
  const epic = epicPathOf(ctx.unit);
  const BT = String.fromCharCode(96);
  const epicSection = epic === null ? "" : [
    "",
    "## Your epic, and what binds you",
    "",
    "This unit hangs off feature " + BT + epic.feature + BT + " of the epic at " + BT + epic.epicPath + BT + ". Read",
    "that feature's heading and the epic's **What binds it** before you write a word of spec.",
    "The ARCH sections it points at bind this unit exactly as they bind the epic, and anything",
    "they require for THIS unit's criteria to work — a table, a registration, a module — is",
    "yours to build and to probe, whether or not a criterion names it. Nothing else downstream",
    "reads the epic, so if you do not carry a binding into your spec, no one will.",
    "",
  ].join(String.fromCharCode(10));
  return `${agentLaw(ctx.agentDefinitionPath)}

---

# Your unit

It is at \`${ctx.unitPath}\` and this is exactly what it says today:

${scaffold}

${epicSection}Append your spec BELOW what is already there, and change nothing above it. Everything the
scaffold declares — \`delivers\`, \`renders\`, \`depends_on\`, the title, the budget, and the
\`## Intent\` section — was settled when this unit was minted with its epic, against the
whole program. You are looking at one slice of a tree; you are not in a position to widen
what it covers, and a build-out that does is refused and reverted wholesale.

What to add:

  - \`evidence:\` in the frontmatter — the machine-checkable probes a judge will EXECUTE
    against your diff. Written now, against the tree as it actually is, which is the whole
    reason this is not written at scaffold time.
  - the spec prose, below the \`## Intent\` section.
  - \`status: draft\`. The engine promotes it once the gate passes; do not write \`ready\`.

You may write \`${ctx.unitPath}\` and \`context/contracts.md\`. Nothing else.`;
}

export async function runBuildOut(ctx: BuildOutContext): Promise<BuildOutOutcome> {
  const invoke = ctx.runAgent ?? productionRunAgent;
  const scaffoldText = readFileSync(join(ctx.arenaDir, ctx.unitPath), "utf8");
  // Read BEFORE the run, for the same reason the scaffold is: the only question is what
  // this ACT changed, and the file is legitimately edited by other rungs between ticks.
  const contractsRel = "context/contracts.md";
  const contractsBefore = existsSync(join(ctx.arenaDir, contractsRel))
    ? readFileSync(join(ctx.arenaDir, contractsRel), "utf8")
    : "";
  // Taken BEFORE the ACT runs: the only question is what the ACT changed, and the engine's
  // own scheduler writes are legitimately uncommitted between ticks.
  const stateBefore = snapshotEngineState(ctx.arenaDir);
  const spawned = await invoke(assembleBuildOutPrompt(ctx), {
    argv: buildClaudeArgv({
      maxBudgetUsd: ctx.budgetUsd,
      allowedTools: ["Read", "Grep", "Glob", "Write"],
      permissionMode: "dontAsk",
      ...(ctx.settingsPath !== undefined ? { settingsPath: ctx.settingsPath } : {}),
    }),
    cwd: ctx.arenaDir,
    timeoutMs: ctx.timeoutMs ?? buildOutTimeoutMs(ctx.budgetUsd),
    logPath: ctx.logPath,
  });

  const actSpend = spawned.resultMessage?.total_cost_usd ?? 0;

  // Engine-owned state first, before anything else looks at the run: this rung skips
  // `.doctrine/` both when deciding what the ACT touched and when reverting, so an edit
  // there would otherwise survive a run that failed.
  const tampered = engineStateTampering(ctx.arenaDir, stateBefore);
  if (tampered.length > 0) {
    restoreEngineState(ctx.arenaDir, stateBefore);
    revertAll(ctx.arenaDir);
    return { kind: "failed", reason: "the ACT modified engine-owned state", outage: false, problems: describeTampering(tampered), spendUsd: actSpend };
  }
  const spawnFailure = classifySpawn(spawned);
  if (spawnFailure !== null) {
    revertAll(ctx.arenaDir);
    return { kind: "failed", reason: spawnFailure, outage: spawned.outage, problems: [], spendUsd: actSpend };
  }

  // The lane: this unit's file and contracts.md. Built from the unit's own path rather
  // than from a directory pattern, which is what makes "exactly one unit" mechanical
  // instead of instructed.
  const lane = new RegExp(`^(${ctx.unitPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|context/contracts\\.md)$`);
  const { allowed, forbidden } = changedFiles(ctx.arenaDir, lane);
  if (forbidden.length > 0) {
    revertAll(ctx.arenaDir);
    return {
      kind: "failed",
      reason: `build-out touched files outside ${ctx.unitPath} and contracts.md — reverted wholesale`,
      outage: false,
      problems: forbidden,
      spendUsd: actSpend,
    };
  }
  if (!allowed.includes(ctx.unitPath)) {
    // A failure rather than an honest empty answer, and the asymmetry with the decompose
    // rung is deliberate. "Nothing to slice" is a real thing for a planner to say; "this
    // unit needs no spec" is not, because the unit already exists and was scaffolded
    // precisely because somebody decided it had to be built.
    revertAll(ctx.arenaDir);
    return { kind: "failed", reason: "build-out wrote no spec — the unit is unchanged", outage: false, problems: [], spendUsd: actSpend };
  }

  const lint = lintBuildOut(scaffoldText, readFileSync(join(ctx.arenaDir, ctx.unitPath), "utf8"), ctx.unit.id);
  if (!lint.ok) {
    revertAll(ctx.arenaDir);
    return { kind: "failed", reason: "the build-out broke the append contract", outage: false, problems: lint.problems, spendUsd: actSpend };
  }

  // **`plan-judge`'s surviving clause, mechanized** (ADR-0001). The judge that asked
  // "mint no rival to an existing contract" dies with the decompose rung; the exposure
  // lands here, on the ACT that both writes contract additions and is least placed to
  // notice a collision. See `contracts.ts` for what this covers and what it does not.
  const contractProblems = lintContractAdditions(
    contractsBefore,
    existsSync(join(ctx.arenaDir, contractsRel)) ? readFileSync(join(ctx.arenaDir, contractsRel), "utf8") : "",
  );
  if (contractProblems.length > 0) {
    revertAll(ctx.arenaDir);
    return { kind: "failed", reason: "the build-out broke the contract file's append-only rule", outage: false, problems: contractProblems, spendUsd: actSpend };
  }

  // Mechanical promotion, the engine's and not the ACT's: draft -> ready, one commit.
  const path = join(ctx.arenaDir, ctx.unitPath);
  writeFileSync(path, readFileSync(path, "utf8").replace(/^status:\s*draft/m, "status: ready"));
  stagePaths(ctx.arenaDir, [ctx.unitPath, join("context", "contracts.md")]);
  engineCommit(ctx.arenaDir, `doctrine: build out ${ctx.unit.id} (spec appended, lint-promoted)`);
  return { kind: "built", unitId: ctx.unit.id, spendUsd: actSpend };
}
