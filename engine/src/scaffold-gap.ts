import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentLaw } from "./act.js";
import { buildClaudeArgv } from "./argv.js";
import type { CriteriaParse } from "./coverage.js";
import type { Dependent } from "./depends.js";
import type { Feature } from "./feature.js";
import { engineCommit, stagePaths } from "./git-commit.js";
import { isolatedCwd, type RunAgentFn } from "./judge.js";
import type { EvidenceSpec } from "./envelope.js";
import type { Narrowing } from "./narrowing.js";
import { readScaffolds, scaffoldFindings, writeScaffolds } from "./narrowing-act.js";
import { repoTouchedBy, revertRepo } from "./narrowing-store.js";
import { deniedTools } from "./result.js";
import { classifySpawn, runAgent as productionRunAgent } from "./spawn.js";
import type { WorkUnit } from "./work-unit.js";

/**
 * **The ratchet** (ADR-0003): a feature whose acceptance FAILED gets more units.
 *
 * *Plans are cheap; reality decides coverage.* The engine has just run this feature's
 * end-to-end checks with no LLM, against every unit under it merged, and they did not
 * pass. That is a fact about the product, not an opinion about the plan — so the answer
 * is not to re-judge the plan but to buy the next slice of work, with the failure output
 * in hand.
 *
 * **This is the intent-grade's gap decompose, one rung up, and it is deliberately the same
 * machinery rather than a sibling of it.** What it mints is a scaffold, checked by the
 * same `scaffoldFindings` the epic ACT is checked by, with `scope` narrowed from the whole
 * epic to this one feature. A gap path with a lint of its own is how a rule comes to be
 * applied at one level and not its sibling — and this repo has paid for that four times.
 *
 * **What it may NOT do is change the plan above it.** The epic, its feature headings and
 * the units that already merged are settled; this writes new unit files and nothing else.
 * A gap mint that could edit its own feature's `Delivers` would be a slice rewriting the
 * requirement it failed to meet, which is the ratchet running backwards.
 */

export interface ScaffoldGapContext {
  arenaDir: string;
  /** The epic holding the feature. Read-only here — its boundaries are settled. */
  epic: Narrowing;
  /** The feature whose grade failed, or, with `epicFailure`, the feature the gap units go under. */
  feature: Feature;
  /**
   * Present when it was the EPIC's acceptance that failed, after every feature under it
   * passed. The units still go under `feature` (the epic's last, by position), but the prompt
   * must say what actually failed. Told "feature X is not finished" about a feature whose own
   * checks passed, the planner can honestly answer that there is nothing to add, and that
   * empty answer retires the ratchet for this epic for good.
   */
  epicFailure?: { evidence: readonly EvidenceSpec[] };
  /** The PRD's criteria, for the scaffold arithmetic. */
  criteria: CriteriaParse;
  /**
   * EVERY unit in the repo, whatever its state.
   *
   * Two readers, exactly as at the epic rung: an id is taken the moment a file holds it,
   * and an edge on a criterion another slice delivers is one that can clear.
   */
  existingUnits: readonly WorkUnit[];
  /** What a new unit's `depends_on` can resolve against — `dependableSlices`, the one definition. */
  dependable?: readonly Dependent[];
  /** What the feature's acceptance printed when it failed. The whole reason this runs. */
  failureLog: string;
  logPath: string;
  agentDefinitionPath: string;
  budgetUsd: number;
  settingsPath?: string;
  timeoutMs?: number;
  runAgent?: RunAgentFn;
}

export type ScaffoldGapOutcome =
  | { kind: "scaffolded"; ids: string[]; spendUsd: number }
  /**
   * The planner honestly had nothing to add. A real answer, and the caller must record it
   * — an intent blocked on something outside itself re-bought this 16 times for $31.33
   * before the signature key existed.
   */
  | { kind: "empty"; detail: string; spendUsd: number }
  | { kind: "rejected"; problems: string[]; spendUsd: number }
  | { kind: "failed"; reason: string; outage: boolean; problems: string[]; spendUsd: number };

export function assembleScaffoldGapPrompt(ctx: ScaffoldGapContext, outDir: string): string {
  const mine = ctx.existingUnits.filter((u) => u.parent === ctx.feature.id);
  const others = ctx.existingUnits.filter((u) => u.parent !== ctx.feature.id);
  const happened = ctx.epicFailure === undefined
    ? `Feature \`${ctx.feature.id}\` — ${ctx.feature.title} — has had every unit under it built and
merged, and the engine then ran its acceptance. **It failed.** Nobody is disputing the work
that landed; what is established is that the feature is not finished.

Your job is to write the units that finish it, and nothing else.`
    : `Epic \`${ctx.epic.id}\` — ${ctx.epic.title} — has had every feature under it pass its own
acceptance, and the engine then ran **the epic's end-to-end acceptance. It failed.** The features
work one at a time; what is established is that the epic as a whole is not finished.

The epic's acceptance is:

${ctx.epicFailure.evidence.map((e) => `- \`${e.run}\` — ${e.expect}`).join("\n")}

Your job is to write the units that make THAT pass, and nothing else. A common cause is that no
unit was ever given the end-to-end test the acceptance runs ("No test files found"): then the
missing unit is the one that writes it, against what the merged units already built. The new
units go under feature \`${ctx.feature.id}\`, the epic's last, because a unit needs one feature
parent; they may draw on everything the epic's features built.`;
  return `${agentLaw(ctx.agentDefinitionPath)}

---

# What happened

${happened}

## What the acceptance printed

${ctx.failureLog.slice(0, 6000)}

## What this feature is for

It delivers: ${ctx.feature.delivers.join(", ") || "(none)"}
It renders: ${ctx.feature.renders.join(", ") || "(none)"}

It is a heading inside \`${join(ctx.arenaDir, ctx.epic.path)}\`. Read that epic for the
requirement text; read the repository for what the merged units actually built.

## What is already under it

${mine.length > 0 ? mine.map((u) => `- ${u.id} [${u.status}] ${u.title} — delivers ${u.delivers.join(", ") || "(none)"}`).join("\n") : "(none)"}

Do not re-mint any of these and do not re-do their work. They landed and were judged. The
question is what is MISSING, which the failure output above is the evidence for.

## Ids that are taken elsewhere

${others.length > 0 ? others.map((u) => u.id).join(", ") : "(none)"}

# What to write

One file per new unit, into \`${join(outDir, GAP_OUT_DIR)}\`, named \`<unit id>.md\`. Each is a
SCAFFOLD — what and why, never how:

\`\`\`
---
id: wu-close-rounding
title: Rounding on close
tier: reversible
budget_usd: 12
status: scaffold
parent: ${ctx.feature.id}
delivers: [${ctx.feature.delivers[0] ?? "C1.1"}]
renders: []
depends_on: []
---
## Intent

Why this unit exists, in the terms of the thing being built — not a plan for building it.
\`\`\`

Rules the engine enforces rather than requests:

  - **\`parent\` is \`${ctx.feature.id}\`**, on every unit. This rung mints under one feature.
  - **No \`evidence:\` and no spec.** Both are written later, against the tree as it then
    is, by the ACT that builds each unit out. A scaffold carrying evidence is refused.
  - **You may only claim what this feature delivers or renders**, and \`depends_on\` names
    criteria, never a document id.

**Your tools are \`Read\`, \`Grep\`, \`Glob\`, \`Write\` and \`Edit\`, and nothing else.** Write and
edit only in the directory named above — anything written into the repository fails the run.

${ctx.epicFailure === undefined
    ? `If the honest answer is that nothing more can be sliced here — the failure is in something
this feature does not own — write nothing at all and say so. That is a real answer and it
is recorded as one.`
    : `Every feature of epic \`${ctx.epic.id}\` is yours to draw on: a failure that spans them is not
"owned by something else". Write nothing only if the epic's acceptance itself is wrong — it
checks what the epic never promised, or it is broken as a command — and say so. That answer
is recorded against this failure and not asked again, so do not give it for missing work.`}
`;
}

/**
 * Where this ACT writes, inside its scratch directory. NOT `work/`: this ACT runs under
 * `REVIEW_FIX_DENY`, whose `Write(work/)` rules are relative and resolve against the ACT's own
 * working directory, which is the scratch directory. So `scratch/work/` was the one place the
 * ACT was told to write and the one place it was forbidden to: every mint was refused, read
 * as "nothing to add", and recorded as an answer (seven correct diagnoses lost
 * on one target). A name no deny rule uses, checked by a test against every rule.
 */
export const GAP_OUT_DIR = "doctrine-gap-out";

export async function runScaffoldGap(ctx: ScaffoldGapContext): Promise<ScaffoldGapOutcome> {
  const invoke = ctx.runAgent ?? productionRunAgent;
  const scratch = isolatedCwd("scaffold-gap");
  try {
    mkdirSync(join(scratch, GAP_OUT_DIR), { recursive: true });
    const spawned = await invoke(assembleScaffoldGapPrompt(ctx, scratch), {
      argv: buildClaudeArgv({
        maxBudgetUsd: ctx.budgetUsd,
        allowedTools: ["Read", "Grep", "Glob", "Write", "Edit"],
        addDirs: [ctx.arenaDir],
        permissionMode: "dontAsk",
        ...(ctx.settingsPath !== undefined ? { settingsPath: ctx.settingsPath } : {}),
      }),
      cwd: scratch,
      timeoutMs: ctx.timeoutMs ?? 20 * 60_000,
      logPath: ctx.logPath,
    });
    const spendUsd = spawned.resultMessage?.total_cost_usd ?? 0;

    // The containment tripwire, for the same reason the narrowing rung has one: `Write`
    // takes an absolute path, so an ACT pointed at scratch can still reach into the repo,
    // and a silent reach is worse than a loud one.
    const touched = repoTouchedBy(ctx.arenaDir);
    if (touched.length > 0) {
      revertRepo(ctx.arenaDir, touched);
      return {
        kind: "failed",
        reason: "the ACT wrote into the repository instead of its scratch directory",
        outage: false,
        problems: touched.map((f) => `wrote ${f}`),
        spendUsd,
      };
    }

    const failure = classifySpawn(spawned);
    if (failure !== null) {
      return { kind: "failed", reason: failure, outage: spawned.outage, problems: [`scaffold-gap ACT ${failure}`], spendUsd };
    }

    // A refused write is not an answer. Whatever the ACT concluded, the engine cannot see it,
    // and recording its silence as `empty` would retire the ratchet on this failure for good.
    // `failed` marks nothing, so the question is asked again once the cause is fixed.
    const denied = deniedTools(spawned.resultMessage);
    if (denied.length > 0) {
      return { kind: "failed", reason: "permission-denied", outage: false, problems: denied, spendUsd };
    }

    const scaffolded = readScaffolds(scratch, GAP_OUT_DIR);
    if (scaffolded.units.length === 0 && scaffolded.problems.length === 0) {
      return { kind: "empty", detail: `nothing more to slice under ${ctx.feature.id}`, spendUsd };
    }

    // Every new unit must be under THIS feature. Checked before the shared lint, because
    // the lint's scope is this feature's criteria and a unit parented elsewhere would be
    // measured against the wrong set.
    const strays = scaffolded.units.filter((s) => s.unit.parent !== ctx.feature.id);
    if (strays.length > 0) {
      return {
        kind: "rejected",
        problems: strays.map((s) => `${s.unit.id}: parent "${s.unit.parent ?? "(none)"}" — this rung mints under ${ctx.feature.id} only`),
        spendUsd,
      };
    }

    // **The same lint the epic rung runs, with `scope` narrowed to one feature.** The set
    // is this feature's units, old and new together: coverage is a property of the set, and
    // asking it of the new ones alone would fail a correct mint for every criterion the
    // already-merged units cover.
    const mine = ctx.existingUnits.filter((u) => u.parent === ctx.feature.id);
    const combined = [
      ...mine.map((unit) => ({ unit, source: "" })),
      ...scaffolded.units,
    ];
    const problems = scaffoldFindings(
      {
        level: "epic", criteria: ctx.criteria,
        existingUnits: ctx.existingUnits.filter((u) => u.parent !== ctx.feature.id),
        ...(ctx.dependable !== undefined ? { dependable: ctx.dependable } : {}),
      },
      { ...ctx.epic, delivers: ctx.feature.delivers },
      [ctx.feature],
      { units: combined, problems: scaffolded.problems },
    ).filter((p) =>
      // A finding about an already-merged unit is not this ACT's to answer. It landed, it
      // was judged, and reverting a correct mint over it would spin: the revert restores
      // the tree, the retry writes the same thing, and it is refused for the same reason
      // forever. Only what THIS run wrote can be corrected by re-running it.
      scaffolded.units.some((s) => p.includes(s.unit.id))
      || !mine.some((u) => p.includes(u.id)),
    );
    if (problems.length > 0) return { kind: "rejected", problems, spendUsd };

    const rels = writeScaffolds(ctx.arenaDir, scaffolded.units);
    stagePaths(ctx.arenaDir, rels);
    engineCommit(
      ctx.arenaDir,
      `doctrine: scaffold ${rels.length} more unit(s) under ${ctx.feature.id} (its grade failed)`,
    );
    return { kind: "scaffolded", ids: scaffolded.units.map((s) => s.unit.id), spendUsd };
  } finally {
    try {
      const { rmSync } = await import("node:fs");
      rmSync(scratch, { recursive: true, force: true });
    } catch { /* swept by the OS */ }
  }
}
