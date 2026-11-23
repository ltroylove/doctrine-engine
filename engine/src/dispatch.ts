import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkBudgets, DEFAULT_BUDGETS, type BudgetConfig } from "./budget.js";
import { writeDenySettings } from "./containment.js";
import { runBuildOut } from "./build-out.js";
import { runScaffoldGap } from "./scaffold-gap.js";
import { dependableCriteria, runDecompose } from "./decompose.js";
import { dependableSlices, satisfied } from "./depends.js";
import { featuresOfEpics } from "./feature.js";
import { engineCommit, stagePaths } from "./git-commit.js";
import { failureSignature, levelPassed, readLevelGrade, reopenLevel, runIntentGrade, runLevelGrade } from "./grade.js";
import { runImplementer } from "./implementer.js";
import { parseIntent, type Intent } from "./intent.js";
import { parseCriteria, programProgress } from "./coverage.js";
import { lintChildren, nextChainNeed, servedFeatures, type Narrowing } from "./narrowing.js";
import { FileNarrowingStore } from "./narrowing-store.js";
import { crossEpicCandidates, reviewEpicSet, reviewableSets } from "./narrowing-set.js";
import { reviewedHash, runSetJudge, writeSetReport } from "./narrowing-set-act.js";
import { runNarrowingAct } from "./narrowing-act.js";
import { clearRejected, readRejectedDrafts, readRejectedObjections, runProgramDecompose } from "./program.js";
import { judgePaths, runJudge, type RunAgentFn } from "./judge.js";
import { verdictFindings, type Verdict } from "./verdict.js";
import { appendDecomposeMetric, appendTick, appendUnitMetric, metricsPath, unbilledRoundSpend } from "./ledger.js";
import { acquireLease } from "./lease.js";
import { landUnit, landUnitViaPr, mergeOpenPr, openUnitPr, productionRunGh, removeWorktree, type RunGhFn } from "./merge.js";
import { REVIEW_FIX_DENY, fetchThreads, findOpenPr, formatThreads, replyToThread, repoSlug, resolveThread, reviewWindowElapsed, unresolved, type ReviewThread } from "./review.js";
import { runFixPass } from "./review-fix.js";
import { runUnitChecks, stillFailing, type CheckResult } from "./checks.js";
import { runTriageAct } from "./ticket-act.js";
import { GhTicketStore, TICKET_ACT_DENY, type TicketStore } from "./ticket-store.js";
import { DEFAULT_EMPTY_EXIT_CODE, designFailureDetail, designFailureSummary, designFindingList, runDesignJudge, type DesignBlock } from "./design-judge.js";
import { describeBreaches, guardrailBreaches } from "./guardrails.js";
import { BASH, runForStatus, runSetup } from "./setup.js";
import { outstanding, stallReason } from "./stall.js";
import { pausePath, readSteering } from "./steering.js";
import { isUiFile } from "./ui-files.js";
import { isAdmissible, isBuildable, parseWorkUnit, type WorkUnit } from "./work-unit.js";

/**
 * ONE TICK: stateless, artifact-derived, at most one landed unit.
 * The dispatch ladder: resume in-flight → ready unit → decompose → intent-grade →
 * idle. Everything is re-derived from the repo each tick; the tick owns no memory.
 */

export interface TickDeps {
  arenaDir: string;
  agentDefs: {
    implementer: string; judge: string; decomposer: string; planJudge: string;
    reviewFixer?: string;
    /**
     * The law for the pass that fixes what the JUDGE found, before the PR exists.
     *
     * A different law from `reviewFixer` and the same function: `runFixPass` serves both,
     * because "here is a branch and a list of what is wrong with it" is one job. What
     * differs is who is being answered — a person on a pull request, or a unit spec.
     */
    unitFixer?: string;
    /** The three laws of the triage rung: one writes the ticket, one judges it, one corrects it. */
    ticketTriager?: string; ticketJudge?: string; ticketFixer?: string;
    designJudge?: string;
    /** The program rung: both are needed, or the rung stays off. */
    /**
     * The intent rung: one law plans, one judges, one corrects.
     *
     * The third arrived last of the three rungs, which is the point — the unit rung has
     * had `review-fixer` since 2026-09-04 and the narrowing rung got one the same day
     * this did. A judge that refuses rather than reports makes the rung unable to finish:
     * every refusal buys a DIFFERENT plan rather than a better one.
     */
    programDecomposer?: string; programJudge?: string; intentFixer?: string;
    /**
     * The narrowing chain: one law writes, one judges, one corrects — at both levels.
     *
     * Three and not two because the judge no longer gates. It says what is wrong and the
     * fixer addresses it, the way a reviewer leaves comments and the author addresses
     * them; the rung used to delete the document and pay a writer to produce a different
     * one for the same judge to find different faults in.
     */
    narrowingDecomposer?: string; narrowingJudge?: string; narrowingFixer?: string;
    /**
     * The set judge. OPTIONAL, and the free half runs without it — a deployment that has
     * not installed this law still gates on the arithmetic and records a report saying the
     * judge did not run, rather than silently reporting a set as coherent.
     */
    narrowingSetJudge?: string;
    /**
     * The build-out ACT's law (ADR-0001). Optional, and the rung stays off without it —
     * `.claude/agents/build-out.md` was written after the engine half, and until it existed
     * the ACT was engine-complete and lawless and nothing could run it against a target.
     */
    buildOut?: string;
    /**
     * The ratchet's law (ADR-0003): mint more units under a feature whose grade failed.
     * Optional, and the rung stays off without it — a failed grade is then recorded and
     * nothing is bought, which is the honest behaviour for a target that has not
     * installed it.
     */
    scaffoldGap?: string;
  };
  budgets?: BudgetConfig;
  decomposeBudgetUsd?: number;
  /** Triage's budget. Small: one issue, one scan, one ticket. */
  triageBudgetUsd?: number;
  /** The build-out ACT's budget. Defaults to a fifth of the unit's, capped, like decompose. */
  buildOutBudgetUsd?: number;
  /**
   * Where tickets live. Injected so the 449 offline tests never touch a network.
   *
   * Production leaves it undefined and gets `GhTicketStore`, exactly as `runGh` works for
   * the review rung.
   */
  ticketStore?: TicketStore;
  runAgent?: RunAgentFn;
  /** Injected `gh` runner for PR-mode landing (tests); production shells out to `gh`. */
  runGh?: RunGhFn;
}

export interface TickResult {
  decision: string;
  unit?: string;
  detail?: string;
}

interface Manifest {
  base_branch?: string;
  setup?: string;
  doors?: string[];
  door_credentials?: string[];
  /** Per-target budget overrides (partial; merged over defaults). */
  budgets?: Partial<BudgetConfig>;
  /** Landing mode: "local" (default; arena targets) merges in the
   *  clone; "pr" (production targets) pushes the unit branch and machine-merges
   *  a PR into the base branch — bot review harvested, never waited on. */
  landing?: "local" | "pr";
  /**
   * Present → PR landing waits for external review before merging. Absent →
   * today's behaviour, merge on judge pass.
   */
  /**
   * Where the target's program inputs live. Present → the loop mints its own next
   * intents from them when the frontier empties. Absent → intents are
   * hand-written, which is where every target started.
   */
  /** Declared gate commands. Documentary for the engine; the UI admissibility check reads it for the design gate. */
  gates?: Record<string, string>;
  /**
   * Present and true → this target keeps its tickets in GitHub issues and the triage rung
   * runs against them. Absent → no ticket lane, which is where every target starts.
   *
   * A flag rather than inference from the presence of a label, because "no issue is
   * labelled needs-triage" and "this target does not do tickets" are different states and
   * only the second should be silent.
   */
  tickets?: boolean;
  program?: { prd: string; arch: string };
  /**
   * ADR-0008: the command that reports unresolved surface-contract ids, exiting 0 only
   * when none remain. Present → program-done also requires it to pass. Absent → the PRD
   * criteria are the only condition, as before.
   */
  surface?: string;
  /**
   * Present → this target has a design contract and can render its screens, so UI work
   * is admissible and the design-judge runs on any diff that touches UI. Absent → no
   * UI-touching unit may land here at all.
   */
  design?: DesignBlock;
  review?: {
    /** Seconds a PR stays open before an empty review counts as settled. Default 300. */
    window_s?: number;
    /** Fix→re-review rounds before merging regardless. Default 2. Review is never a gate. */
    max_rounds?: number;
    /** The loop's own GitHub login, so its replies are not read back as findings. */
    self_login?: string;
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function readJsonlObjects(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch { /* torn line */ }
  }
  return out;
}

/**
 * **The non-recursive `readdir` is load-bearing, not incidental.** `work/intents/` sits
 * inside `work/`, and since `Intent` and `WorkUnit` became one type with one status
 * vocabulary, the only thing keeping an intent out of the units array is that this listing
 * is one level deep and filtered to `.md`. Make it recursive and every `i.status ===
 * "ready"` below starts picking up intents, where `ready` means something else entirely.
 */
function loadUnits(arenaDir: string): WorkUnit[] {
  const dir = join(arenaDir, "work");
  if (!existsSync(dir)) return [];
  const units: WorkUnit[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const parsed = parseWorkUnit(readFileSync(join(dir, f), "utf8"));
    if (parsed.ok) units.push(parsed.unit);
  }
  return units;
}

function loadIntents(arenaDir: string): Intent[] {
  const dir = join(arenaDir, "work", "intents");
  if (!existsSync(dir)) return [];
  const intents: Intent[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const parsed = parseIntent(readFileSync(join(dir, f), "utf8"));
    if (parsed.ok) intents.push(parsed.intent);
  }
  return intents;
}

/** The convergence edge (2026-08-24): the plan-judge's objections to this intent's
 *  most recent plan, re-derived from the tick ledger — undefined once a decompose
 *  for the intent has since succeeded. */
function priorPlanRejection(arenaDir: string, intentId: string): string | undefined {
  const rows = readJsonlObjects(join(arenaDir, ".doctrine", "ticks.jsonl"));
  let judgeSaid: string | undefined;
  let lintSaid: string | undefined;
  /** Set when a plan-judge rejection is NEWER than any lint failure below it. */
  let lintIsStale = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r["unit"] !== intentId || typeof r["decision"] !== "string" || !(r["decision"] as string).startsWith("decompose-")) continue;
    if (r["decision"] !== "decompose-failed") break; // a decompose succeeded since — feedback is stale
    const detail = typeof r["detail"] === "string" ? (r["detail"] as string) : "";
    if (judgeSaid === undefined && detail.startsWith("plan-judge rejected")) {
      judgeSaid = detail;
      // Reaching the judge PROVES that plan passed the lint gate, so any lint error older
      // than this one belongs to a plan that has since been superseded — telling the retry
      // to fix it is pointing at a file that no longer exists. The reverse does not hold: a
      // newer LINT failure means the judge never ruled on that plan, so its older objections
      // are still unanswered. External review, PR #87.
      if (lintSaid === undefined) lintIsStale = true;
    }
    // **A lint failure is feedback too, and dropping it made the retry blind.**
    //
    // This scanned past lint failures so one could not MASK a plan-judge rejection a
    // record deeper — right about masking, wrong about ignoring. A plan refused for
    // malformed YAML is a paid round thrown away for a reason the writer can act on,
    // and re-asking without telling it is the re-roll shape this engine removes
    // everywhere else: a second attempt at the same attempt rather than at the problem.
    //
    // Observed live 2026-09-16: a unit whose `title:` began with a backtick — a YAML
    // reserved character — took the whole batch down for $5.29, and the retry would have
    // been given nothing. Spawn and truncation failures are still dropped: they say
    // something about the run, not about the plan, and there is nothing to act on.
    else if (lintSaid === undefined && detail.startsWith("plan lint failed")) lintSaid = detail;
  }
  // Both, when both happened — meaning before syntax, because a plan that is wrong about
  // the intent stays wrong after its YAML is fixed.
  const parts = [judgeSaid, lintIsStale ? undefined : lintSaid].filter((x): x is string => x !== undefined);
  return parts.length > 0 ? parts.join(String.fromCharCode(10, 10)) : undefined;
}

/**
 * Why the code-judge rejected this, in its own words — the next attempt's input.
 *
 * The prefix is only attached when there is something to prefix. A bare
 * `code-judge fail: ` is worse than an empty string: `failedAttempts` reads non-blank
 * as "this attempt recorded a reason", so a reasonless rejection would spend the retry
 * budget while teaching the retry nothing. `validateVerdict` now refuses that verdict
 * outright, and this is the second lock on the same door.
 */
function judgeFailureDetail(v: Verdict, unit: WorkUnit): string {
  const body = [
    ...v.coherence.filter((c) => !c.ok).map((c) => {
      const q = (c.quote ?? "").trim();
      return `coherence \`${c.criterion}\`${q.length > 0 ? `: ${q}` : " — the judge recorded no quote"}`;
    }),
    ...v.evidence.filter((e) => !e.ok).map((e) => {
      const expect = unit.evidence.find((u) => u.run === e.spec)?.expect;
      const wanted = expect === undefined ? "" : ` — expected: ${expect}`;
      return e.run.exit_code === 0
        ? `evidence \`${e.spec}\` ran clean but its output did not satisfy the spec${wanted}`
        : `evidence \`${e.spec}\` exited ${e.run.exit_code}${wanted}`;
    }),
  ].join("; ").slice(0, 4000);
  // On an escalate, the judge's own account of WHY leads, because it is the only part a
  // planner can act on. The coherence and evidence lines below it say which check tripped;
  // this says what is wrong with the unit itself, and they are not interchangeable.
  const why = v.verdict === "escalate" ? escalationProse(v.escalation) : "";
  if (why.length > 0) {
    return `code-judge escalate: ${why}${body.length === 0 ? "" : ` — the checks that tripped: ${body}`}`;
  }
  return body.length === 0 ? "" : `code-judge ${v.verdict}: ${body}`;
}

/**
 * The judge's escalation block, flattened into prose a planner can read.
 *
 * Shape-agnostic by design: the block is free-form, so this walks whatever string values
 * it holds rather than naming fields the judge has to guess. Order is preserved because
 * judges write `reason` first and the detail after it.
 */
function escalationProse(escalation: Record<string, unknown> | undefined): string {
  if (escalation === undefined) return "";
  return Object.entries(escalation)
    .filter(([, val]) => typeof val === "string" && val.trim().length > 0)
    .map(([key, val]) => `${key}: ${(val as string).trim()}`)
    .join(" | ")
    .slice(0, 6000);
}

/**
 * Units that can never become admissible, because something they depend on will never merge.
 *
 * `isAdmissible` requires every dependency to be MERGED, and an escalated unit never merges
 * — so a unit downstream of one is `ready` forever: never built, never escalated, never
 * counted as settled. Admitting only `escalated` to the grade predicate therefore fixed
 * nothing on the case that motivated it. On 2026-09-07 attention-core escalated, and
 * attention-hours (depends on core) and attention-terms (depends on hours) sat ready
 * permanently, so `every(...)` stayed false and the intent stayed frozen exactly as before.
 *
 * Transitive, because the second hop is what made it invisible: attention-terms never
 * mentions the escalated unit at all. Cycles cannot hang this — the walk is over a visited
 * set — though the plan-judge rejects cyclic plans before they get here.
 */
/**
 * **This walks UNIT ids, and after ADR-0004 a unit names criteria — so on anything planned
 * under the new rule it returns nothing at all.** Stated rather than left to be inferred
 * from the fact that the function exists, which is the same trap `programProgress` was in.
 *
 * It still works on the ~97 legacy units in flight, whose `depends_on` really does hold
 * unit ids, and that is why it stays rather than being deleted.
 *
 * **It fails SAFE, and that is the whole reason it is not rewritten here.** A criterion is
 * never a key in `byId` and never in `dead`, so the walk returns an empty set: a missing
 * capability, not a wrong answer. The output is not advisory — the caller flips every id in
 * it to `escalated` on disk — so a false positive permanently retires a unit nobody asked
 * it to retire. Between a gap that stalls one intent and a rewrite that can destroy ready
 * work, the gap waits for the step that owns the grades.
 *
 * **What the replacement has to answer.** Not "is this downstream
 * of an escalation" — that question dissolved. An escalated child no longer freezes its
 * intent (the predicate below already admits it), so a dependent waits on the INTENT's
 * criteria and the intent can still reach `done`. The criterion-era question is *can this
 * requirement ever be satisfied*, and it has two real cases: a criterion no slice delivers
 * or renders, and a unit waiting on a criterion only its OWN intent delivers — the deadlock
 * `lintPlan` now refuses at mint, which on-disk units may still hold.
 *
 * And one trap the rewrite must not walk into. A LEGACY unit-id dependency is **malformed,
 * not unsatisfiable**: `u-2026-09-17-payroll-sync-step` waits on two units that are already
 * merged, so the work it named is done and only the notation is stale. A rule that reads
 * "not a criterion anything delivers" as "can never clear" would escalate it — destroying a
 * ready unit over a migration artifact. That one is the `depends_on` rewrite at cutover.
 */
export function permanentlyBlocked(children: readonly WorkUnit[]): Set<string> {
  const byId = new Map(children.map((u) => [u.id, u]));
  const dead = new Set(children.filter((u) => u.status === "escalated").map((u) => u.id));
  if (dead.size === 0) return new Set();
  const blocked = new Set<string>();
  const reaches = (id: string, seen: Set<string>): boolean => {
    if (dead.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (byId.get(id)?.dependsOn ?? []).some((d) => reaches(d, seen));
  };
  for (const u of children) {
    if (u.status === "merged" || u.status === "escalated") continue;
    if ((u.dependsOn ?? []).some((d) => reaches(d, new Set()))) blocked.add(u.id);
  }
  return blocked;
}

/** A PRD criterion id, and the ONLY shape this rung is willing to reason about. */
const CRITERION_ID = /^C\d+\.\d+$/;

/**
 * Units whose REQUIREMENTS can never be satisfied, because everything that would deliver
 * them has been ruled unbuildable (ADR-0004).
 *
 * The criterion-era half of `permanentlyBlocked` above, and a separate function rather
 * than a branch inside it because the two answer different questions about different
 * vocabularies. That one walks unit ids and is legacy; this one walks criteria and is what
 * the ladder runs on after cutover. A dependency is one or the other, never both, so they
 * compose by union at the call site instead of contending inside one walk.
 *
 * **The rule is deliberately narrow: every slice delivering or rendering the criterion is
 * `escalated`.** Not "no slice delivers it" — that reads a criterion the epic layer has
 * not reached yet as one that can never be reached, and epics are minted one at a time, so
 * it would escalate work whose dependency is simply not planned yet. A criterion nothing
 * names is absent from the satisfied set, which makes the unit wait; being made to wait is
 * not the same as being retired, and only one of those is reversible.
 *
 * **And a dependency that is not a criterion id is ignored outright.** Malformed is not
 * unsatisfiable. `u-2026-09-17-payroll-sync-step` names two unit ids that are already
 * MERGED — the work it asked for is done and only the notation is stale — and a rule
 * reading "not a criterion anything delivers" as "can never clear" would escalate a ready
 * unit over a migration artifact. Cutover rewrites that field; until then this rung says
 * nothing about it.
 *
 * Transitive through what the stranded units themselves deliver: if the only unit that
 * would deliver `C2.1` is stranded behind an escalated `C1.1`, then `C2.1` is dead too.
 * The walk is over a growing set and stops when it stops growing, so a cycle cannot hang it.
 */
export function unsatisfiableUnits(units: readonly WorkUnit[]): Set<string> {
  const alive = (u: WorkUnit): boolean => u.status !== "escalated";
  const stranded = new Set<string>();

  for (;;) {
    // A criterion is dead when something names it and nothing that names it survives.
    const namers = new Map<string, WorkUnit[]>();
    for (const u of units) {
      for (const c of [...u.delivers, ...u.renders]) namers.set(c, [...(namers.get(c) ?? []), u]);
    }
    const dead = new Set<string>();
    for (const [criterion, by] of namers) {
      if (by.every((u) => !alive(u) || stranded.has(u.id))) dead.add(criterion);
    }

    let grew = false;
    for (const u of units) {
      if (!alive(u) || u.status === "merged" || stranded.has(u.id)) continue;
      const fatal = u.dependsOn.filter((d) => CRITERION_ID.test(d) && dead.has(d));
      if (fatal.length > 0) { stranded.add(u.id); grew = true; }
    }
    if (!grew) return stranded;
  }
}

/**
 * The children of one intent or one feature that can never become admissible — the ONE
 * statement of "stranded", shared by both grade rungs (PR #94 review).
 *
 * **Computed over every unit, then filtered to the children, and the order matters.** A
 * criterion is dead only when EVERY unit naming it is escalated. Asked of a subset, a
 * criterion that another feature's live unit is still building looks dead, and its
 * dependents would be retired for good over work that is merely in flight — escalation
 * writes to disk, so that is the direction this must never be wrong in. The intent rung
 * got away with the scoped form only because legacy units declare no `delivers`.
 *
 * Pure: the caller decides whether to count them as settled or to retire them.
 */
function strandedChildren(allUnits: readonly WorkUnit[], children: readonly WorkUnit[]): Set<string> {
  const dead = unsatisfiableUnits(allUnits);
  return new Set([
    ...permanentlyBlocked(children),
    ...children.filter((u) => dead.has(u.id)).map((u) => u.id),
  ]);
}

/** Retire stranded children for real, before a grade assumes they are settled. */
function retireStranded(arenaDir: string, stranded: ReadonlySet<string>, owner: string): void {
  for (const b of stranded) {
    flipStatus(
      arenaDir, join("work", `${b}.md`), "escalated",
      `doctrine: retire ${b} (stranded behind an escalated dependency of ${owner})`,
    );
    appendTick(arenaDir, {
      decision: "retired-stranded-unit", unit: b,
      detail: `nothing it depends on can ever merge, so it could never become admissible`,
    });
  }
}

/**
 * What the judge said about each escalated unit of one intent, newest row per unit.
 *
 * The unit files record THAT a unit escalated; only the ledger records why. This pairs
 * them, so the gap decomposer is told which specs are the defect and in whose words.
 */
function escalatedUnitDetails(arenaDir: string, units: readonly WorkUnit[], intentId: string): string[] {
  const escalated = units.filter((u) => u.intent === intentId && u.status === "escalated");
  if (escalated.length === 0) return [];
  const rows = readJsonlObjects(metricsPath(arenaDir))
    .filter((r) => r["type"] === "unit" && r["outcome"] === "escalated");
  const out: string[] = [];
  for (const u of escalated) {
    const last = [...rows].reverse().find((r) => r["unit"] === u.id);
    const why = String(last?.["detail"] ?? "").trim();
    // ONLY a code-judge escalation says the SPEC is the defect. `escalated` is also the
    // status for attempt exhaustion, a guardrail breach, missing UI infrastructure, and a
    // PR that vanished — none of which are claims about the unit's contract, and two of
    // which write no unit metric at all. Telling a paid planner that those specs are
    // defective would send it rewriting units that were never the problem, which is worse
    // than telling it nothing: it is confident and wrong.
    //
    // The prefix is the one `judgeFailureDetail` writes, the same discriminator used for
    // instrument rows. A unit escalated some other way is simply not mentioned here; the
    // grade failure log still reports what its acceptance could not do.
    if (!why.startsWith("code-judge escalate:")) continue;
    out.push(`${u.id} (${u.title}): ${why}`);
  }
  return out;
}

/**
 * Does this branch carry work the base does not already have?
 *
 * A branch cut but never committed to answers zero — that is the leftover the cleanup
 * path exists to delete. Anything else is a unit's work.
 */
function branchHasCommit(arenaDir: string, branch: string, baseBranch: string): boolean {
  try {
    return git(arenaDir, ["rev-list", "--count", `${baseBranch}..${branch}`]).trim() !== "0";
  } catch {
    // A question that could not be answered is not a "no". Deleting on a failed check is
    // exactly how the invoice-review work was lost; keep the branch, and rung 0 reaps a
    // genuinely empty leftover next tick anyway.
    return true;
  }
}

/**
 * Did the INSTRUMENT fail, rather than the unit?
 *
 * New rows say so outright. Older ones cannot: every arena already holds judge failures written
 * before the flag existed — including the malformed-verdict that escalated
 * u-2026-09-05-invoice-review, which is the incident this whole rule exists for. A fix that did not
 * reach it would be a fix that could not repair the case that motivated it, so the legacy shapes are
 * recognised by the only thing those rows carry: the text the engine itself wrote.
 *
 * It reads prefixes the engine emits, never keywords: a verdict is free to call a SCREEN malformed,
 * and that stays the unit's problem. The design side has one that does the whole job — an engine
 * reason is written as `design-judge: ${`design-judge ${reason}: …`}`, so the prefix is DOUBLED,
 * while a verdict's own finding starts with a screen filename. That is the discriminator, rather
 * than a list of reason names, so a reason added later is classified without anyone remembering to
 * come back here. The trailing space is load-bearing: it keeps a screen actually named
 * `design-judge.png` on the unit's side of the line.
 *
 * `no-screens` is the one engine reason that is NOT ours. A head that rendered nothing is the
 * unit's — its change broke the app or dropped the screen from the register. The check is on the
 * bare `no-screens` prefix so a legacy row from before the head/base split is charged to the unit
 * too: that is the conservative direction, since the cost of being wrong is one wasted attempt
 * rather than a unit that retries forever.
 *
 * Only ONE of the two consumers is filtered — `summaries`, so an engine error neither spends the
 * budget nor reaches the retry as feedback. `consecutiveUnitFailures` is deliberately left alone:
 * these rows are still `failed`, so a judge that breaks three times running trips the halt. A
 * broken instrument should stop the loop loudly, not quietly retry behind it.
 */
function isInstrumentFailure(row: Record<string, unknown>): boolean {
  if (row["instrument"] === true) return true;
  if (row["instrument"] === false) return false;
  const detail = String(row["detail"] ?? "");
  if (detail.startsWith("judge could not run:")) return true;
  const engineReason = "design-judge: design-judge ";
  if (detail.startsWith(engineReason)) return !detail.slice(engineReason.length).startsWith("no-screens");
  return false;
}

function failedAttempts(arenaDir: string, unitId: string): { count: number; summaries: string[] } {
  const rows = readJsonlObjects(metricsPath(arenaDir)).filter(
    (r) => r["type"] === "unit" && r["unit"] === unitId && r["outcome"] === "failed",
  );
  // Rows with no `detail` predate the field and say nothing; feeding "failed attempt"
  // to a retry is worse than feeding it nothing, because it looks like information.
  return {
    count: rows.length,
    // Instrument failures are excluded, and that single filter does both jobs: they do not spend
    // the retry budget (see `informed` at the attempt gate) and they do not reach the next attempt
    // as feedback. An engine error is not a reason a retry can act on.
    //
    // `count` still includes them, deliberately — the floor at twice the budget is what stops a
    // permanently broken instrument retrying a unit forever, and it is the only thing that can.
    summaries: rows
      .filter((r) => !isInstrumentFailure(r))
      .map((r) => String(r["detail"] ?? ""))
      .filter((d) => d.trim().length > 0),
  };
}

function flipStatus(arenaDir: string, relPath: string, to: string, commitMsg: string): void {
  const path = join(arenaDir, relPath);
  writeFileSync(path, readFileSync(path, "utf8").replace(/^status:\s*\S+/m, `status: ${to}`));
  stagePaths(arenaDir, [relPath]);
  engineCommit(arenaDir, commitMsg);
}

/**
 * Pre-spend landing probe (the `git push --dry-run` rule, restored
 * 2026-08-20): refuse to run a PAID act whose result could not land. In PR mode a broken push path or a dead `gh` credential
 * turns the tick into a free no-op instead of a $-spent park.
 */
/**
 * Bring the base branch level with origin, then hand back anything of ours it lacks.
 *
 * Fast-forward is the common case. When it is impossible the two tips have DIVERGED —
 * a bookkeeping commit whose push failed on an earlier tick, and origin has moved since
 * — and swallowing that leaves every later push and landing probe failing
 * non-fast-forward, forever, on every tick. So the divergence is reconciled here by
 * rebasing our commits onto the fetched tip: they are status flips and decision-log
 * appends, small and append-only, which is exactly the shape that rebases cleanly.
 *
 * A rebase that does not apply is a real conflict and the loop says so rather than
 * guessing — that one needs an observer. The rebase is aborted first, so the tree is
 * left exactly as it was found.
 */
function syncBase(arenaDir: string, baseBranch: string): { ok: true } | { ok: false; reason: string } {
  try {
    git(arenaDir, ["fetch", "-q", "origin", baseBranch]);
  } catch (e) {
    // Offline is not divergence; the probe below will report it if it matters.
    return { ok: true };
  }
  try {
    git(arenaDir, ["merge", "--ff-only", "-q", `origin/${baseBranch}`]);
  } catch {
    try {
      git(arenaDir, ["rebase", `origin/${baseBranch}`]);
    } catch (e) {
      try { git(arenaDir, ["rebase", "--abort"]); } catch { /* nothing in progress */ }
      const first = (e instanceof Error ? e.message : String(e)).split(/\r?\n/)[0]!.slice(0, 200);
      return {
        ok: false,
        reason: `${baseBranch} has diverged from origin and the engine's bookkeeping would not rebase onto it — this needs an observer, not a retry: ${first}`,
      };
    }
  }
  try {
    if (git(arenaDir, ["rev-list", "--count", `origin/${baseBranch}..${baseBranch}`]) !== "0") {
      git(arenaDir, ["push", "-q", "origin", baseBranch]);
    }
  } catch { /* racing another push; the next tick tries again */ }
  return { ok: true };
}

function probeLanding(
  arenaDir: string,
  baseBranch: string,
  gh: RunGhFn,
): { ok: true } | { ok: false; reason: string } {
  const firstLine = (e: unknown): string =>
    (e instanceof Error ? e.message : String(e)).split(/\r?\n/)[0]!.slice(0, 160);
  try {
    git(arenaDir, ["push", "--dry-run", "origin", baseBranch]);
  } catch (e) {
    const text = `${e instanceof Error ? e.message : String(e)}`;
    // "Behind" is not "denied", and saying so sends the observer to the wrong problem.
    const behind = /non-fast-forward|fetch first|remote contains work/i.test(text);
    return {
      ok: false,
      reason: behind
        ? `base branch is behind origin and could not fast-forward — the clone has diverged from ${baseBranch}, which needs an observer, not a credential: ${firstLine(e)}`
        : `push access probe failed: ${firstLine(e)}`,
    };
  }
  try {
    gh(["auth", "status"], arenaDir);
  } catch (e) {
    return { ok: false, reason: `gh auth probe failed: ${firstLine(e)}` };
  }
  return { ok: true };
}

/** Worktrees hold branches; remove them BEFORE deleting the branch, in that order. */
function reapBranch(arenaDir: string, branch: string, worktrees: string[]): void {
  for (const wt of worktrees) removeWorktree(arenaDir, wt);
  try {
    git(arenaDir, ["branch", "-D", branch]);
  } catch { /* still held somewhere — rung 0 reaps or resumes it next tick */ }
}

/** Sweep worktree registrations left by dead ticks. The lease guarantees no live
 *  tick shares the repo, so every .doctrine/runs worktree is a corpse. Logs live in
 *  the run dir, not the worktree checkout — nothing of value is lost. */
function sweepStaleWorktrees(arenaDir: string): void {
  let listing: string;
  try {
    listing = git(arenaDir, ["worktree", "list", "--porcelain"]);
  } catch {
    return;
  }
  for (const line of listing.split(/\r?\n/)) {
    const m = /^worktree (.+)$/.exec(line);
    if (m && /[/\\]\.doctrine[/\\](runs|canary-runs)[/\\]/.test(m[1]!)) {
      removeWorktree(arenaDir, m[1]!);
    }
  }
}


/**
 * A completed program must not be re-asked every idle interval. When the rung answers
 * "nothing left", the answer is recorded against the commit it was true at; the next
 * tick skips the rung while HEAD is unchanged, and the record self-clears the moment
 * any work lands. Cheaper and more honest than a halt: the loop stays live for
 * maintenance units and review settling, it just stops paying to re-read a finished PRD.
 */
function programSettledPath(arenaDir: string): string {
  return join(arenaDir, ".doctrine", "program-settled.json");
}

function programSettled(arenaDir: string, head: string): boolean {
  try {
    const rec = JSON.parse(readFileSync(programSettledPath(arenaDir), "utf8")) as { head?: string };
    return rec.head === head;
  } catch {
    return false;
  }
}

function markProgramSettled(arenaDir: string, head: string, detail: string): void {
  try {
    mkdirSync(join(arenaDir, ".doctrine"), { recursive: true });
    writeFileSync(programSettledPath(arenaDir), JSON.stringify({ head, detail, at: new Date().toISOString() }, null, 2));
  } catch { /* best effort; the worst case is one repeated read of the PRD */ }
}

function intentSettledPath(arenaDir: string): string {
  return join(arenaDir, ".doctrine", "intents-settled.json");
}

function readIntentSettled(arenaDir: string): Record<string, string> {
  try {
    const rec = JSON.parse(readFileSync(intentSettledPath(arenaDir), "utf8")) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/**
 * An intent the decomposer honestly could not slice AT THIS COMMIT.
 *
 * "Empty" is a real answer and it used to be a silent spin. `decompose-empty` left the
 * intent `ready`, so the next tick's `intents.find(i => i.status === "ready")` picked
 * the same one, paid the same ~$2, and got the same honest empty plan — forever. The
 * failure halt could not see it either, because an empty plan is not a failure, so
 * nothing counted it. Busy, expensive, producing nothing, with every backstop blind:
 * exactly the state the anti-spin machinery exists for.
 *
 * Keyed on HEAD, so it clears itself the moment anything lands. That also removes the
 * need for a dependency mechanism between intents. One target minted two — a walking
 * skeleton and an invoice push that needs the skeleton's `src/core`, `src/db`, `src/sync`
 * and `src/billing` to exist — and file order handed the loop the dependent one first.
 * Settled at this commit, it steps aside; the skeleton builds; HEAD moves; and the
 * intent is asked again when its answer can be different.
 */
function intentSettled(arenaDir: string, intentId: string, head: string): boolean {
  return readIntentSettled(arenaDir)[intentId] === head;
}

/**
 * Carry settlement forward across a commit that changed no product code.
 *
 * Settlement is keyed on a commit because a different commit can deserve a different
 * answer. Retiring stranded units commits — but it only rewrites work-unit STATUS, so
 * every intent settled at the old head still deserves its old answer. Without this, one
 * retirement un-settles every other settled intent at once, and the next tick pays for a
 * gap decompose on each of them to be told again what it was told before.
 *
 * Only entries at exactly `from` move. An intent settled at some older commit stays where
 * it is: something else moved the tree under it, and that is the case settlement is for.
 */
function carrySettlementForward(arenaDir: string, from: string, to: string): void {
  if (from === to) return;
  try {
    const rec = readIntentSettled(arenaDir);
    let moved = false;
    for (const [id, at] of Object.entries(rec)) {
      if (at === from) { rec[id] = to; moved = true; }
    }
    if (!moved) return;
    mkdirSync(join(arenaDir, ".doctrine"), { recursive: true });
    writeFileSync(intentSettledPath(arenaDir), JSON.stringify(rec, null, 2));
  } catch { /* best effort; the worst case is one repeated empty decompose */ }
}

/**
 * The grade-failure signature a gap decompose was last bought against.
 *
 * **Measured before it was built:** 16 `gap-empty` ticks on one target across the
 * project, $31.33, twelve of them in one day. An intent whose grade fails and whose gap
 * decomposer honestly has nothing to slice is blocked on something outside itself, and
 * `intentSettled` only holds until the next commit that touches product code — so every
 * merge anywhere re-bought the same correct "nothing to add" at ~$2.
 *
 * Settlement could not fix that on its own: it is keyed to a commit, and the commit moves
 * for reasons that have nothing to do with this intent. The evidence is the right key. If
 * the acceptance commands fail identically, byte for byte, the decomposer is being asked a
 * question it has already answered.
 *
 * Kept in its own file rather than widened into `intents-settled.json`, whose shape
 * `readIntentSettled` enforces and several call sites read.
 */
function gapSignaturePath(arenaDir: string): string {
  return join(arenaDir, ".doctrine", "gap-signatures.json");
}

function readGapSignatures(arenaDir: string): Record<string, string> {
  try {
    const rec = JSON.parse(readFileSync(gapSignaturePath(arenaDir), "utf8")) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function markGapAsked(arenaDir: string, intentId: string, signature: string): void {
  try {
    mkdirSync(join(arenaDir, ".doctrine"), { recursive: true });
    const rec = readGapSignatures(arenaDir);
    rec[intentId] = signature;
    writeFileSync(gapSignaturePath(arenaDir), JSON.stringify(rec, null, 2));
  } catch { /* best effort; the worst case is one repeated empty decompose */ }
}

function markIntentSettled(arenaDir: string, intentId: string, head: string): void {
  try {
    mkdirSync(join(arenaDir, ".doctrine"), { recursive: true });
    const rec = readIntentSettled(arenaDir);
    rec[intentId] = head;
    writeFileSync(intentSettledPath(arenaDir), JSON.stringify(rec, null, 2));
  } catch { /* best effort; the worst case is one repeated empty decompose */ }
}

/**
 * The last program rejection's reasons, so a retry converges instead of re-minting.
 *
 * Only a JUDGE rejection counts. A spawn failure — a timeout, an outage — says nothing
 * about the plan, and feeding "timed-out" back as though the planner had been argued
 * with is noise that makes the next attempt worse, not better.
 */
function lastProgramRejection(arenaDir: string): string | undefined {
  const rows = readJsonlObjects(join(arenaDir, ".doctrine", "ticks.jsonl"));
  for (let i = rows.length - 1; i >= 0; i--) {
    const decision = String(rows[i]!["decision"] ?? "");
    // A mint or an empty frontier supersedes any earlier objection: the plan it was
    // about no longer exists.
    if (decision === "program-minted" || decision === "program-empty") return undefined;
    if (decision === "program-rejected") {
      // `problems` in full, `detail` only as a fallback for rows written before the
      // field existed. `detail` is a clipped summary, and reading the objections out
      // of it handed the planner one of four, cut mid-sentence — it fixed that one
      // and tripped over the rest, twice, at ~$9 an attempt.
      const raw = rows[i]!["problems"];
      if (Array.isArray(raw)) {
        const problems = raw.map((x) => String(x).trim()).filter((x) => x.length > 0);
        if (problems.length > 0) {
          return problems.map((x, n) => `${n + 1}. ${x}`).join("\n\n");
        }
      }
      const detail = String(rows[i]!["detail"] ?? "").trim();
      return detail.length > 0 ? detail : undefined;
    }
    // Anything else — a timeout, a lint failure, an outage — says nothing about the
    // plan, so keep scanning. Stopping here threw away a live objection whenever a
    // rejection happened to be followed by an infrastructure failure, and the next
    // attempt would then re-mint exactly what was refused.
  }
  return undefined;
}

/**
 * The whole case against the last attempt: every objection, and the draft each one is
 * about.
 *
 * Handing over reasons alone asks the planner to revise a document it cannot see — the
 * revert deleted it — so it starts over instead, and the new draft has new holes. The
 * two halves are only useful together.
 */
/**
 * Why the last document written at this level could not be READ.
 *
 * This is no longer "the judge's objections", and the change is the point. A judge's
 * findings never reach here any more: they are handed to a correction pass on the
 * document that has them, and that document is published. The only thing that still kills
 * a narrowing outright is a parser that cannot read it — there is no id, no level and no
 * `delivers`, so neither a judge nor a fixer could be pointed at it. Those reasons come back
 * here so the next writer does not reproduce them.
 *
 * The older shape, and why it went: a refusal deleted the draft and the retry wrote a
 * fresh narrowing from the same sources. The comment that used to sit here justified it —
 * "a narrowing is derived rather than revised" — and that was wrong twice over. It
 * diverged from the intent rung, which already shelved refused drafts after an incident
 * costing two attempts and roughly seventeen dollars for a second draft sharing not one
 * paragraph with the first; and it made the rung unable to finish, because each retry
 * produced a DIFFERENT document for the judge to find different faults in.
 */
/** Test seam, as for the narrowing rung beside it. */
export function priorPlanRejectionForTest(arenaDir: string, intentId: string): string | undefined {
  return priorPlanRejection(arenaDir, intentId);
}

export function priorNarrowingRejectionForTest(arenaDir: string): string | undefined {
  return priorNarrowingRejection(arenaDir);
}

function priorNarrowingRejection(arenaDir: string): string | undefined {
  // Backwards, stopping at the first SUCCESS — the same walk the intent rung's lookup
  // does. Filtering for rejections alone returns the last one forever, so once any
  // narrowing had been refused, every later slice's planner was handed objections about
  // the slice before it and told to address them.
  const rows = readJsonlObjects(join(arenaDir, ".doctrine", "ticks.jsonl"));
  let last: Record<string, unknown> | undefined;
  for (let i = rows.length - 1; i >= 0; i--) {
    const decision = String(rows[i]!["decision"] ?? "");
    if (decision === "epic-minted" || decision === "feature-minted" || decision === "epic-empty" || decision === "feature-empty") break;
    if (decision === "epic-rejected" || decision === "feature-rejected") { last = rows[i]!; break; }
  }
  if (last === undefined) return undefined;
  const problems = Array.isArray(last["problems"])
    ? (last["problems"] as unknown[]).map((x) => String(x)).filter((x) => x.trim().length > 0)
    : [];
  if (problems.length === 0) return undefined;
  return problems.map((p, i) => `${i + 1}. ${p}`).join("\n\n");
}

function priorProgramRejection(arenaDir: string): string | undefined {
  // The ledger first — it is the freshest — but never as a precondition. `ticks.jsonl`
  // is not committed, so a fresh clone or a `git clean -fdx` keeps the shelf and loses
  // the log; requiring a ledger row threw away a draft that was sitting right there
  // and sent the planner back to starting over, which is the whole defect.
  const objections = lastProgramRejection(arenaDir) ?? nonEmpty(readRejectedObjections(arenaDir));
  const drafts = readRejectedDrafts(arenaDir);
  if (objections === undefined && drafts === "") return undefined;
  if (objections === undefined) {
    return `## A draft was refused — revise THIS, do not start over\n\n${drafts}`;
  }
  return drafts === ""
    ? objections
    : `${objections}\n\n## The draft that was refused — revise THIS, do not start over\n\n${drafts}`;
}

const nonEmpty = (s: string): string | undefined => (s.trim().length > 0 ? s : undefined);

/**
 * Has this worktree got screens to render, or is its register genuinely empty?
 *
 * "No images appeared" is NOT the signal. It cannot tell an empty register from a
 * browser that failed to launch, and getting that backwards inverts the gate: a
 * transient capture failure on the base would read as "this app has never had screens",
 * and a change to a mature UI would then be graded absolutely with the real baseline
 * never compared. So the target says which it is, with a documented exit code, and
 * anything else is a failure that must reach the judge as one (doctrine#22 review).
 *
 * The probe's own images are deleted before returning. They are written into the very
 * directory the judge's validator inspects, and leaving them there would let a judge
 * that skipped its baseline render pass the check that exists to catch exactly that —
 * the false positive rendering both sides was added to prevent, walked in through the
 * back door. The judge runs the command itself; this only asks a question.
 */
export function baselineState(dir: string, design: DesignBlock): "rendered" | "empty" | "broken" {
  const out = join(dir, design.out);
  const empty = design.emptyExitCode ?? DEFAULT_EMPTY_EXIT_CODE;
  const code = runForStatus(design.screens, dir);
  const rendered = existsSync(out) && readdirSync(out).some((f) => /\.(png|jpe?g|webp)$/i.test(f));
  rmSync(out, { recursive: true, force: true });
  if (rendered) return "rendered";
  return code === empty ? "empty" : "broken";
}

/** A newline. A literal one in this file has been mangled by every shell edit it saw. */
const NEWLINE = String.fromCharCode(10);


const DEFAULT_REVIEW_WINDOW_S = 300;
const DEFAULT_REVIEW_MAX_ROUNDS = 2;

/** How many review-fix passes this unit has already had — counted from the tick ledger,
 *  never held in memory: the tick owns no state, so the round count is an artifact too. */
function reviewRounds(arenaDir: string, unitId: string): number {
  return readJsonlObjects(join(arenaDir, ".doctrine", "ticks.jsonl"))
    .filter((t) => t["unit"] === unitId && t["decision"] === "review-fixed").length;
}

/** The local branch carrying a unit's open PR, or null if it is gone. */
function unitBranch(arenaDir: string, unitId: string): string | null {
  const branches = git(arenaDir, ["branch", "--list", `doctrine/${unitId}-*`])
    .split(/\r?\n/).map((b) => b.replace(/^[*+]?\s*/, "")).filter((b) => b.length > 0);
  return branches[0] ?? null;
}

/**
 * A unit's status AS ITS BRANCH RECORDS IT.
 *
 * `openUnitPr` commits `status: in-review` on the unit branch — that is what the PR
 * merges, so code and state land atomically. The base checkout still says `ready`, so
 * a base-only read can never see a unit that is waiting on review: the review rung
 * would never fire, and rung 0 would treat the branch as crashed work and re-judge it.
 * State is still derived from committed artifacts; this just reads the artifact on the
 * ref that actually holds it.
 */
function branchUnitStatus(arenaDir: string, branch: string, unitId: string): string | null {
  try {
    const md = git(arenaDir, ["show", `${branch}:work/${unitId}.md`]);
    return /^status:\s*(\S+)/m.exec(md)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Every unit whose branch says it is waiting on review. */
function unitsInReview(arenaDir: string, units: readonly WorkUnit[]): Array<{ unit: WorkUnit; branch: string }> {
  const out: Array<{ unit: WorkUnit; branch: string }> = [];
  for (const unit of units) {
    const branch = unitBranch(arenaDir, unit.id);
    if (branch === null) continue;
    if (unit.status === "in-review" || branchUnitStatus(arenaDir, branch, unit.id) === "in-review") {
      out.push({ unit, branch });
    }
  }
  return out;
}

/**
 * The review rung. A unit sits at `in-review` with an
 * open PR. Each tick: harvest the threads, and either merge, wait, or fix.
 *
 * The findings go to the review-fix ACT on this unit's own branch and nowhere else —
 * not to the decomposer, not to the intent, not to `contracts.md`. `REVIEW_FIX_DENY`
 * enforces that at the permission layer rather than in prose, because the failure it
 * prevents is a real one: feedback on a diff turning into a rewrite of the plan, and
 * then a build against the rewrite, with the unit under review never finished.
 *
 * Review never becomes a gate. After `max_rounds` the unit merges with whatever is
 * still open recorded in `context/review-findings/` for intake to pick up as a
 * maintenance unit. A reviewer who can hold the loop forever is an approver.
 */
async function handleReview(
  deps: TickDeps,
  manifest: Manifest,
  unit: WorkUnit,
  startedMs: number,
  knownBranch?: string,
): Promise<TickResult> {
  const arenaDir = deps.arenaDir;
  const gh = deps.runGh ?? productionRunGh;
  const baseBranch = manifest.base_branch ?? "development";
  const windowMs = (manifest.review?.window_s ?? DEFAULT_REVIEW_WINDOW_S) * 1000;
  const maxRounds = manifest.review?.max_rounds ?? DEFAULT_REVIEW_MAX_ROUNDS;

  const branch = knownBranch ?? unitBranch(arenaDir, unit.id);
  if (branch === null) {
    // No branch and no PR: the merge already happened (a tick died between the
    // remote merge and the local sync, or the observer merged it). Sync and settle.
    try {
      git(arenaDir, ["fetch", "-q", "origin", baseBranch]);
      git(arenaDir, ["merge", "--ff-only", `origin/${baseBranch}`]);
    } catch { /* nothing to fast-forward */ }
    flipStatus(arenaDir, join("work", `${unit.id}.md`), "merged", `doctrine: ${unit.id} settled (PR merged, branch gone)`);
    settleWithoutLanding(arenaDir, unit, startedMs);
    appendTick(arenaDir, { decision: "review-settled-merged", unit: unit.id });
    return { decision: "review-settled-merged", unit: unit.id };
  }

  const prLookup = findOpenPr(gh, branch, arenaDir);
  if (!prLookup.looked) {
    // A lookup that failed is not an answer. Acting on it here would delete the branch
    // and call an unmerged unit settled, so the tick retries instead.
    appendTick(arenaDir, { decision: "no-op-review-lookup-failed", unit: unit.id, detail: prLookup.error });
    return { decision: "no-op-review-lookup-failed", unit: unit.id, detail: prLookup.error };
  }
  const pr = prLookup.value;
  if (pr === null) {
    try { git(arenaDir, ["fetch", "-q", "origin", baseBranch]); } catch { /* offline; the check below decides */ }
    // Ask git, before deleting the evidence. A PR closed without merging reaches this
    // branch identically to a merged one, and calling that "merged" writes a landed row
    // for code that is not on the base.
    if (!landedOnBase(arenaDir, branch, baseBranch)) {
      const reason = `${branch} is not on origin/${baseBranch} — the PR is gone but the code never landed`;
      flipStatus(arenaDir, join("work", `${unit.id}.md`), "escalated", `doctrine: park ${unit.id} (PR gone, nothing landed)`);
      // The round is still billed. The money was spent whether or not the work landed,
      // and an escalated unit is nobody's retry, so this is its only chance to reach the
      // gate. `escalated` keeps it out of `failedAttempts`, which counts only failures.
      appendUnitMetric(arenaDir, {
        unit: unit.id, outcome: "escalated",
        time_to_verified_done_s: (Date.now() - startedMs) / 1000,
        spend_usd: unbilledRoundSpend(arenaDir, unit.id),
        attempts: failedAttempts(arenaDir, unit.id).count + 1,
        reworked: failedAttempts(arenaDir, unit.id).count > 0,
        detail: reason,
      });
      appendTick(arenaDir, { decision: "parked", unit: unit.id, detail: reason });
      return { decision: "parked", unit: unit.id, detail: reason };
    }
    try {
      git(arenaDir, ["merge", "--ff-only", `origin/${baseBranch}`]);
      git(arenaDir, ["branch", "-D", branch]);
    } catch { /* reaped next tick */ }
    flipStatus(arenaDir, join("work", `${unit.id}.md`), "merged", `doctrine: ${unit.id} settled (PR no longer open)`);
    settleWithoutLanding(arenaDir, unit, startedMs);
    appendTick(arenaDir, { decision: "review-settled-merged", unit: unit.id, detail: "no open PR for the branch" });
    return { decision: "review-settled-merged", unit: unit.id };
  }

  const slug = repoSlug(gh, arenaDir);
  if (slug === null) {
    appendTick(arenaDir, { decision: "no-op-review-repo-unknown", unit: unit.id });
    return { decision: "no-op-review-repo-unknown", unit: unit.id };
  }

  const threads = fetchThreads(gh, slug, pr.number, arenaDir, manifest.review?.self_login);
  if (!threads.looked) {
    // Same rule: "the query failed" must never read as "there are no findings", which
    // would merge unreviewed code the moment the window elapsed.
    appendTick(arenaDir, { decision: "no-op-review-lookup-failed", unit: unit.id, detail: threads.error });
    return { decision: "no-op-review-lookup-failed", unit: unit.id, detail: threads.error };
  }
  const open = unresolved(threads.value);
  const elapsed = reviewWindowElapsed(pr, Date.now(), windowMs);

  if (open.length === 0) {
    if (!elapsed) {
      appendTick(arenaDir, { decision: "no-op-review-window", unit: unit.id, detail: pr.url });
      return { decision: "no-op-review-window", unit: unit.id, detail: pr.url };
    }
    // No unresolved findings is not the same as judged. If a review fix changed code and
    // no judge has ruled since — an outage during the re-judge is how that happens — this
    // is the moment the loop would merge work nothing verified. Judge it instead; the
    // merge is one tick later and costs a judge run, which is the correct price.
    const owedFrom = amendmentAwaitsJudge(arenaDir, unit.id);
    if (owedFrom !== null) {
      const rejudgeDir = join(arenaDir, ".doctrine", "runs", `rejudge-${unit.id}-${Date.now()}`);
      const headSha = git(arenaDir, ["rev-parse", branch]);
      const baseSha = git(arenaDir, ["merge-base", baseBranch, branch]);
      const headDir = join(rejudgeDir, "head");
      mkdirSync(rejudgeDir, { recursive: true });
      git(arenaDir, ["worktree", "add", "--detach", headDir, headSha]);
      appendTick(arenaDir, {
        decision: "re-judge-owed", unit: unit.id,
        detail: "a review fix changed code and no judge has ruled on it since; judging before any merge",
      });
      return judgeAndLand(
        deps, manifest, unit, branch, baseSha, headSha, headDir, 0, startedMs, true,
        owedFrom === "" ? undefined : owedFrom,
      );
    }
    const landed = mergeOpenPr({
      arenaDir, baseBranch, unit, branch,
      note: "no unresolved review findings within the window",
      ...(deps.runGh !== undefined ? { runGh: deps.runGh } : {}),
    });
    return settleMerge(arenaDir, unit, landed, startedMs);
  }

  const rounds = reviewRounds(arenaDir, unit.id);
  if (rounds >= maxRounds) {
    // Review is an instrument, never a gate: merge, and hand what is still open to
    // intake as a maintenance unit rather than losing it or stalling on it.
    recordUnaddressed(arenaDir, branch, unit, open, pr.url);
    for (const t of open) {
      replyToThread(gh, slug, pr.number, t.commentId,
        `Doctrine merged this unit after ${rounds} review round(s) without addressing this thread. Review is an instrument here, never a gate — a reviewer who can hold the loop indefinitely would be an approver, and this loop has none. The finding is recorded in \`context/review-findings/${unit.id}.md\` and enters intake as a maintenance unit; it is not lost, it is queued.`,
        arenaDir);
    }
    const landed = mergeOpenPr({
      arenaDir, baseBranch, unit, branch,
      note: `${open.length} review finding(s) carried to intake after ${rounds} round(s)`,
      ...(deps.runGh !== undefined ? { runGh: deps.runGh } : {}),
    });
    return settleMerge(arenaDir, unit, landed, startedMs);
  }

  const fixerDef = deps.agentDefs.reviewFixer;
  if (fixerDef === undefined) {
    appendTick(arenaDir, { decision: "no-op-review-no-fixer", unit: unit.id, detail: `${open.length} finding(s) and no review-fixer agent configured` });
    return { decision: "no-op-review-no-fixer", unit: unit.id };
  }

  const runDir = join(arenaDir, ".doctrine", "runs", `review-${unit.id}-${Date.now()}`);
  mkdirSync(runDir, { recursive: true });
  const fixDir = join(runDir, "fix");
  const denyPath = writeDenySettings(arenaDir, manifest, { extraDeny: REVIEW_FIX_DENY, fileName: "claude-deny-review-fix.json" });

  // The branch tip before the fixer touched it. The review-fix guardrail is about the
  // delta from here, not about the whole branch.
  const preFixSha = git(arenaDir, ["rev-parse", branch]);
  const fix = await runFixPass({
    unit, arenaDir, branch, worktreeDir: fixDir,
    findings: formatThreads(open), source: "review",
    ...(manifest.setup !== undefined ? { setup: manifest.setup } : {}),
    logPath: join(runDir, "review-fix.log"),
    agentDefinitionPath: fixerDef,
    settingsPath: denyPath,
    ...(deps.runAgent !== undefined ? { runAgent: deps.runAgent } : {}),
  });
  removeWorktree(arenaDir, fixDir);

  if (fix.kind === "failed") {
    // Put the branch back where the judge left it. A fixer that times out or is
    // budget-truncated can already have committed — and leaving that tip in place makes
    // it the NEXT attempt's `preFixSha`, so a forbidden `work/` or contract edit sits
    // before the guardrail's window and is never asked about again. Narrowing the
    // review-fix scope is what made a contaminated baseline dangerous; this is the other
    // half of that change (doctrine#26 review).
    //
    // `branch -f` rather than `reset --hard`: the arena is checked out on the base
    // branch, and nothing about the working tree should move. Nothing was pushed on a
    // failed attempt, so local and origin agree again afterwards.
    try {
      git(arenaDir, ["branch", "-f", branch, preFixSha]);
    } catch { /* the branch is gone; rung 0 reaps and the unit resumes from its artifacts */ }
    appendTick(arenaDir, { decision: "review-fix-failed", unit: unit.id, detail: fix.detail });
    return { decision: "review-fix-failed", unit: unit.id, detail: fix.detail };
  }

  for (const t of open) {
    if (replyToThread(gh, slug, pr.number, t.commentId, reviewReply(fix.kind, fix.answer), arenaDir)) {
      resolveThread(gh, t.threadId, arenaDir);
    }
  }

  // Before the push and before any re-judge: every path below this can still reap the
  // branch, and the threads are already resolved.
  recordDeferred(arenaDir, baseBranch, unit, fix.deferred, pr.url);

  if (fix.kind === "no-change") {
    // An argued refusal is a legitimate outcome — nothing to re-judge, so the unit
    // merges on the next tick once the threads are resolved.
    appendTick(arenaDir, { decision: "review-fixed", unit: unit.id, spend_usd: fix.spendUsd, detail: "answered without a code change" });
    return { decision: "review-fixed", unit: unit.id, detail: "answered without a code change" };
  }

  // The amended branch is unreviewed code until the judge says otherwise: push it and
  // re-judge on the next tick through the same rung that judged it the first time.
  try {
    git(arenaDir, ["push", "-q", "origin", branch]);
  } catch { /* the next tick retries */ }
  // `pre_fix_sha` travels with the tick because a re-judge may have to happen on a LATER
  // tick, in a later process, and the review-fix guardrail is the delta from here. Held
  // only in memory it would be gone by then, and the retry would judge the amendment with
  // the guardrail silently skipped.
  appendTick(arenaDir, {
    decision: "review-fixed", unit: unit.id, spend_usd: fix.spendUsd,
    detail: `${open.length} finding(s) addressed at ${fix.headSha.slice(0, 8)}`,
    pre_fix_sha: preFixSha,
  });

  const baseSha = git(arenaDir, ["merge-base", baseBranch, branch]);

  const headDir = join(runDir, "head");
  git(arenaDir, ["worktree", "add", "--detach", headDir, fix.headSha]);
  return judgeAndLand(deps, manifest, unit, branch, baseSha, fix.headSha, headDir, fix.spendUsd, startedMs, true, preFixSha);
}

function reviewReply(kind: "fixed" | "no-change", commitMessage: string): string {
  const head = kind === "fixed"
    ? "Addressed on this branch by Doctrine's review-fix pass, and the amended diff goes back through the same code-judge before it can merge."
    : "Answered without a code change by Doctrine's review-fix pass.";
  return `${head}\n\n${commitMessage.trim()}`;
}

/**
 * A review fix landed on the branch and no judge has ruled on it since.
 *
 * The hole this closes lets UNJUDGED CODE MERGE, which is the one thing the loop must
 * never do. After a code-changing review fix, `judgeAndLand` runs; if it hits an API
 * outage it keeps the branch and returns, having written no verdict. The unit's own file
 * on that branch still says `in-review`, and the fixer has already resolved the threads —
 * so the next tick's review rung finds nothing unresolved, sees the window elapsed, and
 * merges an amendment no judge ever looked at. Both judges have this shape: the code-judge
 * outage and the design-judge outage are different call sites reaching the same state.
 *
 * The signal is two decisions the engine writes in this exact path, not a list of names
 * that someone must remember to extend. `pr-opened` is written every time `judgeAndLand`
 * rules favourably and republishes the branch — including on a re-judge — so a
 * code-changing `review-fixed` newer than the last `pr-opened` means no judge has ruled
 * since. Every UNfavourable ruling reaps the branch, so it cannot be this one.
 *
 * Returns the sha the guardrail is measured from, or null when nothing is owed. An
 * unreadable ledger answers "owed", because stalling is caught by the failure halt and
 * merging unjudged code is caught by nobody.
 */
function amendmentAwaitsJudge(arenaDir: string, unitId: string): string | null {
  let fixedAt = "";
  let preFixSha = "";
  let judgedAt = "";
  try {
    for (const r of readJsonlObjects(join(arenaDir, ".doctrine", "ticks.jsonl"))) {
      if (r["unit"] !== unitId) continue;
      const at = String(r["at"] ?? "");
      const decision = String(r["decision"] ?? "");
      if (decision === "review-fixed" && String(r["detail"] ?? "").includes("addressed at ")) {
        fixedAt = at;
        preFixSha = String(r["pre_fix_sha"] ?? "");
      } else if (decision === "pr-opened") {
        judgedAt = at;
      }
    }
  } catch {
    return "";
  }
  if (fixedAt === "" || fixedAt <= judgedAt) return null;
  return preFixSha;
}

/**
 * A finding the fixer answered rather than fixed, recorded where intake can find it.
 *
 * `recordUnaddressed` below covers only threads still OPEN at round exhaustion. A
 * reasoned refusal is the other shape and it fell through: the fixer replies, resolves
 * the thread, and the finding is closed on GitHub while nothing in the repo remembers
 * it. On one PR that lost a correct report that `npm start` would die because
 * tsc does not copy `.sql` files into `dist/` — argued as belonging to a unit that does
 * not exist yet, which was right, and then filed by nobody.
 *
 * The fixer cannot file it itself: `work/**` is denied to that ACT so a finding can
 * never re-plan. That denial is correct, and this is its other half.
 */
function recordDeferred(arenaDir: string, baseBranch: string, unit: WorkUnit, deferred: readonly string[], prUrl: string): void {
  if (deferred.length === 0) return;
  try {
    // The BASE branch, not the unit's. Written on the unit branch this was one reap
    // away from being lost all over again: the amended branch still has to survive
    // re-judgement, `judgeAndLand` reaps it on a failing verdict, and the GitHub threads
    // are already resolved by then — so the record would go with the branch and the
    // finding would be closed everywhere (doctrine#28 review).
    //
    // The base is the only place that outlives every failure path this unit still has
    // in front of it. It is also where intake reads, and the tick's own base sync
    // pushes it, so it needs no separate delivery.
    git(arenaDir, ["checkout", "-q", baseBranch]);
    const dir = join(arenaDir, "context", "review-findings");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${unit.id}-deferred.md`);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : `# Deferred review findings — ${unit.id}\n`;
    writeFileSync(
      path,
      `${existing}\n## ${new Date().toISOString()} — ${prUrl}\n\n` +
      `Declared by a correction pass as something it could not honestly fix on this\n` +
      `branch — either the finding is mistaken, or it is real and belongs to work this\n` +
      `unit was not asked to do. Each is a maintenance unit for intake, not\n` +
      `a thing that was declined.\n\n` +
      deferred.map((d) => `- ${d}`).join("\n") + "\n",
    );
    stagePaths(arenaDir, [join("context", "review-findings")]);
    engineCommit(arenaDir, `doctrine: record ${deferred.length} deferred review finding(s) for ${unit.id}`);
  } catch { /* best effort — never block the merge on bookkeeping */ }
}

/** Unaddressed findings become an intake artifact on the branch, not a lost comment. */
function recordUnaddressed(arenaDir: string, branch: string, unit: WorkUnit, open: readonly ReviewThread[], prUrl: string): void {
  try {
    git(arenaDir, ["checkout", "-q", branch]);
    const dir = join(arenaDir, "context", "review-findings");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${unit.id}.md`),
      `# Unaddressed review findings — ${unit.id}\n\n` +
      `From ${prUrl}, merged with these open after the configured review rounds. Review is an\n` +
      `instrument, never a gate; these enter intake as maintenance units.\n\n` +
      open.map((t) => `## ${t.path}${t.line === null ? "" : `:${t.line}`} — ${t.author}\n\n${t.body.trim()}\n`).join("\n"),
    );
    stagePaths(arenaDir, [join("context", "review-findings")]);
    engineCommit(arenaDir, `doctrine: record ${open.length} unaddressed review finding(s) for ${unit.id}`);
  } catch { /* best effort — never block the merge on bookkeeping */ }
}

/**
 * A unit that settled without this tick landing it still has to reach the ledger.
 *
 * Both recovery branches below mark a merged unit merged and return: the branch is gone
 * because a tick died between the remote merge and the local sync, or because a person
 * merged the PR. Neither wrote a unit metric, so the unit was absent from
 * metrics.jsonl entirely — no row at all, and with it the whole `pr-opened` spend of a
 * unit that PASSED, permanently invisible to the daily gate. #32 closed that hole on
 * the path the loop normally takes and left it open on the two it takes when something
 * went sideways, which are exactly the moments nobody is watching the number.
 */
/**
 * Did this branch's work actually reach the base, or is the PR merely gone?
 *
 * "No open PR" and "merged" are not the same fact. A PR closed WITHOUT merging looks
 * identical from `findOpenPr`, and so does a `gh` call that came back empty for a
 * reason nobody checked. Reading either as a merge writes an `outcome: "merged"` row
 * for code that is not on the base — corrupting the one ledger the daily gate and every
 * later report read, and advancing `unbilledRoundSpend`'s cutoff past a round that
 * never landed.
 *
 * Asked of git rather than of GitHub on purpose: the commits being ancestors of the
 * fetched base IS the merge, whereas a PR's state is a claim about it.
 */
function landedOnBase(arenaDir: string, branch: string, baseBranch: string): boolean {
  try {
    git(arenaDir, ["merge-base", "--is-ancestor", branch, `origin/${baseBranch}`]);
    return true;
  } catch {
    return false;
  }
}

function settleWithoutLanding(arenaDir: string, unit: WorkUnit, startedMs: number): void {
  appendUnitMetric(arenaDir, {
    unit: unit.id, outcome: "merged",
    time_to_verified_done_s: (Date.now() - startedMs) / 1000,
    spend_usd: unbilledRoundSpend(arenaDir, unit.id),
    attempts: failedAttempts(arenaDir, unit.id).count + 1,
    reworked: failedAttempts(arenaDir, unit.id).count > 0,
  });
}

function settleMerge(arenaDir: string, unit: WorkUnit, landed: ReturnType<typeof mergeOpenPr>, startedMs: number): TickResult {
  if (!landed.landed) {
    appendTick(arenaDir, { decision: "parked", unit: unit.id, detail: landed.reason });
    flipStatus(arenaDir, join("work", `${unit.id}.md`), "escalated", `doctrine: park ${unit.id} (${landed.reason.slice(0, 60)})`);
    return { decision: "parked", unit: unit.id, detail: landed.reason };
  }
  appendUnitMetric(arenaDir, {
    unit: unit.id, outcome: "merged",
    time_to_verified_done_s: (Date.now() - startedMs) / 1000,
    // NOT zero. This tick did not pay, but the unit did — on the earlier tick that
    // judged it and opened the PR. The daily gate reads metrics.jsonl alone, so a zero
    // here hides the entire cost of every unit that passes (see
    // unitSpendSinceLastMetric).
    spend_usd: unbilledRoundSpend(arenaDir, unit.id),
    attempts: failedAttempts(arenaDir, unit.id).count + 1,
    reworked: failedAttempts(arenaDir, unit.id).count > 0,
  });
  appendTick(arenaDir, { decision: "landed", unit: unit.id });
  return { decision: "landed", unit: unit.id };
}

/** Judge an implemented branch and land it on pass. Shared by fresh and resumed work. */
async function judgeAndLand(
  deps: TickDeps,
  manifest: Manifest,
  unit: WorkUnit,
  branch: string,
  baseSha: string,
  headSha: string,
  headDir: string,
  implementSpendUsd: number,
  startedMs: number,
  reviewFixPass = false,
  /** The branch tip BEFORE the review-fix ACT ran — the scope its rules are judged on. */
  reviewFixFromSha: string | undefined = undefined,
): Promise<TickResult> {
  const arenaDir = deps.arenaDir;
  const runDir = join(arenaDir, ".doctrine", "runs", `${unit.id}-${Date.now()}`);
  mkdirSync(runDir, { recursive: true });

  const baseDir = join(runDir, "base");
  git(arenaDir, ["worktree", "add", "--detach", baseDir, baseSha]);
  const diffPath = join(runDir, "diff.patch");
  // On a RE-judge only, the engine's own bookkeeping comes out of the diff it grades.
  //
  // `openUnitPr` flips the unit file to `in-review`, appends to `context/decisions.md`, and — when
  // the unit has a prior failed attempt — writes `context/defects/<date>-<unit>.md`, committing all
  // of it on the unit's own branch. The FIRST judge cannot see any of that; it does not exist yet.
  // The re-judge after a review fix does, and on 2026-09-07 the code judge failed
  // u-2026-09-05-invoice-draft on `coherence: contamination` for a decisions.md line the unit did
  // not author. It was right to; the engine should not hand its own commits to a judge whose job is
  // spotting changes that do not belong.
  //
  // Scoped to the re-judge because the first judge is where an ACTOR's edit to these paths would
  // show up, and hiding it there would trade a false positive for a blind spot — the judge's scope
  // check is the only thing reading that artefact. A review-fixer authoring them is caught
  // separately and mechanically: GUARDED_FROM_REVIEW_FIX now names them, and that check runs on the
  // fixer's OWN delta rather than the branch, so it accuses the actor and never the engine.
  const engineWritten = [
    `:(exclude)work/${unit.id}.md`,
    ":(exclude)context/decisions.md",
    ":(exclude)context/defects",
    ":(exclude)context/review-findings",
  ];
  writeFileSync(diffPath, execFileSync("git", [
    "diff", baseSha, headSha, ...(reviewFixPass ? ["--", ".", ...engineWritten] : []),
  ], { cwd: arenaDir, encoding: "utf8" }));

  // Guardrails, checked on the artefact. Deny rules match command text, and a path is
  // not resolved until the shell runs it — `cd .doctrine && sed -i manifest.json`
  // names no denied string, and a worktree carries its own tracked copy of the
  // manifest besides. So the diff decides. Before any judge is paid to read it.
  const changed = execFileSync("git", ["diff", "--name-only", baseSha, headSha], { cwd: arenaDir, encoding: "utf8" })
    .split(/\r?\n/);
  // The UI admissibility rule, enforced on the artefact rather than on a claim:
  // a unit is "UI-touching" if its diff touches UI, and a target without a design
  // contract and a way to render its screens cannot judge that. Better to refuse the
  // change than to land a screen nothing will ever look at.
  const uiFiles = changed.filter((f) => isUiFile(f));
  // The rule asks for a design contract AND a mechanical conformance gate. A `design` block
  // alone proves the first: it names a contract and a way to render screens, and says
  // nothing about whether anything greps for off-token values. Both, or no UI here.
  const designGate = Object.keys(manifest.gates ?? {}).some((g) => /design|conformance/i.test(g));
  if (uiFiles.length > 0 && (manifest.design === undefined || !designGate)) {
    const missing = manifest.design === undefined ? "no design block (contract + screens)" : "no design/conformance gate in the manifest";
    const detail = `unit touches UI (${uiFiles.slice(0, 4).join(", ")}) and this target has ${missing} — a design contract AND a mechanical gate are required before any UI unit lands`;
    removeWorktree(arenaDir, baseDir);
    removeWorktree(arenaDir, headDir);
    appendTick(arenaDir, { decision: "ui-inadmissible", unit: unit.id, detail });
    flipStatus(arenaDir, join("work", `${unit.id}.md`), "escalated", `doctrine: park ${unit.id} (UI without a design stack)`);
    return { decision: "ui-inadmissible", unit: unit.id, detail };
  }

  // Engine-owned paths: the whole branch, because nobody may touch them. The review-fix
  // rules: only what the review-fix ACT actually added, because the branch also carries
  // the implementer's legitimate contract addition and status flip, and judging those by
  // the review-fixer's rules parks a unit for work it was allowed to do.
  const breaches = [
    ...guardrailBreaches(changed, {}),
    ...(reviewFixPass && reviewFixFromSha !== undefined
      ? guardrailBreaches(
          execFileSync("git", ["diff", "--name-only", reviewFixFromSha, headSha], { cwd: arenaDir, encoding: "utf8" }).split(/\r?\n/),
          { reviewFix: true, engineOwned: false },
        )
      : []),
  ];
  if (breaches.length > 0) {
    const detail = `unit diff touches guarded paths: ${describeBreaches(breaches)}`;
    removeWorktree(arenaDir, baseDir);
    removeWorktree(arenaDir, headDir);
    appendTick(arenaDir, { decision: "guardrail-breach", unit: unit.id, detail });
    flipStatus(arenaDir, join("work", `${unit.id}.md`), "escalated", `doctrine: park ${unit.id} (guardrail breach)`);
    return { decision: "guardrail-breach", unit: unit.id, detail };
  }

  try {
    runSetup(manifest.setup, [baseDir, headDir]);

    // --- the FREE half, before anything is paid ---
    //
    // The target's own gates and the unit's own evidence, run by the engine. `gates` had
    // been documentary since onboarding: the UI admissibility check read its KEYS to decide
    // whether a design gate existed and nothing ever ran the command. A declared gate nobody
    // runs is a comment.
    //
    // It runs first for the reason the lint runs before the judge on every other rung:
    // it costs nothing and it decides the questions a reader is worst at. A typecheck
    // failure is not a matter of opinion, and a judge paid to discover it is a judge
    // paid to do arithmetic.
    const checksBefore = runUnitChecks(headDir, unit, manifest.gates, join(runDir, "checks"));

    const { verdictPath, logPath } = judgePaths(runDir);
    const denyPath = writeDenySettings(arenaDir, manifest);
    const judgeDeps: Parameters<typeof runJudge>[0] = {
      unit, baseDir, headDir, baseSha, headSha, diffPath, verdictPath, logPath,
      requiredGates: ["diff-read", "evidence-executed"],
      budgetUsd: unit.budgetUsd,
      agentDefinitionPath: deps.agentDefs.judge,
      settingsPath: denyPath,
      ...(deps.runAgent !== undefined ? { runAgent: deps.runAgent } : {}),
    };
    const outcome = await runJudge(judgeDeps);

    if (outcome.kind === "failed") {
      if (outcome.outage) {
        // The judge never ran ($0 API outage). KEEP the branch — the implemented work
        // is preserved and rung 0 re-judges it next tick at no implement cost.
        appendTick(arenaDir, { decision: "no-op-outage", unit: unit.id, detail: "judge run hit an API outage; branch kept for resume" });
        return { decision: "no-op-outage", unit: unit.id };
      }
      appendTick(arenaDir, { decision: "judge-failed", unit: unit.id, detail: `${outcome.reason}: ${outcome.errors.join("; ")}` });
      appendUnitMetric(arenaDir, {
        unit: unit.id, outcome: "failed",
        time_to_verified_done_s: (Date.now() - startedMs) / 1000,
        // Plus any round that opened a PR and was never billed — on a re-judge after a
        // review fix, that is the original implement-and-judge cost, and advancing the
        // cutoff past it without carrying it would lose it for good.
        spend_usd: implementSpendUsd + unbilledRoundSpend(arenaDir, unit.id),
        attempts: failedAttempts(arenaDir, unit.id).count + 1, reworked: true,
        instrument: true,
        // Same guard as the design branch below: an unbounded error list reaches every
        // later attempt's prompt through `failedAttempts`.
        detail: `judge could not run: ${outcome.reason}: ${outcome.errors.join("; ").slice(0, 4000)}`,
      });
      reapBranch(arenaDir, branch, [headDir, baseDir]);
      return { decision: "judge-failed", unit: unit.id, detail: outcome.reason };
    }

    const v = outcome.verdict;

    // --- `escalate` is answered before anything else is paid ---
    //
    // It says the UNIT SPEC is the defect: evidence no implementation could satisfy,
    // criteria that contradict each other. No edit to the diff resolves that, because the
    // fault is one rung up — so the unit parks and the intent-grade's gap decompose picks
    // it up.
    //
    // It has to come FIRST, ahead of the design judge below. A UI-touching unit whose code
    // judge escalated was still paying for a design judgement on a diff nothing can fix —
    // and worse, a design outage or a malformed design verdict returned
    // `design-judge-failed`, which MASKS the escalation: the unit burns another attempt
    // instead of parking, and the one artifact that says what is wrong with its spec never
    // reaches the planner. Found in review on 2026-09-13.
    if (outcome.verdict.verdict === "escalate") {
      const ev = outcome.verdict;
      appendTick(arenaDir, { decision: "verdict-escalate", unit: unit.id });
      appendUnitMetric(arenaDir, {
        unit: unit.id, outcome: "escalated",
        time_to_verified_done_s: (Date.now() - startedMs) / 1000,
        spend_usd: implementSpendUsd + ev.spend_usd + unbilledRoundSpend(arenaDir, unit.id),
        attempts: failedAttempts(arenaDir, unit.id).count + 1, reworked: true,
        detail: judgeFailureDetail(ev, unit),
      });
      reapBranch(arenaDir, branch, [headDir, baseDir]);
      flipStatus(arenaDir, join("work", `${unit.id}.md`), "escalated", `doctrine: escalate ${unit.id} (judge: escalate)`);
      return { decision: "verdict-escalate", unit: unit.id };
    }

    // The design-judge, on any diff that touched UI. It runs AFTER the code-judge
    // because a screen that does not work is not a design problem, and BEFORE landing
    // because the conformance gate only proves no raw value escaped the token file —
    // it cannot tell a considered layout from a generated one, and nothing else will.
    let designSpendUsd = 0;
    let designFindings: string[] = [];
    const designJudgeDef = deps.agentDefs.designJudge;
    if (uiFiles.length > 0 && manifest.design !== undefined && designJudgeDef !== undefined) {
      // Establish whether there IS a baseline, here, by running the capture command in
      // the base worktree. Never by asking the judge: "the baseline is legitimately
      // empty" and "the judge skipped the baseline render" are indistinguishable from
      // inside a verdict, and only the first may relax the gate.
      // "broken" deliberately does NOT relax anything: the judge renders the base, fails
      // to, and refuses the verdict — which is the right answer for a base that cannot
      // be captured.
      const baselineEmpty = baselineState(baseDir, manifest.design) === "empty";
      const dj = await runDesignJudge({
        headDir,
        baseDir,
        baselineEmpty,
        design: manifest.design,
        verdictPath: join(runDir, "design-verdict.json"),
        logPath: join(runDir, "design-judge.log"),
        budgetUsd: Math.max(3, unit.budgetUsd / 2),
        agentDefinitionPath: designJudgeDef,
        settingsPath: denyPath,
        ...(deps.runAgent !== undefined ? { runAgent: deps.runAgent } : {}),
      });
      // An API outage is not a design verdict. The code-judge keeps the branch for a
      // free re-judge next tick; so must this, or repeated $0 outages burn the unit's
      // attempts and escalate finished work that was never actually looked at.
      if (dj.kind === "failed" && dj.outage) {
        appendTick(arenaDir, { decision: "no-op-outage", unit: unit.id, detail: "design-judge hit an API outage; branch kept for resume" });
        return { decision: "no-op-outage", unit: unit.id };
      }
      if (dj.kind === "failed") {
        // The judge's OWN output failed — a malformed or missing verdict, a spawn that
        // died, a base worktree that rendered nothing. Not a finding: there is nothing in
        // the diff a correction pass could change in response, which is the same rule the
        // code-judge path above applies and the narrowing and intent rungs apply too.
        //
        // Two strings, because they have two readers. `summary` is one line for the tick
        // log and the console; `retryDetail` is what the next attempt reads.
        const summary = `design-judge ${dj.reason}: ${dj.errors.join("; ").slice(0, 240)}`;
        // Capped, because `validateDesignVerdict` emits up to four errors PER malformed
        // finding, so a pathological verdict produces an unbounded list — and this string
        // is copied verbatim into every later attempt's prompt. A schema error is one
        // short line, so 4000 carries dozens of them; it clips nothing real.
        const retryDetail = `design-judge ${dj.reason}: ${dj.errors.join("; ").slice(0, 4000)}`;
        appendUnitMetric(arenaDir, {
          unit: unit.id, outcome: "failed",
          time_to_verified_done_s: (Date.now() - startedMs) / 1000,
          spend_usd: implementSpendUsd + v.spend_usd + dj.spendUsd + unbilledRoundSpend(arenaDir, unit.id),
          attempts: failedAttempts(arenaDir, unit.id).count + 1, reworked: true,
          // Only a failure of the judge's OWN output is the instrument: a malformed or missing
          // verdict, a spawn that died, a base worktree that rendered nothing. A HEAD that rendered
          // nothing is the unit's — its change broke the app or dropped the screen from the
          // register — and marking that would hide an actionable failure from the retry AND refund
          // the budget, so the same broken change could be re-created until the floor.
          ...(dj.kind === "failed" && dj.reason !== "no-screens-head" ? { instrument: true } : {}),
          detail: retryDetail.length === 0 ? "" : `design-judge: ${retryDetail}`,
        });
        appendTick(arenaDir, { decision: "design-judge-failed", unit: unit.id, detail: summary, spend_usd: dj.spendUsd });
        reapBranch(arenaDir, branch, [headDir, baseDir]);
        return { decision: "design-judge-failed", unit: unit.id, detail: summary };
      }
      if (dj.verdict.verdict !== "pass") {
        // FINDINGS, not a refusal. This is where the money was: eight of twenty-one
        // failures on one target were design findings on a real diff, $174 of $271
        // wasted, and the branch was deleted every time. The `priorFailures` docstring
        // records what the re-roll bought — "five design findings fixed by chance, five
        // new ones introduced, and the two structural ones untouched both times".
        designFindings = designFindingList(dj.verdict).map((f) => `design: ${f}`);
        // THE CORRECTED SCREENS ARE NOT RE-RENDERED OR RE-JUDGED, and that is the
        // deliberate trade rather than an oversight. A second design-judge pass is the
        // unbounded loop this rung was moved off, at roughly five dollars a turn and
        // with a fresh chance to find something new every time.
        //
        // What does re-run on the corrected tree is the mechanical design gate: a
        // conformance gate is required alongside the contract, it lives in
        // `manifest.gates`, and the free re-check runs every gate. So "no raw value
        // escaped the token file" is re-proved on what actually lands; "this layout was
        // considered rather than generated" is not. The external review round is the
        // next thing that looks at it, and a design regression the fixer introduced is
        // exactly what a reviewer sees.
        appendTick(arenaDir, { decision: "design-verdict-findings", unit: unit.id, detail: designFailureSummary(dj.verdict), spend_usd: dj.spendUsd });
      } else {
        appendTick(arenaDir, { decision: "design-verdict-pass", unit: unit.id, spend_usd: dj.spendUsd });
      }
      // The daily spend gate reads metrics.jsonl only, and the landing metric below
      // carries implementer + code-judge spend. Without this, every design judgement is
      // invisible to the budget — and UI units are the expensive ones.
      designSpendUsd = dj.spendUsd;
    }

    // --- everything wrong with this diff, gathered ONCE ---
    //
    // Free findings and paid findings into one list, so a single correction pass is
    // handed the complete picture. Two rounds for two kinds of finding would be the loop
    // this rung was moved off.
    const judged = verdictFindings(v, unit);
    const findings = [...checksBefore.findings, ...judged.findings, ...designFindings];

    // A judge that refused and named nothing has not reported. There is nothing in the
    // diff for a fixer to change in response, so it fails the RUN and buys another judge
    // — the same rule the narrowing and intent rungs apply, in the same words.
    if (judged.unreported.length > 0) {
      appendTick(arenaDir, { decision: "judge-failed", unit: unit.id, detail: judged.unreported.join("; ") });
      appendUnitMetric(arenaDir, {
        unit: unit.id, outcome: "failed",
        time_to_verified_done_s: (Date.now() - startedMs) / 1000,
        spend_usd: implementSpendUsd + v.spend_usd + unbilledRoundSpend(arenaDir, unit.id),
        attempts: failedAttempts(arenaDir, unit.id).count + 1, reworked: true,
        instrument: true,
        detail: judged.unreported.join("; "),
      });
      reapBranch(arenaDir, branch, [headDir, baseDir]);
      return { decision: "judge-failed", unit: unit.id, detail: judged.unreported.join("; ") };
    }

    // --- one correction pass, on the branch that has the work ---
    let fixSpendUsd = 0;
    let deferred: string[] = [];
    if (findings.length > 0) {
      const unitFixer = deps.agentDefs.unitFixer;
      if (unitFixer === undefined) {
        // No fixer configured: the old behaviour, and it must stay reachable rather than
        // silently landing a diff with known findings.
        appendTick(arenaDir, { decision: "verdict-fail", unit: unit.id, detail: `${findings.length} finding(s) and no unit-fixer agent configured` });
        appendUnitMetric(arenaDir, {
          unit: unit.id, outcome: "failed",
          time_to_verified_done_s: (Date.now() - startedMs) / 1000,
          spend_usd: implementSpendUsd + v.spend_usd + unbilledRoundSpend(arenaDir, unit.id),
          attempts: failedAttempts(arenaDir, unit.id).count + 1, reworked: true,
          detail: findings.join(NEWLINE + NEWLINE),
        });
        reapBranch(arenaDir, branch, [headDir, baseDir]);
        return { decision: "verdict-fail", unit: unit.id };
      }

      const fixDir = join(runDir, "unit-fix");
      // Release the head worktree FIRST. On the implement path it is the implementer's
      // own checkout and it is ON the branch, so `git worktree add <dir> <branch>` for
      // the fixer fails with "already checked out" — which is how this was found, by the
      // first test that ever executed this path. Everything that needed it has run: the
      // free checks, the code-judge and the design-judge are all above this line, and the
      // post-correction checks run in the FIX worktree. `removeWorktree` is idempotent,
      // so the later release before landing stays harmless.
      removeWorktree(arenaDir, headDir);
      const preFix = git(arenaDir, ["rev-parse", branch]);
      const fix = await runFixPass({
        unit, arenaDir, branch, worktreeDir: fixDir, findings, source: "judge",
        ...(manifest.setup !== undefined ? { setup: manifest.setup } : {}),
        logPath: join(runDir, "unit-fix.log"),
        agentDefinitionPath: unitFixer,
        settingsPath: writeDenySettings(arenaDir, manifest, { extraDeny: REVIEW_FIX_DENY, fileName: "claude-deny-unit-fix.json" }),
        ...(deps.runAgent !== undefined ? { runAgent: deps.runAgent } : {}),
      });
      fixSpendUsd = fix.kind === "failed" ? 0 : fix.spendUsd;

      if (fix.kind === "failed") {
        // An outage keeps the branch, exactly as the judge's does: the implemented work
        // and the judge's findings both survive, and next tick resumes at no new cost.
        if (fix.outage) {
          appendTick(arenaDir, { decision: "no-op-outage", unit: unit.id, detail: "unit-fix hit an API outage; branch kept for resume" });
          return { decision: "no-op-outage", unit: unit.id };
        }
        appendTick(arenaDir, { decision: "unit-fix-failed", unit: unit.id, detail: fix.detail });
        appendUnitMetric(arenaDir, {
          unit: unit.id, outcome: "failed",
          time_to_verified_done_s: (Date.now() - startedMs) / 1000,
          spend_usd: implementSpendUsd + v.spend_usd + unbilledRoundSpend(arenaDir, unit.id),
          attempts: failedAttempts(arenaDir, unit.id).count + 1, reworked: true,
          instrument: true,
          detail: `the correction pass ${fix.reason}: ${fix.detail}`,
        });
        reapBranch(arenaDir, branch, [headDir, baseDir]);
        return { decision: "unit-fix-failed", unit: unit.id, detail: fix.detail };
      }

      deferred = fix.deferred;

      // A pass that changed NOTHING and declared nothing may not land.
      //
      // This is the guard the narrowing and intent rungs already have — "the correction
      // pass changed nothing, with N finding(s) outstanding" — and it was omitted here,
      // which is the sibling divergence this session has now paid for seven times.
      //
      // It matters most in the case the free checks cannot see. When the findings are
      // COHERENCE or DESIGN, the gates and evidence were already green before the fixer
      // ran and are still green after it; the post-check goes green, every finding is
      // recorded as "corrected", and a known-bad diff lands. The free half is what
      // verifies a mechanical finding — nothing verifies a semantic one, which is exactly
      // why a judge was needed for it, so the pass's own declaration is the only evidence
      // there is. `no-change` with no `Deferred-to-intake:` is not evidence; it is silence.
      if (fix.kind === "no-change" && deferred.length === 0) {
        const detail = `the correction pass changed nothing and declared nothing, with ${findings.length} finding(s) outstanding`;
        appendTick(arenaDir, { decision: "unit-fix-empty", unit: unit.id, detail, spend_usd: fix.spendUsd });
        appendUnitMetric(arenaDir, {
          unit: unit.id, outcome: "failed",
          time_to_verified_done_s: (Date.now() - startedMs) / 1000,
          spend_usd: implementSpendUsd + v.spend_usd + fixSpendUsd + unbilledRoundSpend(arenaDir, unit.id),
          attempts: failedAttempts(arenaDir, unit.id).count + 1, reworked: true,
          // Verbatim: the next attempt needs the findings, plus what this pass said about
          // why it did nothing, which is the only account of it that exists.
          detail: [detail, fix.answer, ...findings].join(NEWLINE + NEWLINE),
        });
        reapBranch(arenaDir, branch, [headDir, baseDir]);
        return { decision: "unit-fix-empty", unit: unit.id, detail };
      }

      // What it may not touch, checked on its OWN delta rather than the branch — the
      // branch also carries the implementer's legitimate work, and judging that by the
      // fixer's rules parks a unit for something it was allowed to do.
      const fixDelta = execFileSync("git", ["diff", "--name-only", preFix, branch], { cwd: arenaDir, encoding: "utf8" }).split(/\r?\n/);
      const fixBreaches = guardrailBreaches(fixDelta, { reviewFix: true, engineOwned: true });
      if (fixBreaches.length > 0) {
        const detail = `the correction pass touched guarded paths: ${describeBreaches(fixBreaches)}`;
        appendTick(arenaDir, { decision: "guardrail-breach", unit: unit.id, detail });
        reapBranch(arenaDir, branch, [headDir, baseDir]);
        flipStatus(arenaDir, join("work", `${unit.id}.md`), "escalated", `doctrine: park ${unit.id} (correction pass breached a guardrail)`);
        return { decision: "guardrail-breach", unit: unit.id, detail };
      }

      // --- the free half again: it costs nothing, so it can afford to be the gate ---
      //
      // The asymmetry this whole rung now turns on. The paid judge ran once and is not
      // asked again — asking it again is the unbounded loop, at roughly nine dollars a
      // turn. The gates and the evidence are deterministic and free, so there is no
      // reason to take the correction pass's word for them, and they are what actually
      // proves the unit does what it says.
      // Checked in the FIX worktree, which is already on the branch at the corrected
      // tree and already has the target's dependencies in it. Adding a second detached
      // worktree and running `npm ci` again would be a full reinstall per corrected unit
      // to look at the identical files.
      headSha = git(arenaDir, ["rev-parse", branch]);
      const checksAfter = runUnitChecks(fixDir, unit, manifest.gates, join(runDir, "checks-after"));
      removeWorktree(arenaDir, fixDir);
      if (checksAfter.findings.length > 0) {
        // Two different things, and the next attempt needs to tell them apart: a check
        // that was already failing and was not fixed, versus one the correction BROKE.
        // The second says the pass overreached, which is a different instruction from
        // "you missed this" — and reporting both as one list is what a raw dump does.
        const survived = stillFailing(checksBefore, checksAfter);
        const wasPassing = new Set(checksBefore.runs.filter((r) => r.exitCode === 0).map((r) => r.label));
        const regressed = checksAfter.runs
          .filter((r) => r.exitCode !== 0 && wasPassing.has(r.label))
          .map((r) => `${r.label} was PASSING before the correction pass and is now failing: \`${r.command}\``);
        const detail = `${checksAfter.findings.length} check(s) failing after the correction pass`
          + (regressed.length > 0 ? `, ${regressed.length} of them broken BY it` : "");
        appendTick(arenaDir, { decision: "checks-failed", unit: unit.id, detail });
        appendUnitMetric(arenaDir, {
          unit: unit.id, outcome: "failed",
          time_to_verified_done_s: (Date.now() - startedMs) / 1000,
          spend_usd: implementSpendUsd + v.spend_usd + fixSpendUsd + unbilledRoundSpend(arenaDir, unit.id),
          attempts: failedAttempts(arenaDir, unit.id).count + 1, reworked: true,
          // Verbatim: this is the next attempt's input, not a summary for a person.
          detail: [...regressed, ...survived, ...checksAfter.findings].join(NEWLINE + NEWLINE),
        });
        reapBranch(arenaDir, branch, [headDir, baseDir]);
        return { decision: "checks-failed", unit: unit.id, detail };
      }
      // Anything it could not honestly fix becomes INTAKE, not a stall and not a silence.
      //
      // The same artifact the review rung writes, on the same base branch, read by the
      // same intake — because "a finding nobody can fix here" is one thing whether a
      // reviewer or a judge found it. The BASE branch deliberately: this unit still has
      // landing and external review in front of it, and a record that dies with the
      // branch is a finding closed everywhere.
      recordDeferred(arenaDir, manifest.base_branch ?? "development", unit, deferred, `judge findings on ${branch}`);
      appendTick(arenaDir, {
        decision: "unit-fixed", unit: unit.id, spend_usd: fix.spendUsd,
        detail: `${findings.length} finding(s) corrected${deferred.length > 0 ? `, ${deferred.length} deferred to intake` : ""}`,
      });
    } else if (checksBefore.findings.length === 0) {
      // Nothing to correct: the gates were green and the judge found nothing. The common
      // case, and it costs no third spawn.
      appendTick(arenaDir, { decision: "verdict-pass", unit: unit.id });
    }

    // The verdict is in; the worktrees are done. Release the head worktree BEFORE
    // landing — a checked-out branch cannot be deleted by landUnit otherwise.
    removeWorktree(arenaDir, headDir);
    removeWorktree(arenaDir, baseDir);

    const prior = failedAttempts(arenaDir, unit.id);
    // `v` describes the tree the judge READ, which after a correction pass is not the
    // tree being landed — its `head_sha` is the pre-correction one. That is deliberate
    // and it is what the verdict is for: a record of what was judged, not a claim about
    // what shipped. Nothing downstream compares it to the branch tip (checked: `merge.ts`
    // takes the verdict for its type and reads no field of it), and what speaks for the
    // corrected tree is the free re-check above — every gate and every evidence spec, run
    // again on the actual landing tree.
    const landCtx = {
      arenaDir, baseBranch: manifest.base_branch ?? "development",
      unit, branch, headSha, verdict: v,
      // The correction pass is real money and the daily gate reads metrics only.
      // `unbilledRoundSpend` bills `pr-opened` and no-change review-fix ticks and knows
      // nothing about this one, so leaving it out undercounted every corrected unit on
      // both the direct and the PR landing path — and a budget that undercounts is a
      // budget that can be exceeded. This rung has been caught spending outside a budget
      // once before (the program rung, #18); the fix is to add the cost where the total
      // is assembled rather than to teach a second function about a third tick name.
      spendUsd: implementSpendUsd + v.spend_usd + designSpendUsd + fixSpendUsd,
      ...(prior.summaries.length > 0 ? { priorFailures: prior.summaries } : {}),
    };
    // PR mode with a review window opens the PR and STOPS: the unit goes to
    // `in-review` and a later tick's review rung settles it. Without a review block
    // the behaviour is unchanged — judge pass merges immediately.
    if (manifest.landing === "pr" && manifest.review !== undefined) {
      const opened = openUnitPr({ ...landCtx, ...(deps.runGh !== undefined ? { runGh: deps.runGh } : {}) });
      if (!opened.opened) {
        appendTick(arenaDir, { decision: "parked", unit: unit.id, detail: opened.reason });
        flipStatus(arenaDir, join("work", `${unit.id}.md`), "escalated", `doctrine: park ${unit.id} (${opened.reason.slice(0, 60)})`);
        return { decision: "parked", unit: unit.id, detail: opened.reason };
      }
      appendTick(arenaDir, { decision: "pr-opened", unit: unit.id, spend_usd: implementSpendUsd + v.spend_usd + designSpendUsd, detail: opened.pr.url });
      return { decision: "pr-opened", unit: unit.id, detail: opened.pr.url };
    }

    const landed = manifest.landing === "pr"
      ? landUnitViaPr({ ...landCtx, ...(deps.runGh !== undefined ? { runGh: deps.runGh } : {}) })
      : landUnit(landCtx);
    if (!landed.landed) {
      appendTick(arenaDir, { decision: "parked", unit: unit.id, detail: landed.reason });
      flipStatus(arenaDir, join("work", `${unit.id}.md`), "escalated", `doctrine: park ${unit.id} (${landed.reason.slice(0, 60)})`);
      return { decision: "parked", unit: unit.id, detail: landed.reason };
    }
    appendUnitMetric(arenaDir, {
      unit: unit.id, outcome: "merged",
      time_to_verified_done_s: (Date.now() - startedMs) / 1000,
      spend_usd: implementSpendUsd + v.spend_usd + designSpendUsd,
      attempts: prior.count + 1, reworked: prior.count > 0,
    });
    appendTick(arenaDir, { decision: "landed", unit: unit.id, spend_usd: implementSpendUsd + v.spend_usd + designSpendUsd });
    return { decision: "landed", unit: unit.id };
  } finally {
    removeWorktree(arenaDir, baseDir);
    removeWorktree(arenaDir, headDir);
  }
}

/**
 * The loop has nothing it can do. If anything is still outstanding (an escalated unit, a
 * feature or epic grade that is not a pass), that is a stall, not a rest: pause, with the list,
 * so an observer sees it instead of a run of quiet `idle` ticks (stall.ts has the history).
 * Program-done returns before either caller, so reaching here means the program is not done.
 */
/**
 * Run the target's surface command and keep what it printed: the report is the pause reason.
 *
 * The arena is prepared first, with the manifest's setup, for `runGrade`'s reason: worktree setup
 * does not keep the arena's own install current, and a fresh clone or changed dependencies would
 * otherwise fail the command and pause a target whose contract is in fact met. The command is
 * capped at the ten minutes every other gate gets, and a killed run is unresolved, never a pass.
 * Without a cap, a hanging command would hold the lease for ever (doctrine#105 review).
 */
function runSurface(command: string, cwd: string, setup: string | undefined): { code: number; output: string } {
  // Setup gets the same ten-minute cap, run here rather than through `runSetup` (which has none):
  // an installer that stalls on the network would otherwise hold the lease before the capped
  // surface command is ever reached (doctrine#105 second review).
  if (setup !== undefined && setup.trim().length > 0) {
    const prep = spawnSync(BASH, ["-c", setup], { cwd, encoding: "utf8", stdio: "pipe", timeout: 10 * 60_000 });
    if (prep.status !== 0) {
      const why = prep.status === null ? `killed: ${prep.signal ?? "timeout"} after 10 minutes` : `exit ${prep.status}`;
      return { code: 1, output: `setup "${setup}" failed before the surface command could run (${why})\n${`${prep.stdout ?? ""}${prep.stderr ?? ""}`.trim().slice(-600)}` };
    }
  }
  const res = spawnSync(BASH, ["-c", command], {
    cwd, encoding: "utf8", stdio: "pipe", maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000,
  });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (res.status === null) {
    return { code: 1, output: `${output}\n(killed: ${res.signal ?? "timeout"}; the surface command did not finish within 10 minutes)` };
  }
  return { code: res.status, output };
}

export function pauseIfStalled(arenaDir: string, where: "chain-complete" | "idle"): TickResult | undefined {
  // The epics and features the ladder still asks about: the same `status: done` exclusion the
  // grade selectors and `featuresOfEpics` apply. No program, no ladder grades to count.
  const active = new Set<string>();
  try {
    const epics = new FileNarrowingStore(arenaDir).load("epic").narrowings.filter((e) => e.status !== "done");
    for (const e of epics) active.add(e.id);
    for (const f of featuresOfEpics(epics.map((e) => ({ id: e.id, body: e.body, status: e.status }))).features) active.add(f.id);
  } catch { /* no epics on disk: only escalated units can be outstanding */ }
  const items = outstanding(arenaDir, loadUnits(arenaDir), active);
  if (items.length === 0) return undefined;
  const reason = stallReason(where, items);
  // Create, never overwrite. An observer may have paused since this tick read the steering,
  // and replacing their file would erase their reason or turn a timed pause into a stall.
  let preserved = false;
  try {
    writeFileSync(pausePath(arenaDir), reason, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    preserved = true;
  }
  const detail = preserved ? `${reason.slice(0, 360)} [an existing pause was left as it was]` : reason.slice(0, 400);
  appendTick(arenaDir, { decision: "stalled", detail, awaits_observer: true });
  return { decision: "stalled", detail: reason };
}

export async function tick(deps: TickDeps): Promise<TickResult> {
  const arenaDir = deps.arenaDir;
  const manifest = JSON.parse(readFileSync(join(arenaDir, ".doctrine", "manifest.json"), "utf8")) as Manifest;
  // Precedence: explicit deps > target manifest > defaults.
  const budgets = deps.budgets ?? { ...DEFAULT_BUDGETS, ...manifest.budgets };
  const baseBranch = manifest.base_branch ?? "development";
  const startedMs = Date.now();

  const lease = acquireLease(arenaDir);
  if (!lease.acquired) return { decision: "no-op-lease" };

  try {
    // ORDER: lease → sync the base → steering → budgets.
    //
    // Steering must be read from the tree AFTER the fetch, not before it. An observer
    // who merges a `.doctrine/pause` or a veto into the base branch has said stop, and
    // reading steering first means this tick holds the previous state and can spend on
    // a paid ACT anyway — the one instruction that must never be a tick late.
    git(arenaDir, ["checkout", "-q", baseBranch]);
    sweepStaleWorktrees(arenaDir);

    // Take whatever landed on origin since the last tick, THEN push anything of ours it
    // does not have. In that order, and before the landing probe.
    //
    // Without the pull, a merge anyone else makes to the base branch leaves this clone
    // behind, `git push --dry-run` fails as a non-fast-forward, and the probe reports
    // "push access probe failed" — which is both misleading and terminal: the loop
    // no-ops every tick until a person runs `git pull`. An unattended loop that stops
    // whenever someone merges is not unattended.
    //
    // The push half delivers engine bookkeeping the base is carrying that origin lacks —
    // a grade's `done` flip, a decompose commit. Each writer tries once; this is the
    // durable retry, because the rung that wrote it will not run again.
    if (manifest.landing === "pr") {
      const sync = syncBase(arenaDir, baseBranch);
      if (!sync.ok) {
        appendTick(arenaDir, { decision: "no-op-diverged", detail: sync.reason });
        return { decision: "no-op-diverged", detail: sync.reason };
      }
    }

    const steering = readSteering(arenaDir);
    if (steering.paused) {
      appendTick(arenaDir, { decision: "no-op-paused", detail: steering.pauseReason ?? "" });
      return { decision: "no-op-paused", detail: steering.pauseReason ?? "" };
    }
    const gate = checkBudgets(arenaDir, budgets);
    if (!gate.ok) return { decision: "self-halt", detail: gate.halt };

    // Spend gates before spend: in PR mode, prove the landing path works
    // BEFORE any paid ACT (implementer or resume-judge) runs.
    if (manifest.landing === "pr") {
      const probe = probeLanding(arenaDir, baseBranch, deps.runGh ?? productionRunGh);
      if (!probe.ok) {
        appendTick(arenaDir, { decision: "no-op-landing-probe", detail: probe.reason });
        return { decision: "no-op-landing-probe", detail: probe.reason };
      }
    }

    const units = loadUnits(arenaDir);

    // --- Rung 0a: settle units whose PR is open and under review ---
    // Ahead of everything else for the same reason maintenance work is: a unit already
    // judged and pushed is closer to done than anything not yet started, and leaving it
    // open while new work piles up is how WIP escapes 1.
    if (manifest.landing === "pr" && manifest.review !== undefined) {
      const reviewing = unitsInReview(arenaDir, loadUnits(arenaDir))[0];
      if (reviewing !== undefined) {
        return await handleReview(deps, manifest, reviewing.unit, startedMs, reviewing.branch);
      }
    }

    // --- Rung 0: resume in-flight work (a crashed tick's branch) — WIP=1 ---
    const inflight = git(arenaDir, ["branch", "--list", "doctrine/*"])
      .split(/\r?\n/).map((b) => b.replace(/^[*+]?\s*/, "")).filter((b) => b.length > 0);
    if (inflight.length > 0) {
      const branch = inflight[0]!;
      const unit = units.find((u) => u.status === "ready" && branch.startsWith(`doctrine/${u.id}-`));
      // A branch whose own copy of the unit says `in-review` is not crashed work: its
      // PR is open and the review rung owns it. Reaping or re-judging it here would
      // open a second PR for the same unit.
      if (unit !== undefined && branchUnitStatus(arenaDir, branch, unit.id) === "in-review") {
        appendTick(arenaDir, { decision: "no-op-review-owned", unit: unit.id, detail: branch });
        return { decision: "no-op-review-owned", unit: unit.id, detail: branch };
      }
      if (unit === undefined) {
        git(arenaDir, ["branch", "-D", branch]);
        appendTick(arenaDir, { decision: "reaped-orphan-branch", detail: branch });
        return { decision: "reaped-orphan-branch", detail: branch };
      }
      const headSha = git(arenaDir, ["rev-parse", branch]);
      const baseSha = git(arenaDir, ["merge-base", baseBranch, branch]);
      const headDir = join(arenaDir, ".doctrine", "runs", `resume-${unit.id}-${Date.now()}`, "head");
      mkdirSync(join(headDir, ".."), { recursive: true });
      git(arenaDir, ["worktree", "add", "--detach", headDir, headSha]);
      appendTick(arenaDir, { decision: "resume", unit: unit.id, detail: branch });
      return judgeAndLand(deps, manifest, unit, branch, baseSha, headSha, headDir, 0, startedMs);
    }

    // The intent frontier, and the commit every "settled" record is keyed on. Loaded here because
    // the grade below needs both; the decompose and program rungs later ask the same question of
    // the same commit.
    const intents = loadIntents(arenaDir);
    // What a unit's `depends_on` actually waits on: a REQUIREMENT, satisfied when every
    // intent that delivers or renders it is done (ADR-0004). An intent is done when the
    // engine has run its acceptance and it passed — so this is a fact about reality, not
    // about whether somebody remembered to flip a flag.
    //
    // WIDENED 2026-09-29: the slices are `dependableSlices` — retired epics,
    // intents and units — and the SAME list is handed to both mint gates below. It resolved
    // through the intents alone until then, while the mint gates resolved through the units
    // alone; three readers of one question, disagreeing. See `dependableSlices`.
    const dependable = dependableSlices(
      manifest.program !== undefined ? new FileNarrowingStore(arenaDir).load("epic").narrowings : [],
      intents,
      units,
    );
    const satisfiedCriteria = satisfied(dependable, (s) => s.done);

    const head = git(arenaDir, ["rev-parse", "HEAD"]);

    // --- Rung 0b: the FEATURE grade, then the EPIC grade (ADR-0003) ---
    //
    // The ratchet, one rung up. `runIntentGrade` below is the same mechanism on the rung
    // that dies at cutover, and both are here at once on purpose: the new ladder's rungs
    // land and are fixture-verified while the old ladder is still what runs,
    // so a bad sweep can be attributed.
    //
    // **All four new rungs are structurally INERT on both live arenas, and that is the
    // safety case for adding them to a running loop's tick.** Three independent facts,
    // each checkable and each enough on its own:
    //
    //   - every epic on the live target contains zero `### Feature` headings, so
    //     `featuresOfEpics` returns none and there is nothing to grade;
    //   - no unit anywhere carries `parent`, so no feature has children even if one
    //     existed — units say `intent:`, which is the legacy backlink;
    //   - no unit anywhere holds `status: scaffold`, so the build-out rung selects nothing.
    //
    // Cutover is what makes them fire, all three at once, deliberately.
    //
    // **What is settled here is the SCHEDULE, not the fact.** A pass is a committed grade
    // record — `levelPassed` reads it from the artifact, so a fresh clone reaches the same
    // answer. A failure or an ungraded level is settled in `.doctrine/intents-settled.json`
    // instead, because "not worth re-asking at this commit" is a scheduling hint and is
    // safe to lose. The file is keyed by id and feature ids (`ep-x#1.2`) cannot collide
    // with intent ids (`in-...`), so the two share it.
    if (manifest.program !== undefined) {
      const gradeStore = new FileNarrowingStore(arenaDir);
      const gradeEpics = gradeStore.load("epic").narrowings;
      const gradeFeatures = featuresOfEpics(gradeEpics.map((e) => ({ id: e.id, body: e.body, status: e.status }))).features;

      /**
       * Settle at the commit the grade's OWN commit produced, and carry every other
       * settlement across with it. Without the carry, one feature grade un-settles every
       * intent settled at the previous head and the next ticks pay to be told again what
       * they were told before — the defect `carrySettlementForward` was written for.
       */
      const settleAfterGrade = (id: string, graded: boolean): string => {
        const after = git(arenaDir, ["rev-parse", "HEAD"]);
        carrySettlementForward(arenaDir, head, after);
        if (!graded) markIntentSettled(arenaDir, id, after);
        return after;
      };

      const gradableFeature = gradeFeatures.find((f) => {
        if (levelPassed(arenaDir, "feature", f.id)) return false;
        if (intentSettled(arenaDir, f.id, head)) return false;
        const children = units.filter((u) => u.parent === f.id);
        // `escalated` counts as settled, not pending, for the reason the intent rung
        // argues at length below: a judge that escalates has ruled, and the grade is the
        // right arbiter of what to do next.
        //
        // And a child stranded behind an escalation counts as settled too — the case PR #94's
        // review caught missing here. A downstream unit whose criterion can never be satisfied
        // stays `ready` or `scaffold` for ever, so without this the feature never grades, its
        // ratchet never runs, and the program stalls: the intent rung's 2026-09-07 freeze,
        // one rung up.
        const stranded = strandedChildren(units, children);
        return children.length > 0
          && children.every((u) => u.status === "merged" || u.status === "escalated" || stranded.has(u.id));
      });
      if (gradableFeature !== undefined) {
        // Retire them on disk before grading, exactly as the intent rung does and for its
        // reason: counted settled in one predicate and left `ready` on disk, they would still
        // read as open work to every other reader.
        const strandedHere = strandedChildren(units, units.filter((u) => u.parent === gradableFeature.id));
        if (strandedHere.size > 0) {
          retireStranded(arenaDir, strandedHere, gradableFeature.id);
          carrySettlementForward(arenaDir, head, git(arenaDir, ["rev-parse", "HEAD"]));
        }
        const out = runLevelGrade(
          arenaDir, "feature",
          { id: gradableFeature.id, evidence: gradableFeature.acceptance },
          head, manifest.setup,
        );
        settleAfterGrade(gradableFeature.id, out.kind === "pass");
        // `ungraded` settles exactly as `fail` does. It is never a pass, so without this
        // the same feature is re-decided every tick and no rung below ever runs — the
        // quiet deadlock this loop has paid for twice, arriving through a third status.
        const detail = out.kind === "ungraded" ? out.detail
          : out.kind === "fail" ? out.failureLog.slice(0, 400)
          : `${out.runs.length} check(s) passed`;

        // --- THE RATCHET (ADR-0003): a failed grade buys the next slice of work ---
        //
        // *Plans are cheap; reality decides coverage.* The engine has just run this
        // feature's end-to-end checks against every unit under it merged, with no LLM, and
        // they did not pass. That is a fact about the product, so the answer is more work
        // rather than a re-judged plan.
        //
        // Keyed on the failure SIGNATURE, not on the commit. An intent blocked on
        // something outside itself re-bought the same honest "nothing to add" sixteen
        // times for $31.33 before this key existed — settlement alone could not fix it,
        // because a commit moves for reasons that have nothing to do with this feature.
        // If the acceptance fails identically, byte for byte, the planner is being asked a
        // question it has already answered.
        const gapLaw = deps.agentDefs.scaffoldGap;
        if (out.kind === "fail" && gapLaw !== undefined && readGapSignatures(arenaDir)[gradableFeature.id] !== out.record.signature) {
          const epic = gradeEpics.find((e) => e.id === gradableFeature.epic);
          if (epic !== undefined) {
            const runDir = join(arenaDir, ".doctrine", "runs", `scaffold-gap-${Date.now()}`);
            mkdirSync(runDir, { recursive: true });
            const gap = await runScaffoldGap({
              arenaDir, epic, feature: gradableFeature,
              criteria: parseCriteria(readFileSync(join(arenaDir, manifest.program.prd), "utf8")),
              existingUnits: units,
              dependable,
              failureLog: out.failureLog,
              logPath: join(runDir, "scaffold-gap.log"),
              agentDefinitionPath: gapLaw,
              budgetUsd: deps.decomposeBudgetUsd ?? 10,
              // `REVIEW_FIX_DENY` and not the generic profile. This ACT writes into a
              // scratch directory and the engine publishes what survives the lint, so
              // `work/`, `docs/program/` and `contracts.md` are all off-limits to it —
              // and a gate the loop can satisfy on its own is not a gate. The
              // `repoTouchedBy` tripwire still runs; this is the layer beneath it, so a
              // reach into the repo is denied rather than detected and reverted.
              settingsPath: writeDenySettings(arenaDir, manifest, { extraDeny: REVIEW_FIX_DENY, fileName: "claude-deny-scaffold-gap.json" }),
              ...(deps.runAgent !== undefined ? { runAgent: deps.runAgent } : {}),
            });
            // Only an honest EMPTY is recorded against the signature. A rejection or a
            // spawn failure says nothing about whether there is work to find, and keying
            // on it would retire the ratchet over a bad round.
            if (gap.kind === "empty") markGapAsked(arenaDir, gradableFeature.id, out.record.signature);
            const gapDetail = gap.kind === "scaffolded" ? gap.ids.join(", ")
              : gap.kind === "empty" ? gap.detail
              : gap.kind === "rejected" ? gap.problems.join("; ").slice(0, 400)
              : `${gap.reason}: ${gap.problems.join("; ").slice(0, 300)}`;
            appendDecomposeMetric(arenaDir, {
              intent: gradableFeature.id,
              outcome: gap.kind === "scaffolded" ? "decomposed" : gap.kind === "empty" ? "empty" : "failed",
              spend_usd: gap.spendUsd,
            });
            appendTick(arenaDir, {
              decision: `feature-graded-fail+gap-${gap.kind}`, unit: gradableFeature.id,
              spend_usd: gap.spendUsd, detail: gapDetail,
            });
            return { decision: `feature-graded-fail+gap-${gap.kind}`, unit: gradableFeature.id, detail: gapDetail };
          }
        }

        appendTick(arenaDir, { decision: `feature-graded-${out.kind}`, unit: gradableFeature.id, detail });
        return { decision: `feature-graded-${out.kind}`, unit: gradableFeature.id, detail };
      }

      // A failed epic grade whose ratchet has not been asked at this commit. Settlement alone
      // would hide it: an arena upgraded at the very commit an epic failed on (the old engine
      // had no epic ratchet) never moves HEAD again if nothing else is buildable, so the new
      // ratchet would never be reached (doctrine#100 review). Any attempt, whatever it
      // answered, is remembered against this signature AND commit, so a rejected round is not
      // re-bought every tick; an honest empty is remembered against the signature alone.
      const epicGapLaw = deps.agentDefs.scaffoldGap;
      const unansweredEpicFailure = (id: string): boolean => {
        if (epicGapLaw === undefined) return false;
        const rec = readLevelGrade(arenaDir, "epic", id);
        if (rec?.verdict !== "fail") return false;
        const asked = readGapSignatures(arenaDir);
        return asked[id] !== rec.signature && asked[`${id}@attempt`] !== `${rec.signature}@${head}`;
      };
      const gradableEpic = gradeEpics.find((e) => {
        if (levelPassed(arenaDir, "epic", e.id)) return false;
        if (intentSettled(arenaDir, e.id, head) && !unansweredEpicFailure(e.id)) return false;
        const mine = gradeFeatures.filter((f) => f.epic === e.id);
        // An epic is done when its features are (it no longer has a stored status), so the
        // epic grade asks the product-level question only once every feature under it has
        // been shown to work. It is the lightest of the three and the last to fire.
        if (!(mine.length > 0 && mine.every((f) => levelPassed(arenaDir, "feature", f.id)))) return false;
        // AND once no unit under it is still open, by the feature rung's own settled test.
        // The epic ratchet below parents its gap units under a feature that has ALREADY
        // passed, so "every feature passed" no longer implies "nothing pending": without
        // this, the next commit re-grades the epic while its gap unit is still a scaffold,
        // fails with the same signature, and a `scaffolded` answer (which marks nothing)
        // buys a duplicate unit every tick.
        const children = units.filter((u) => mine.some((f) => f.id === u.parent));
        const stranded = strandedChildren(units, children);
        return children.every((u) => u.status === "merged" || u.status === "escalated" || stranded.has(u.id));
      });
      if (gradableEpic !== undefined) {
        const out = runLevelGrade(
          arenaDir, "epic", { id: gradableEpic.id, evidence: gradableEpic.evidence }, head, manifest.setup,
        );
        const gradedAt = settleAfterGrade(gradableEpic.id, out.kind === "pass");
        const detail = out.kind === "ungraded" ? out.detail
          : out.kind === "fail" ? out.failureLog.slice(0, 400)
          : `${out.runs.length} check(s) passed`;

        // --- THE RATCHET, one rung up: a failed EPIC grade buys its missing slice too ---
        //
        // The feature rung has had this since ADR-0003; the epic rung had nothing, so a failed
        // epic was recorded and then never revisited, and the program could never be done.
        // Measured on a target: two epics whose features all passed failed
        // their end-to-end check with "No test files found". The planner had written an epic
        // acceptance (`npm test -- publishers`) that no unit was ever given to build.
        //
        // The gap units are parented under the epic's LAST feature, by position: the epic's
        // acceptance spans its features, the integration work belongs at the end of it, and a
        // unit must have one feature parent for the build-out and admit rungs to reach it.
        // Keyed on the epic's own id in the signature store, so the feature-level keys under
        // it are untouched.
        const gapLaw = epicGapLaw;
        // The last feature that DELIVERS something. The gap lint scopes coverage to the host's
        // `delivers`, and over a render-only feature that set is empty, which the lint refuses
        // outright ("coverage over an empty set is not coverage"): every attempt would be
        // rejected and the epic could never be finished (doctrine#100 review).
        const host = [...gradeFeatures.filter((f) => f.epic === gradableEpic.id && f.delivers.length > 0)]
          .sort((a, b) => a.position - b.position).at(-1);
        if (out.kind === "fail" && gapLaw !== undefined && host !== undefined
          && readGapSignatures(arenaDir)[gradableEpic.id] !== out.record.signature) {
          markGapAsked(arenaDir, `${gradableEpic.id}@attempt`, `${out.record.signature}@${gradedAt}`);
          const runDir = join(arenaDir, ".doctrine", "runs", `scaffold-gap-${Date.now()}`);
          mkdirSync(runDir, { recursive: true });
          const gap = await runScaffoldGap({
            arenaDir, epic: gradableEpic, feature: host,
            epicFailure: { evidence: gradableEpic.evidence },
            criteria: parseCriteria(readFileSync(join(arenaDir, manifest.program.prd), "utf8")),
            existingUnits: units,
            dependable,
            failureLog: out.failureLog,
            logPath: join(runDir, "scaffold-gap.log"),
            agentDefinitionPath: gapLaw,
            budgetUsd: deps.decomposeBudgetUsd ?? 10,
            // The feature ratchet's containment, for its reason: a scratch-directory ACT whose
            // output the engine publishes, so the repository is off-limits to it.
            settingsPath: writeDenySettings(arenaDir, manifest, { extraDeny: REVIEW_FIX_DENY, fileName: "claude-deny-scaffold-gap.json" }),
            ...(deps.runAgent !== undefined ? { runAgent: deps.runAgent } : {}),
          });
          if (gap.kind === "empty") markGapAsked(arenaDir, gradableEpic.id, out.record.signature);
          // New work under a feature that already passed withdraws that pass, so the feature's
          // own acceptance runs again once the gap units land, before the epic can be re-graded
          // on a stale pass (doctrine#100 review). The epic selector already waits for it.
          if (gap.kind === "scaffolded") {
            reopenLevel(arenaDir, "feature", host.id, git(arenaDir, ["rev-parse", "HEAD"]),
              `${gap.ids.join(", ")} added by the epic ratchet for ${gradableEpic.id}`);
          }
          const gapDetail = gap.kind === "scaffolded" ? gap.ids.join(", ")
            : gap.kind === "empty" ? gap.detail
            : gap.kind === "rejected" ? gap.problems.join("; ").slice(0, 400)
            : `${gap.reason}: ${gap.problems.join("; ").slice(0, 300)}`;
          appendDecomposeMetric(arenaDir, {
            intent: gradableEpic.id,
            outcome: gap.kind === "scaffolded" ? "decomposed" : gap.kind === "empty" ? "empty" : "failed",
            spend_usd: gap.spendUsd,
          });
          appendTick(arenaDir, {
            decision: `epic-graded-fail+gap-${gap.kind}`, unit: gradableEpic.id,
            spend_usd: gap.spendUsd, detail: gapDetail,
          });
          return { decision: `epic-graded-fail+gap-${gap.kind}`, unit: gradableEpic.id, detail: gapDetail };
        }

        appendTick(arenaDir, { decision: `epic-graded-${out.kind}`, unit: gradableEpic.id, detail });
        return { decision: `epic-graded-${out.kind}`, unit: gradableEpic.id, detail };
      }

      // --- Program done: the question `programProgress` was written for and never asked ---
      //
      // Not "every criterion reached a plan" — that is `chain-complete` far below, and it
      // is a claim about DOCUMENTS. This is the claim about reality: every machine-checkable
      // criterion is delivered by an epic whose own acceptance the engine ran and passed.
      // Draft criteria never gate it, because nothing verified them and nothing may report
      // them satisfied.
      //
      // **Here rather than in the program rung, and the first draft had it wrong.** Written
      // there it sat inside `!openIntent && !openUnit && !programSettled` and behind a guard
      // on the program decomposer, the program judge and the intent fixer all being
      // installed — so "is the whole thing finished" was answerable only on a target that
      // still had a planner law for a rung the three-rung ladder deletes. It belongs beside
      // the grades that answer it, and it is free: it reads committed grade records.
      //
      // Terminal, and deliberately NOT settled at this commit the way `chain-complete` is.
      // A durable answer about a commit is for questions worth re-asking when HEAD moves.
      if (gradeEpics.length > 0) {
        const programCriteria = parseCriteria(readFileSync(join(arenaDir, manifest.program.prd), "utf8"));
        const progress = programProgress(
          programCriteria,
          gradeEpics,
          // A RETIRED epic is never graded — it is excluded from features and from the epic
          // grade on purpose — so asking `levelPassed` of it left every criterion it carries
          // outstanding for ever, and a program mixing retired and new epics could never be
          // done (PR #94 review). It counts as landed when everything it claims is SATISFIED,
          // under `dependableSlices` — which holds a criterion open while an in-flight intent
          // is still building it, so retirement cannot report unfinished work as finished.
          (e) => e.status === "done"
            ? e.delivers.every((c) => satisfiedCriteria.has(c))
            : levelPassed(arenaDir, "epic", e.id),
        );
        // **Not over a set the epic-set gate would block** (PR #94's second review). Every
        // scaffold being buildable means rung 1b and the grades keep returning, so rung 3 —
        // where the set review lives — may never run before the last epic passes. The mint
        // gate now refuses the duplicate claim at source; this is the terminal backstop, and
        // it is the set review's own free half, called rather than restated. When it has
        // anything to say, fall through: rung 3 runs next, reviews the set, and pauses with
        // the reason in the pause file, which is the machinery that already exists for it.
        const setBlocks = reviewEpicSet(programCriteria, gradeEpics).problems;
        if (progress.done && setBlocks.length === 0) {
          // **The second condition (ADR-0008).** Every PRD criterion delivered is not the
          // whole promise: one target reported done 55/55 with Setup, the connections and
          // statement import unbuilt, because UX and ARCH promises were invisible here. The
          // target's surface command derives what is still stubbed, unevidenced or failing,
          // and done waits for it. Nothing is left to build at this point, so an unresolved
          // surface is a stall: pause with its report, and never overwrite an existing pause.
          if (manifest.surface !== undefined) {
            const surface = runSurface(manifest.surface, arenaDir, manifest.setup);
            if (surface.code !== 0) {
              const reason = [
                "surface unresolved: every PRD criterion is delivered, but the surface contract is not (ADR-0008).",
                `\`${manifest.surface}\` exited ${surface.code}:`,
                surface.output.trim().split(/\r?\n/).slice(-40).join("\n"),
                "",
              ].join("\n");
              try {
                writeFileSync(pausePath(arenaDir), reason, { flag: "wx" });
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
              }
              appendTick(arenaDir, { decision: "surface-unresolved", detail: reason.slice(0, 400), awaits_observer: true });
              return { decision: "surface-unresolved", detail: reason };
            }
          }
          const detail = `${progress.machineDone}/${progress.machineTotal} machine criteria delivered by a passing epic`
            + (progress.unverifiable.length > 0
              ? `; ${progress.unverifiable.length} draft criteria were never verifiable and do not gate`
              : "");
          appendTick(arenaDir, { decision: "program-done", detail });
          return { decision: "program-done", detail };
        }
      }
    }

    // --- Rung 0c: intent-grade (all children merged) + gap decompose on failure ---
    //
    // After the in-flight rungs and before any NEW work. It ran after rung 1 until 2026-09-07, and
    // that was only half a fix: a ready unit belonging to a DIFFERENT intent still delayed the
    // grade indefinitely. Observed the same day — the skeleton intent sat ungraded while the loop
    // built the invoice units, which are the very units that depend on the skeleton being right.
    // "Finish work already started" is a good reason to defer a grade behind that intent's OWN
    // units; it is no reason to defer it behind another intent's.
    //
    // It cannot spin ahead of rung 1, and the guard below is why: `gradable` requires every child
    // merged, so the moment a failed grade's gap-decompose adds units the intent stops being
    // gradable and the tick falls through to build them.
    //
    // BEFORE the decompose below, and the order is the point. Grading used to sit after it, and
    // after rung 1, and every rung returns as soon as it acts — so the grade was starved by any
    // work at all. Observed on a target: the skeleton intent had all six units
    // merged at 04:13 and was still ungraded an hour later, because 04:42 decomposed the next
    // intent and 04:58 built one of its units. Each tick was correct and the one check that looks
    // at the WHOLE was never reached, so the loop began building a second intent on a foundation
    // whose acceptance nobody had run.
    //
    // It sits after rung 1 rather than first because a ready unit is work already started, and
    // finishing it is what makes an intent gradable. It sits before the decompose because that is
    // the moment the loop is about to build ON the finished intent, which is exactly when its
    // acceptance has to have been checked.
    //
    // Cheap, which is why this ordering is affordable: runIntentGrade is engine-only — it runs the
    // target's setup and then the intent's acceptance commands, no LLM and no spend. Only a FAILED
    // grade goes on to launch the paid gap-decompose ACT.
    const gradable = intents.find((i) => {
      if (i.status !== "decomposed") return false;
      // Settled at this commit: its grade failed and the gap decomposer honestly had nothing to
      // add, so re-asking before anything lands buys the same answer at the same price.
      if (intentSettled(arenaDir, i.id, head)) return false;
      const children = units.filter((u) => u.intent === i.id);
      // `escalated` counts as settled, not as pending. A judge that escalates has ruled —
      // it has said the unit cannot be built as specified — and nothing in the loop ever
      // moves that unit again. Requiring every child to be `merged` therefore made one
      // escalation freeze its intent permanently: the grade could not fire, so the gap
      // decomposer could not run, so no corrected unit could ever be minted. Observed on
      // 2026-09-07, when u-2026-09-07-attention-core escalated on a self-contradictory
      // evidence spec and took the whole attention-queue intent with it.
      //
      // The grade is the right arbiter for what to do next, and it is honest either way.
      // If the acceptance commands touch the escalated unit's scope, the grade fails and
      // the gap decomposer mints a replacement with the judge's diagnosis in hand. If they
      // do not, the intent passes with a child that was never built — which is a real
      // outcome and a deliberate one: acceptance decides whether an intent is done, not
      // the unit list, and a unit no acceptance delivers was scope the plan did not need.
      // One statement of "stranded", shared with the feature rung, and computed over every
      // unit rather than these children alone. See `strandedChildren`.
      const blocked = strandedChildren(units, children);
      return children.length > 0 && children.every(
        (u) => u.status === "merged" || u.status === "escalated" || blocked.has(u.id),
      );
    });
    if (gradable !== undefined) {
      // Retire the stranded units for real, before grading on the assumption that they are
      // settled. Counting them as settled in ONE predicate and leaving `ready` on disk just
      // moves the freeze: every other reader still sees open work — the program frontier's
      // own check counts anything not merged and not escalated — so program-decompose would
      // be suppressed and the loop would idle forever with nothing left to build.
      //
      // `escalated` is the engine's existing terminal park, already used for a guardrail
      // breach and a vanished PR, so nothing new has to learn a status. These carry no unit
      // metric, which also keeps them out of the escalation report to the planner: their
      // specs were never in question — the thing they waited on was.
      retireStranded(arenaDir, strandedChildren(units, units.filter((u) => u.intent === gradable.id)), gradable.id);
      // Retiring commits, so the settlement key has to be re-read. `head` above was captured
      // before them, and settlement is keyed on the commit it describes: recording the stale
      // one makes the next tick see a changed HEAD, call the intent unsettled, and repeat the
      // paid grade and gap-decompose against product code that did not move.
      const settleHead = git(arenaDir, ["rev-parse", "HEAD"]);
      // Retirement moved HEAD without touching product code, so every OTHER intent settled
      // at the old commit still deserves its answer. Carry them, or one retirement re-opens
      // all of them and the next tick pays to re-derive what it already knows.
      carrySettlementForward(arenaDir, head, settleHead);
      const grade = runIntentGrade(arenaDir, gradable, manifest.setup);
      if (grade.kind === "pass") {
        // The grade flips the intent to `done` and commits it locally. On a PR-landing
        // target that commit reaches origin only if another unit happens to land after
        // it — and when an intent grades, the frontier is by definition empty, so
        // usually nothing does. The record of a finished intent then sits on one clone,
        // invisible to everyone including the next tick's clone. Push it.
        //
        // Directly, not through a PR: this is a status flip the engine wrote, there is
        // nothing in it for a reviewer to have an opinion about, and a PR per grade
        // would be ceremony. `main` remains the human gate, which is where review of
        // the accumulated work actually happens.
        let pushed = "";
        if (manifest.landing === "pr") {
          try {
            git(arenaDir, ["push", "-q", "origin", baseBranch]);
          } catch (e) {
            // Retried by the sync step at the top of every tick: the intent is already
            // `done`, so this branch never runs again and a transient network failure
            // would otherwise strand the record locally forever.
            pushed = ` (grade committed locally but push failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 120)})`;
          }
        }
        appendTick(arenaDir, { decision: "intent-graded-pass", unit: gradable.id, detail: pushed.trim() });
        return { decision: "intent-graded-pass", unit: gradable.id, ...(pushed !== "" ? { detail: pushed.trim() } : {}) };
      }
      // The evidence has not moved, so neither will the answer. Free grade, no paid pass.
      //
      // Over every input that can change what the decomposer says, not only the output: the
      // criteria it is told it may depend on, and the escalations it is told about.
      //
      // **Not merged unit ids — and the comment above this used to say it was.** Previously
      // the decomposer was told "merged units you may depend on", so a merge was a change
      // in what it was told. A later change replaced that line of its prompt with
      // `dependableCriteria`, and this key went on hashing every merged unit in the arena:
      // an input the planner no longer sees, standing in for one it does. So ANY merge,
      // anywhere, re-bought every honest "nothing to add" — measured on a target,
      // the first unit to land after the unpause re-asked an intent that is
      // blocked on an unbuilt criterion, byte-identical failure output, $1.28. That is the
      // "re-ask when any commit does" PR #85 exists to refuse, back through a stale input.
      //
      // **And the list is computed over `dependableSlices`, not the intents** — which is what
      // actually answers the objection review raised to dropping merged ids (PR #96): that the
      // landed tree is a real planner input, so an intent blocked on a sibling would never be
      // re-asked once the sibling landed if its checks fail on its OWN missing file. That is
      // one target's reimbursement intent exactly: every check fails on
      // `reimbursement_open.ts`, and what blocks it is C6.3. Over intents alone, C6.3 — which
      // new-shape units will deliver — could never enter the planner's list at all, so no key
      // could have saved it. Over `dependableSlices` it enters the moment an epic scaffolds
      // units delivering it: the planner's question changes, the key moves, it is re-asked.
      // Once per requirement that becomes available, not once per merge.
      //
      // Not "satisfied" as well: a criterion already on the list is one the planner can
      // depend on today, and the engine holds the unit until it is built. "Nothing to add"
      // is only an honest answer when the blocker is off the list. A silent failure gets
      // NO skip at all — `test -f artifact` prints nothing whether the artifact is missing or
      // the whole slice it needed just landed, so an empty failure log is uninformative and
      // suppressing on it would leave an intent unplanned forever the moment it became
      // actionable. External review, PR #85.
      const escalatedNow = escalatedUnitDetails(arenaDir, units, gradable.id);
      const signature = failureSignature(grade.runs) + ":" + createHash("sha256")
        .update(dependableCriteria(gradable, dependable).join("\u0000")).update("\u0000--esc--\u0000")
        .update([...escalatedNow].sort().join("\u0000"))
        .digest("hex").slice(0, 16);
      // A silent failure gets NO skip — that was the rule, and this line did not enforce it:
      // `failureLog` always carries a `command:` header, so it was never empty and every
      // failure counted as informative. Judged on what the failing commands actually PRINTED.
      const informative = grade.runs.some((r) => {
        if (r.exit_code === 0) return false;
        try { return readFileSync(r.log, "utf8").trim().length > 0; } catch { return false; }
      });
      if (informative && readGapSignatures(arenaDir)[gradable.id] === signature) {
        markIntentSettled(arenaDir, gradable.id, settleHead);
        const detail = `the acceptance fails exactly as it did when the decomposer last said it had nothing to add (${signature})`;
        appendTick(arenaDir, { decision: "intent-graded-fail+gap-unchanged", unit: gradable.id, detail });
        return { decision: "intent-graded-fail+gap-unchanged", unit: gradable.id, detail };
      }

      const gap = await runDecompose({
        intent: gradable, arenaDir,
        logPath: join(arenaDir, ".doctrine", "runs", `gap-${gradable.id}-${Date.now()}.log`),
        agentDefinitionPath: deps.agentDefs.decomposer,
        planJudgeAgentPath: deps.agentDefs.planJudge,
        settingsPath: writeDenySettings(arenaDir, manifest),
        budgetUsd: deps.decomposeBudgetUsd ?? Math.min(10, Math.max(3, gradable.budgetUsd / 5)),
        // `dependableSlices`, not intents: the fourth reader of "what can a dependency
        // resolve against", missed by the widening. See the gap-signature comment below.
        slices: dependable,
        gradeFailureLog: grade.failureLog,
        // Read back from the ledger rather than held in memory: the escalation may have
        // happened many ticks ago, in a process that has since exited. Artifact-derived,
        // like everything else the loop believes.
        ...(escalatedUnitDetails(arenaDir, units, gradable.id).length > 0
          ? { escalatedUnits: escalatedUnitDetails(arenaDir, units, gradable.id) }
          : {}),
        ...(deps.runAgent !== undefined ? { runAgent: deps.runAgent } : {}),
      });
      appendDecomposeMetric(arenaDir, { intent: gradable.id, outcome: gap.kind, spend_usd: gap.spendUsd });
      // Anything but new units is a durable answer about THIS commit and has to be recorded as one,
      // or the intent is asked again in ninety seconds. The rung returns, and it now runs ahead of
      // every kind of new work, so an unsettled answer here does not merely waste a tick — it stops
      // ready units, maintenance units and every other intent until the consecutive-failure gate
      // halts the loop three attempts later.
      //
      // BOTH non-productive outcomes settle, and the distinction between them cost a round of
      // review to see. `empty` is the decomposer honestly finding nothing to add. `failed` is a
      // timeout, a malformed plan, or a plan-judge rejection — transient, and therefore the more
      // tempting one to retry immediately, which is exactly what would block everything else. A
      // retry is still had: the marker is keyed on HEAD, so it clears the moment anything lands,
      // and a ready unit merging elsewhere is both the likeliest next landing and the thing most
      // likely to change what the acceptance commands see.
      //
      // Only `decomposed` — the gap producing real units — leaves the intent unsettled, and it does
      // not need the marker: those units are unmerged, so `gradable` is false until they land.
      if (gap.kind !== "decomposed") markIntentSettled(arenaDir, gradable.id, settleHead);
      // ...and remember the evidence it was answered against. HEAD-keyed settlement clears
      // the moment anything lands anywhere, which for an intent blocked on a sibling slice
      // is every merge in the program; the signature clears only when this intent's own
      // acceptance fails differently, which is the only thing that can change the answer.
      //
      // `empty` only. A `failed` gap is a timeout or a rejected plan — the decomposer never
      // reached an opinion, so there is no answer to avoid re-asking, and suppressing it
      // would turn one bad spawn into a permanently unplanned intent.
      if (gap.kind === "empty" && informative) markGapAsked(arenaDir, gradable.id, signature);
      appendTick(arenaDir, {
        decision: `intent-graded-fail+gap-${gap.kind}`,
        unit: gradable.id,
        spend_usd: gap.spendUsd,
        ...(gap.kind === "failed"
          ? { detail: `${gap.reason}${gap.problems.length > 0 ? `: ${gap.problems.join("; ")}` : ""}` }
          : {}),
      });
      return { decision: `intent-graded-fail+gap-${gap.kind}`, unit: gradable.id };
    }

    // --- Rung 1: next admissible ready unit ---
    const candidates = units
      .filter((u) => !steering.veto.includes(u.id))
      .filter((u) => isAdmissible(u, satisfiedCriteria).admissible)
      .sort((a, b) => {
        const pa = steering.priority.indexOf(a.id);
        const pb = steering.priority.indexOf(b.id);
        if (pa !== pb) return (pa === -1 ? 1e9 : pa) - (pb === -1 ? 1e9 : pb);
        return a.id.localeCompare(b.id);
      });

    for (const unit of candidates) {
      const attempts = failedAttempts(arenaDir, unit.id);
      // The budget funds ITERATION, so it counts the attempts a retry can iterate ON.
      //
      // A failed attempt that recorded nothing readable handed its successor no problem
      // to answer, so the successor re-rolled the same spec. Two of those are not two
      // attempts at the unit; they are the same attempt twice, and charging the budget
      // for them exhausts the unit before the mechanism the budget pays for has run
      // once. That is not hypothetical — it is what one target's first UI unit did, and
      // raising the number there treated the symptom while leaving the count wrong.
      //
      // The second clause is what stops this being a licence to spin, and it is not
      // optional: without it a failure path that recorded nothing would retry forever,
      // and the anti-spin backstops are load-bearing here rather than ceremonial. Total
      // attempts are capped independently at twice the budget, and reaching THAT is its
      // own finding — it says the failures are not recording why, which is a defect in
      // the loop and not in the unit.
      //
      // Which is the point worth being precise about: every path that writes an
      // `outcome: "failed"` row sets a non-empty detail today, so the exemption above is
      // reachable only by rows that predate the field — or by a NEW failure path that
      // forgot to record one. The floor is how that second case surfaces as an
      // escalation naming the omission, instead of as a unit quietly re-rolling until
      // the daily gate notices the money.
      const informed = attempts.summaries.length;
      const exhausted = informed >= budgets.attemptsPerUnit;
      const spinning = attempts.count >= budgets.attemptsPerUnit * 2;
      if (exhausted || spinning) {
        const why = exhausted
          ? `attempts exhausted (${informed} of ${attempts.count} recorded a reason)`
          : `attempt floor: ${attempts.count} attempts and only ${informed} recorded a reason — the failures are not saying why`;
        flipStatus(arenaDir, join("work", `${unit.id}.md`), "escalated", `doctrine: escalate ${unit.id} (${exhausted ? "attempts exhausted" : "uninformative failures"})`);
        // The end of a unit's life belongs in the ledger. Without this row the unit is
        // absent from metrics.jsonl as anything but a run of failures — nothing says it
        // STOPPED — so a reader cannot tell an escalated unit from one still being
        // retried, and `consecutiveUnitFailures` walks straight past the moment the loop
        // gave up on it. No spend: this branch escalates before any ACT runs.
        appendUnitMetric(arenaDir, {
          unit: unit.id, outcome: "escalated",
          time_to_verified_done_s: (Date.now() - startedMs) / 1000,
          spend_usd: 0,
          attempts: attempts.count,
          reworked: attempts.count > 0,
          detail: why,
        });
        appendTick(arenaDir, { decision: "escalated", unit: unit.id, detail: why });
        return { decision: "escalated", unit: unit.id };
      }

      const runDir = join(arenaDir, ".doctrine", "runs", `${unit.id}-${Date.now()}`);
      mkdirSync(runDir, { recursive: true });
      const denyPath = writeDenySettings(arenaDir, manifest);
      const implCtx: Parameters<typeof runImplementer>[0] = {
        unit, arenaDir, baseBranch,
        worktreeDir: join(runDir, "impl"),
        logPath: join(runDir, "implementer.log"),
        agentDefinitionPath: deps.agentDefs.implementer,
        settingsPath: denyPath,
        // The summaries were already computed for the attempts check two lines up and
        // then thrown away. Routing them is the whole fix: without it a retry is an
        // independent re-roll of the same spec, not a second attempt at the problem.
        ...(attempts.summaries.length > 0 ? { priorFailures: attempts.summaries } : {}),
        ...(deps.runAgent !== undefined ? { runAgent: deps.runAgent } : {}),
      };
      const impl = await runImplementer(implCtx);

      if (impl.kind === "failed") {
        // `preserveWorktree` means the salvage commit itself failed, so the worktree is
        // the only copy of the work — the branch still points at the unchanged base, and
        // rung 0 has nothing to recover.
        //
        // Keeping it for THIS tick is not enough: the next tick's `sweepStaleWorktrees`
        // force-removes every checkout under `.doctrine/runs`, so an ordinary tick would
        // delete the only copy. Rather than teach the sweep an exemption, stop — a git
        // commit that fails with --no-verify already means something systematic (a full
        // disk, a held index lock, a broken repo), and none of those get better by
        // ticking again. This writes the pause WITHOUT `resume_at`, which is the engine's
        // existing way of saying only a person ends this.
        if (impl.preserveWorktree === true) {
          // First move the work out of the sweep's reach, and only then ask anything else
          // to protect it. `sweepStaleWorktrees` matches on the path — anything under
          // `.doctrine/runs` or `.doctrine/canary-runs` — so a worktree living anywhere
          // else is simply not a candidate for deletion. That makes the guarantee hold
          // without depending on the pause file being writable, on the supervisor reading
          // a decision it does not read, or on anyone noticing in time.
          const preservedDir = join(arenaDir, ".doctrine", "preserved", `${unit.id}-${Date.now()}`);
          let where = implCtx.worktreeDir;
          let moved = false;
          try {
            mkdirSync(dirname(preservedDir), { recursive: true });
            git(arenaDir, ["worktree", "move", implCtx.worktreeDir, preservedDir]);
            where = preservedDir;
            moved = true;
          } catch { /* reported in the reason below; the halt is what protects it then */ }

          const reason = moved
            ? `${impl.detail}; the work is the only copy and has been moved to ${where}, out of the sweep's reach`
            : `${impl.detail}; the work is the only copy, still at ${where}, and could NOT be moved out of the sweep's reach`;
          try {
            appendTick(arenaDir, { decision: "self-halt", unit: unit.id, detail: reason, awaits_observer: true });
          } catch { /* the pause below is the channel that actually stops the loop */ }
          try {
            writeFileSync(pausePath(arenaDir), `${reason}\n`);
          } catch (e) {
            // Do not swallow this. `supervise` decides whether to stop by looking for the
            // pause FILE, not at the decision returned here — so a self-halt with no pause
            // on disk is not a halt at all, and the next tick would sweep. If the work was
            // moved it is already safe and the throw is only how the operator finds out;
            // if it was not, the throw is the only thing left between here and deletion.
            throw new Error(`${reason}; and the pause file could not be written (${String(e).slice(0, 200)})`);
          }
          return { decision: "self-halt", unit: unit.id, detail: reason };
        }
        removeWorktree(arenaDir, implCtx.worktreeDir);
        // A killed run is not the same as a run that built nothing. On 2026-09-07 the
        // implementer for u-2026-09-05-invoice-review committed 1,993 lines across 14
        // files — the unit, finished, with its tests — and the wall clock fired two
        // minutes later. This branch deleted all of it, and only git's dangling-object
        // grace period made it recoverable by hand.
        //
        // So a branch carrying a commit is kept. That is not a new mechanism: a kept
        // branch is exactly the shape rung 0 already resumes, and it gets judged next
        // tick at no implement cost — the same treatment the outage path below has
        // always had. Only an empty branch is deleted, which is the leftover this
        // cleanup was written for.
        const branches = git(arenaDir, ["branch", "--list", `doctrine/${unit.id}-*`])
          .split(/\r?\n/).map((s) => s.replace(/^[*+]?\s*/, "")).filter((s) => s.length > 0);
        let keptWork = false;
        for (const b of branches) {
          if (branchHasCommit(arenaDir, b, baseBranch)) { keptWork = true; continue; }
          try { git(arenaDir, ["branch", "-D", b]); } catch { /* reaped next tick */ }
        }
        if (impl.outage) {
          appendTick(arenaDir, { decision: "no-op-outage", unit: unit.id, detail: impl.detail });
          return { decision: "no-op-outage", unit: unit.id };
        }
        if (keptWork) {
          // No unit metric. The attempt is not over — rung 0 judges this branch next tick,
          // and that judgement decides whether the unit passed or failed. A `failed` row
          // here would charge the unit for work about to be graded, and would account for
          // one attempt twice.
          appendTick(arenaDir, {
            decision: "no-op-implement-interrupted", unit: unit.id,
            detail: `${impl.detail}; the run had committed, so the branch is kept for rung 0 to judge`,
          });
          return { decision: "no-op-implement-interrupted", unit: unit.id };
        }
        appendTick(arenaDir, { decision: "implement-failed", unit: unit.id, detail: impl.detail });
        appendUnitMetric(arenaDir, {
          unit: unit.id, outcome: "failed",
          time_to_verified_done_s: (Date.now() - startedMs) / 1000,
          spend_usd: 0, attempts: attempts.count + 1, reworked: true,
          // A process that died without producing output is the instrument, not the unit:
          // nothing reached the retry and nothing is there for it to act on. `no-commit`
          // and `budget-truncated` are deliberately absent — both mean the run finished
          // and returned a result, so the failure is the unit's and is feedback a retry
          // can use. `nonzero-exit` stays charged until there is a real row to reason from.
          ...(impl.reason === "timed-out" || impl.reason === "spawn-failed" ? { instrument: true } : {}),
          detail: `implementer: ${impl.detail}`,
        });
        return { decision: "implement-failed", unit: unit.id, detail: impl.reason };
      }

      return judgeAndLand(deps, manifest, unit, impl.branch, impl.baseSha, impl.headSha, impl.worktreeDir, impl.spendUsd, startedMs);
    }

    // --- Rung 1b: build out ONE scaffolded unit (ADR-0001) ---
    //
    // After rung 1 and before any planning, and the position is the argument. A scaffold
    // is not started work — nothing has been built and no branch exists — so it does not
    // come first. But it is nearer to done than a plan that has not been written, and it
    // is the rung that REPLACES decompose: the unit already exists, minted with its epic,
    // and what is bought here is its spec, written against the tree as it then is.
    //
    // One per tick, WIP=1, exactly as rung 1 is.
    //
    // **Inert until the new epic rung mints a scaffold**, because no unit anywhere holds
    // `status: scaffold`. (A second reason used to be named here — `satisfiedCriteria`
    // resolved through the intents alone, so a scaffold's criterion dependencies would
    // have been refused even if one existed. Cutover widened it to `dependableSlices`, which
    // includes units and retired epics, so that reason is gone.)
    const buildOutLaw = deps.agentDefs.buildOut;
    const scaffolded = units
      .filter((u) => !steering.veto.includes(u.id))
      .filter((u) => isBuildable(u, satisfiedCriteria).admissible)
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    if (scaffolded !== undefined && buildOutLaw !== undefined) {
      const unitPath = `work/${scaffolded.id}.md`;
      const runDir = join(arenaDir, ".doctrine", "runs", `build-out-${scaffolded.id}-${Date.now()}`);
      mkdirSync(runDir, { recursive: true });
      const out = await runBuildOut({
        unit: scaffolded,
        arenaDir,
        unitPath,
        logPath: join(runDir, "build-out.log"),
        agentDefinitionPath: buildOutLaw,
        settingsPath: writeDenySettings(arenaDir, manifest),
        // The unit's own budget funds the work; this ACT buys the SPEC, so it takes the
        // same fifth the decompose rung takes for the same reason — it is one document,
        // not the implementation.
        budgetUsd: deps.buildOutBudgetUsd ?? Math.min(10, Math.max(3, scaffolded.budgetUsd / 5)),
        ...(deps.runAgent !== undefined ? { runAgent: deps.runAgent } : {}),
      });
      const detail = out.kind === "built"
        ? `${out.unitId} (spec appended, promoted to ready)`
        : `${out.reason}${out.problems.length > 0 ? `: ${out.problems.join("; ").slice(0, 300)}` : ""}`;
      appendDecomposeMetric(arenaDir, {
        intent: scaffolded.id,
        outcome: out.kind === "built" ? "decomposed" : "failed",
        spend_usd: out.spendUsd,
      });
      appendTick(arenaDir, {
        decision: `build-out-${out.kind}`, unit: scaffolded.id, spend_usd: out.spendUsd, detail,
      });
      return { decision: `build-out-${out.kind}`, unit: scaffolded.id, detail };
    }

    // --- Rung 2: decompose a ready intent ---
    // Skip any intent already answered "empty" at this exact commit — and take the NEXT
    // ready one rather than idling, which is what lets a frontier of two intents make
    // progress when only one of them can be sliced yet.
    const readyIntent = intents.find((i) => i.status === "ready" && !intentSettled(arenaDir, i.id, head));
    if (readyIntent !== undefined) {
      const out = await runDecompose({
        intent: readyIntent, arenaDir,
        logPath: join(arenaDir, ".doctrine", "runs", `decompose-${readyIntent.id}-${Date.now()}.log`),
        agentDefinitionPath: deps.agentDefs.decomposer,
        planJudgeAgentPath: deps.agentDefs.planJudge,
        settingsPath: writeDenySettings(arenaDir, manifest),
        // The intent's budget is the ceiling for children + decompose
        // ticks. The flat $3 default fit the arena but truncated on a real target
        // (2026-08-24, $3.07 mid-flight) — scale with the intent, capped at $10.
        budgetUsd: deps.decomposeBudgetUsd ?? Math.min(10, Math.max(3, readyIntent.budgetUsd / 5)),
        // `dependableSlices`, not intents: the fourth reader of "what can a dependency
        // resolve against", missed by the widening. See the gap-signature comment below.
        slices: dependable,
        ...((): { priorRejection?: string } => {
          const rejection = priorPlanRejection(arenaDir, readyIntent.id);
          return rejection !== undefined ? { priorRejection: rejection } : {};
        })(),
        ...(deps.runAgent !== undefined ? { runAgent: deps.runAgent } : {}),
      });
      appendDecomposeMetric(arenaDir, { intent: readyIntent.id, outcome: out.kind, spend_usd: out.spendUsd });
      // The reason travels with the RETURN as well as the ledger row. A caller that
      // learns only "decompose-failed" has to go and read ticks.jsonl to find out why,
      // and every other rung here already hands the detail back.
      const detail = out.kind === "failed"
        ? `${out.reason}${out.problems.length > 0 ? `: ${out.problems.join("; ")}` : ""}`
        : undefined;
      appendTick(arenaDir, {
        decision: `decompose-${out.kind}`,
        unit: readyIntent.id,
        spend_usd: out.spendUsd,
        ...(detail !== undefined ? { detail } : {}),
      });
      // An honest empty plan is a durable answer about THIS commit, not a question to
      // ask again in ninety seconds. It clears itself when HEAD moves.
      if (out.kind === "empty") markIntentSettled(arenaDir, readyIntent.id, head);
      return { decision: `decompose-${out.kind}`, unit: readyIntent.id, ...(detail !== undefined ? { detail } : {}) };
    }

    // --- Rung 2b: triage a raw ticket ---
    //
    // Ahead of the program rung on purpose, and behind everything that finishes work. The
    // order says: finish what is started, plan what is ready, then TRIAGE, then mint new
    // program work.
    //
    // Triage sits where it does because its output is an input to a PERSON. A triaged
    // ticket waits for approval, and approval has human latency measured in hours or days,
    // so triaging early is what keeps that queue from being the bottleneck. Minting a new
    // intent from the PRD has no such dependency and can wait a tick.
    //
    // It is also cheap next to a unit — one ACT, one judge, at most one correction — so
    // preferring it costs little when there is program work to do.
    const ticketTriager = deps.agentDefs.ticketTriager;
    const ticketJudge = deps.agentDefs.ticketJudge;
    const ticketFixer = deps.agentDefs.ticketFixer;
    if (
      manifest.program !== undefined && manifest.tickets === true
      && ticketTriager !== undefined && ticketJudge !== undefined && ticketFixer !== undefined
      // Minting work from a ticket is intake, and `intake_mode: manual` has to reach here
      // the same way it reaches the program rung.
      && steering.intakeMode !== "manual"
    ) {
      const store = deps.ticketStore ?? new GhTicketStore(arenaDir);
      let waiting: ReturnType<typeof store.needingTriage>;
      try {
        waiting = store.needingTriage();
      } catch (e) {
        // A tracker that cannot be reached is not an empty backlog. Reading it as one
        // would send the loop quietly past the whole ticket lane on an outage.
        appendTick(arenaDir, { decision: "no-op-tracker-unreachable", detail: String(e).slice(0, 200) });
        return { decision: "no-op-tracker-unreachable", detail: String(e).slice(0, 200) };
      }
      const issue = waiting[0];
      if (issue !== undefined) {
        const criteria = parseCriteria(readFileSync(join(arenaDir, manifest.program.prd), "utf8"));
        const nStore = new FileNarrowingStore(arenaDir);
        const runDir = join(arenaDir, ".doctrine", "runs", `triage-${issue.number}-${Date.now()}`);
        mkdirSync(runDir, { recursive: true });
        const out = await runTriageAct({
          arenaDir,
          issue,
          store,
          lint: {
            criteria,
            epics: nStore.load("epic").narrowings,
            features: nStore.load("feature").narrowings,
          },
          prdPath: manifest.program.prd,
          archPath: manifest.program.arch,
          logPath: join(runDir, "triage.log"),
          agentDefinitionPath: ticketTriager,
          judgeAgentPath: ticketJudge,
          fixerAgentPath: ticketFixer,
          budgetUsd: deps.triageBudgetUsd ?? 8,
          // The one label no ACT may apply, removed at the permission layer rather than
          // discouraged in a prompt. A gate the loop can satisfy on its own is not a gate.
          settingsPath: writeDenySettings(arenaDir, manifest, { extraDeny: TICKET_ACT_DENY, fileName: "claude-deny-triage.json" }),
          ...(deps.runAgent !== undefined ? { runAgent: deps.runAgent } : {}),
        });
        const detail = out.kind === "triaged"
          ? `${out.id}${out.findingsFixed > 0 ? ` (${out.findingsFixed} finding(s) corrected)` : ""}`
          : out.kind === "rejected" ? out.problems.join("; ").slice(0, 400)
          : `${out.reason}: ${out.problems.join("; ").slice(0, 300)}`;
        appendDecomposeMetric(arenaDir, {
          intent: "triage",
          outcome: out.kind === "triaged" ? "decomposed" : "failed",
          spend_usd: out.spendUsd,
        });
        appendTick(arenaDir, {
          decision: `triage-${out.kind}`,
          detail,
          spend_usd: out.spendUsd,
          ...(out.kind === "rejected" ? { problems: out.problems } : {}),
        });
        return { decision: `triage-${out.kind}`, detail };
      }
    }

    // --- Rung 3: the program rung — mint the next intents ---
    // Last, because it is the only rung that creates work rather than advancing it:
    // everything already started gets finished first. Without this the loop goes idle
    // the moment a program's intents run out and waits for a person to write the next
    // one, which is the one thing an unattended loop must never do.
    const programDecomposer = deps.agentDefs.programDecomposer;
    const programJudge = deps.agentDefs.programJudge;
    const intentFixer = deps.agentDefs.intentFixer;
    if (
      manifest.program !== undefined && programDecomposer !== undefined && programJudge !== undefined
      // The rung cannot run without a way to CORRECT what the judge finds. Without it a
      // refusal would be terminal again, which is the shape this rung was just moved off.
      && intentFixer !== undefined
      // The observer turned automatic intake off. Minting new intents is intake, and
      // the loudest possible form of it — `intake_mode: manual` has to reach here.
      && steering.intakeMode !== "manual"
    ) {
      // An intent that has already answered "empty" at THIS commit is not open work —
      // it is waiting on something to land, and nothing can land because of it. Counting
      // it as open turned the spin this PR fixed into a quieter deadlock: with every
      // ready intent settled, rung 2 selects nothing, rung 4 sees "work in progress" and
      // stands down, and the loop idles forever on a frontier that can never move,
      // because the only thing that could move it is an intent rung 4 was blocked from
      // minting (doctrine#24 review).
      //
      // **And `decomposed` is the same case, which this comment described and the code did
      // not.** An intent whose units have all merged or escalated, whose grade has run, and
      // which has answered "nothing more at this commit" is waiting on a sibling slice — it
      // has no work in flight and cannot move itself. Counting it as open was the quieter
      // deadlock arriving through the other status: on a target, one blocked
      // intent held the frontier shut and the loop idled for an hour with an entire program
      // unbuilt, because the only thing that could unblock it was a slice this rung was
      // blocked from planning.
      //
      // In flight is the test, not status. A decomposed intent with units still building is
      // open and must stay open; one with nothing building is parked, exactly as `escalated`
      // is parked below.
      // `scaffold` excluded here for the same reason it is excluded from `openUnit`
      // below, and stated rather than relied on: a scaffold carries `parent` and not
      // `intent`, so today it cannot reach this predicate at all — but if cutover ever
      // writes a unit holding both, this would count it and the frontier would shut for
      // exactly the reason the comment below describes. Two predicates asking "is there
      // open work" must agree about what open means.
      const inFlight = (id: string): boolean =>
        units.some((u) => u.intent === id && u.status !== "merged" && u.status !== "escalated" && u.status !== "scaffold");
      const openIntent = intents.some((i) => {
        if (i.status === "decomposed") return inFlight(i.id) || !intentSettled(arenaDir, i.id, head);
        return i.status === "ready" && !intentSettled(arenaDir, i.id, head);
      });
      // `escalated` is parked, not open. Counting it as open let one stuck unit stop
      // the program frontier forever, which is the exact opposite of the park-and-
      // move-on rule that keeps a stuck unit from stalling the loop.
      //
      // **`scaffold` is a plan, not work in flight, and counting it as open deadlocks the
      // ladder.** Under ADR-0006 an epic arrives with its units already scaffolded, so the
      // first epic minted makes this true and the epic LAYER can never finish — while a
      // scaffold waiting on a criterion the unwritten second epic delivers is refused by
      // `isBuildable` as an edge that cannot clear. Nothing can mint the epic that would
      // clear it, and nothing can build the unit that is waiting: the loop idles forever
      // with the program unbuilt. Found by the chain fixture on 2026-09-18, and it is the
      // same shape as the two deadlocks above — a status counted as open that nothing in
      // the loop was going to move.
      //
      // Nothing is lost by excluding it. A scaffold with its dependencies satisfied is
      // picked up by rung 1b, which sits ABOVE this one, so real work still comes first.
      const openUnit = units.some((u) => u.status !== "merged" && u.status !== "escalated" && u.status !== "scaffold");
      if (!openIntent && !openUnit && !programSettled(arenaDir, head)) {
        // --- Rung 3a: the narrowing chain (epic, then feature) ---
        //
        // Before anything mints an intent, there has to be something small enough to mint
        // it FROM, and one document could not be that thing. The program rung read the PRD
        // and the ARCH directly — 81KB on one target — and produced three intents in a
        // row whose own acceptance entries contradicted each other. The first fix was one
        // "brief" per ladder step, and a ladder step is an epic: step 3 held 14 criteria,
        // produced TWELVE intents, and its brief ran longer than the PRD it narrowed.
        //
        // So two levels. An epic is a slice of the program; a feature is a slice of an
        // epic and is what an intent is cut from. `nextChainNeed` says which is owed, from
        // committed artifacts, in a fixed order — the epic layer to completion first,
        // because features cut from a half-drawn epic layer are cut from boundaries that
        // then move underneath them.
        //
        // It sits inside this same condition on purpose: a narrowing is only owed when
        // there is no open work, which is exactly when the intent rung would otherwise run.
        const narrowingDecomposer = deps.agentDefs.narrowingDecomposer;
        const narrowingJudge = deps.agentDefs.narrowingJudge;
        const narrowingFixer = deps.agentDefs.narrowingFixer;
        const criteria = parseCriteria(readFileSync(join(arenaDir, manifest.program.prd), "utf8"));
        // One store, constructed per tick and never cached: state is re-derived from
        // artifacts every tick, and a cached store is a place for it to hide.
        const store = new FileNarrowingStore(arenaDir);
        const epicsLoaded = store.load("epic");
        // Features are parsed OUT of the epics, never loaded beside them: they are part of
        // their epic and are written with it, in one document and one ACT (ADR-0001). A
        // feature that will not parse is its epic's defect, so it joins `malformed`.
        const featuresLoaded = featuresOfEpics(epicsLoaded.narrowings.map((e) => ({ id: e.id, body: e.body, status: e.status })));
        const malformed = [...epicsLoaded.malformed, ...featuresLoaded.problems];
        if (malformed.length > 0) {
          // A narrowing that does not parse is invisible to the coverage arithmetic, so
          // carrying on would read its criteria as uncovered and mint a rival to it. Two
          // different problems with two different fixes; the loop must not conflate them.
          appendTick(arenaDir, { decision: "narrowing-malformed", detail: malformed.join("; ").slice(0, 400) });
          return { decision: "narrowing-malformed", detail: malformed.join("; ").slice(0, 400) };
        }
        const need = nextChainNeed({
          criteria: criteria.criteria.map((c) => c.id),
          epics: epicsLoaded.narrowings,
          features: featuresLoaded.features,
          // Served means COVERED, not merely touched — see `servedFeatures`. "Some intent
          // names it" let the first batch of three finish a feature holding more criteria
          // than that, dropping the rest while the chain reported complete.
          // Units as well as intents (PR #94 review). A new-shape epic arrives with its units
          // already scaffolded under each feature; checked against intents alone, every such
          // feature read as unserved, `nextChainNeed` returned `children`, and the legacy
          // program rung would have minted intents — and then units — for work the epic ACT
          // had already planned. Reachable only since `scaffold` stopped counting as open work.
          servedFeatures: servedFeatures(featuresLoaded.features, [...intents, ...units]),
        });

        // --- Rung 3a′: the set, the moment the level that produces it is COMPLETE ---
        //
        // Every gate above this reads one document, and that is why seven epics could be
        // published with two of them building the same Attention queue: each was faithful
        // to the PRD, and the defect existed only between them.
        //
        // The trigger is completion and nothing else. `nextChainNeed` no longer asking for
        // an epic IS the epic level being complete — read from artifacts like every other
        // decision here, never from a flag. A set reviewed while it is still being minted
        // reports the criteria its unwritten members were going to take.
        //
        // Per EPIC for features, not per level: `nextChainNeed` returns the first epic with
        // uncovered criteria, so reviewing the whole feature level at once would grade every
        // epic later in store order against a set still being written.
        // ONE rule for which sets are owed, shared with the operator sweep. Deciding it
        // here and again in the CLI is how the two came to disagree about the level-wide
        // review — see `reviewableSets`.
        // Hoisted out of the callback: TypeScript's narrowing of `manifest.program` does
        // not survive into a closure, and widening the guard would hide the real one.
        const programPaths = [join(arenaDir, manifest.program.prd), join(arenaDir, manifest.program.arch)];
        const setOwed = reviewableSets(criteria, epicsLoaded.narrowings, []).map((r) => ({
          review: r.review,
          docs: r.docs,
          parent: r.parentIsProgram
            ? {
              label: "the PRD and the ARCH",
              paths: programPaths,
            }
            : {
              label: r.parents.length === 1 ? `epic ${r.parents[0]!.id}` : `all ${r.parents.length} epics`,
              paths: r.parents.map((e) => join(arenaDir, e.path)),
            },
        }));

        for (const { review, docs, parent } of setOwed) {
          // The report is the record AND the key. A set whose report carries the current
          // hash has been reviewed; one whose PROSE changed has not, which is the point —
          // an epic that quietly takes over its sibling's work changes no id and no
          // `delivers` list.
          if (reviewedHash(arenaDir, review) === review.hash) continue;
          // From SCOPE, not from level. Built from `level` it read "feature-set-undefined"
          // for the level-wide review, because that one has no single epic — a decision
          // string, a commit message and a pause reason all naming nothing.
          const label = review.scope === "epics" ? "epic-set"
            : review.scope === "all-features" ? "feature-level"
            : `feature-set-${review.epicId}`;

          // The free half first, and it is the only half that can stop anything. A
          // criterion claimed by two epics is not fixable by more planning: the rung below
          // would narrow it twice and two implementers would build it. In an unattended
          // loop the honest action is to stop and say why, which is what the pause file is.
          if (review.problems.length > 0) {
            const reason = `${label}: ${review.problems.join("; ")}`;
            try {
              appendTick(arenaDir, { decision: `${label}-blocked`, detail: reason.slice(0, 400), problems: review.problems, awaits_observer: true });
            } catch { /* the pause below is the channel that actually stops the loop */ }
            try {
              writeFileSync(pausePath(arenaDir), `${reason}
`);
            } catch (e) {
              // Same reason the self-halt above refuses to swallow this: `supervise` stops
              // by looking for the pause FILE, not at the decision returned here, so a
              // block with no pause on disk is not a block at all and the next tick plans
              // features against a set that is known to be wrong.
              throw new Error(`${reason}; and the pause file could not be written (${String(e).slice(0, 200)})`);
            }
            return { decision: `${label}-blocked`, detail: reason.slice(0, 400) };
          }

          // The paid half. Advisory by construction: it gets no correction pass and no
          // retry, so a judge that is wrong costs a report and never a stalled program.
          const setJudgeLaw = deps.agentDefs.narrowingSetJudge;
          const runDir = join(arenaDir, ".doctrine", "runs", `set-${review.level}-${Date.now()}`);
          // Made here, as the narrowing branch below makes its own. `spawn` creates the
          // log's directory too, so production survives without this — which is exactly
          // why it is easy to leave out and why the sibling already had it.
          mkdirSync(runDir, { recursive: true });
          const judged = setJudgeLaw === undefined
            ? null
            : await runSetJudge(
              {
                arenaDir,
                agentDefinitionPath: setJudgeLaw,
                documentPaths: docs.map((d) => join(arenaDir, d.path)),
                totalChars: docs.reduce((n, d) => n + d.source.length, 0),
                // Only the level-wide review needs a starting order: the per-epic sets are
                // small enough to read whole, and a worklist there would send a judge
                // grepping for what is already in front of it.
                ...(review.scope === "all-features"
                  ? { candidates: crossEpicCandidates(epicsLoaded.narrowings, []) }
                  : {}),
                parent,
                verdictPath: join(runDir, "verdict.json"),
                logPath: join(runDir, "set-judge.log"),
                budgetUsd: deps.decomposeBudgetUsd ?? 20,
                settingsPath: writeDenySettings(arenaDir, manifest),
                ...(deps.runAgent !== undefined ? { runAgent: deps.runAgent } : {}),
              },
              review,
            );

          const rel = writeSetReport(arenaDir, review, judged);
          stagePaths(arenaDir, [rel]);
          engineCommit(arenaDir, `doctrine: set-coherence report for ${label}`);
          const findings = judged !== null && judged.ok ? judged.findings.length : 0;
          const detail = `${label}: ${docs.length} document(s), ${findings} advisory — ${rel}`;
          appendTick(arenaDir, { decision: `${label}-reviewed`, detail, spend_usd: judged?.spendUsd ?? 0 });
          return { decision: `${label}-reviewed`, detail };
        }

        // One narrowing ACT, one level: the epic. Features are written WITH their epic,
        // in the same document and the same ACT, so there is no feature rung to dispatch
        // — `lintFeatures` asks the only question that remains, which is whether every
        // requirement of the epic is captured in one of its features.
        if (
          need.kind === "epic"
          && narrowingDecomposer !== undefined && narrowingJudge !== undefined && narrowingFixer !== undefined
        ) {
          const level = "epic" as const;
          const runDir = join(arenaDir, ".doctrine", "runs", `narrowing-${Date.now()}`);
          mkdirSync(runDir, { recursive: true });
          const out = await runNarrowingAct({
            arenaDir,
            level,
            parent: { label: "the PRD and the ARCH", paths: [manifest.program.prd, manifest.program.arch] },
            store,
            criteria,
            existing: epicsLoaded.narrowings,
            // What the epic ACT must not collide with, and what it may depend on
            // (ADR-0006). Every unit in the repo, not only the scaffolded ones: an id is
            // taken the moment a file holds it, whatever state that unit is in.
            existingUnits: units,
            dependable,
            logPath: join(runDir, "narrowing.log"),
            agentDefinitionPath: narrowingDecomposer,
            judgeAgentPath: narrowingJudge,
            fixerAgentPath: narrowingFixer,
            budgetUsd: deps.decomposeBudgetUsd ?? 20,
            settingsPath: writeDenySettings(arenaDir, manifest),
            // Same reason every other rung has one: the revert restores the repo to the
            // identical pre-attempt state, so without the objections the retry writes the
            // same document and is refused for the same reason, forever.
            ...((): { priorRejection?: string } => {
              const r = priorNarrowingRejection(arenaDir);
              return r !== undefined ? { priorRejection: r } : {};
            })(),
            ...(deps.runAgent !== undefined ? { runAgent: deps.runAgent } : {}),
          });
          const detail = out.kind === "minted"
              // The character count is in the tick because the ceiling is not in the code:
              // a stated limit is a target, so the engine measures and says nothing, and
              // what these runs actually produce is answerable from the ledger. The unit
              // count rides along for the same reason: ADR-0006 names epic size as the
              // risk it takes on, and this is what makes it answerable from the ledger
              // rather than from anyone's impression.
              ? `${level} ${out.id}, ${out.bodyChars} chars, ${out.units.length} unit(s) scaffolded${out.findingsFixed > 0 ? `, ${out.findingsFixed} finding(s) corrected` : ""}`
            : out.kind === "empty" ? out.detail
            : out.kind === "rejected" ? out.problems.join("; ").slice(0, 400)
            : `${out.reason}: ${out.problems.join("; ").slice(0, 300)}`;
          appendDecomposeMetric(arenaDir, {
            intent: level,
            outcome: out.kind === "minted" ? "decomposed" : out.kind === "empty" ? "empty" : "failed",
            spend_usd: out.spendUsd,
          });
          appendTick(arenaDir, {
            decision: `${level}-${out.kind}`,
            detail,
            spend_usd: out.spendUsd,
            ...(out.kind === "rejected" ? { problems: out.problems } : {}),
          });
          return { decision: `${level}-${out.kind}`, detail };
        }

        if (need.kind === "unmeasurable") {
          // Loud, not idle. See the `unmeasurable` arm in narrowing.ts.
          appendTick(arenaDir, { decision: "chain-unmeasurable", detail: need.detail });
          return { decision: "chain-unmeasurable", detail: need.detail };
        }

        if (need.kind === "complete") {
          // Every criterion is claimed down to a feature and every feature has intents.
          // A durable answer about this commit, like an empty plan; it clears itself the
          // moment HEAD moves. Re-read HEAD because the ACTs above commit.
          markProgramSettled(arenaDir, git(arenaDir, ["rev-parse", "HEAD"]), "the narrowing chain is complete");
          const stalled = pauseIfStalled(arenaDir, "chain-complete");
          if (stalled !== undefined) return stalled;
          appendTick(arenaDir, { decision: "chain-complete" });
          return { decision: "chain-complete" };
        }

        // ONE PATH: an intent is cut from a feature or it is not cut.
        //
        // This used to fall back to the PRD and the ARCH when no narrowing existed, and
        // the fallback was the defect rather than a convenience. It meant two routes to
        // the same artifact — one where an intent is checked against a narrow document
        // that was itself checked against its parent, and one where it is checked against
        // eighty thousand characters with no coverage check anywhere — and which route a
        // run took depended on whether a file happened to be on disk.
        //
        // Reaching here with no feature means the chain above did not produce one, which
        // is its failure to report. `need` is already computed; only the `children` arm
        // has a feature to cut from, and every other arm returned above.
        if (need.kind !== "children") {
          return { decision: "no-op-awaiting-narrowing", detail: `the chain owes a ${need.kind} — an intent is cut from a feature or not at all` };
        }
        const currentFeature = need.feature;

        const runDir = join(arenaDir, ".doctrine", "runs", `program-decompose-${Date.now()}`);
        mkdirSync(runDir, { recursive: true });
        const priorRejection = priorProgramRejection(arenaDir);
        const programDenyPath = writeDenySettings(arenaDir, manifest);
        const out = await runProgramDecompose({
          settingsPath: programDenyPath,
          intentFixerAgentPath: intentFixer,
          arenaDir,
          prdPath: manifest.program.prd,
          archPath: manifest.program.arch,
          // Read INSTEAD of the PRD and the ARCH — the substitution is the whole point of
          // the rung above, and passing both would put the eighty thousand back.
          // The epic IS the source now — the feature is a heading inside it, so there is no
          // separate document to point at. `feature` carries the id and what that heading
          // delivers, which is all the arithmetic below reads.
          featurePath: need.epic.path,
          feature: { id: currentFeature.id, delivers: currentFeature.delivers },
          existing: intents,
          logPath: join(runDir, "program-decompose.log"),
          agentDefinitionPath: programDecomposer,
          programJudgeAgentPath: programJudge,
          budgetUsd: deps.decomposeBudgetUsd ?? 20,
          // Without this the planner re-mints the rejected intents every tick: the
          // revert restores the repo to the identical pre-attempt state, so nothing
          // about its next run differs. The rung below learned this the same way.
          ...(priorRejection !== undefined ? { priorRejection } : {}),
          ...(deps.runAgent !== undefined ? { runAgent: deps.runAgent } : {}),
        });
        const detail = out.kind === "minted"
            ? `${out.intentIds.join(", ")}${out.findingsFixed > 0 ? ` (${out.findingsFixed} finding(s) corrected)` : ""}`
          : out.kind === "empty" ? out.detail
          : out.kind === "rejected" ? out.problems.join("; ").slice(0, 400)
          : `${out.reason}: ${out.problems.join("; ").slice(0, 300)}`;
        // Metrics, not just ticks: the daily spend gate reads metrics.jsonl only, so a
        // rung that reported cost through appendTick alone spent outside every budget.
        appendDecomposeMetric(arenaDir, {
          intent: "program",
          outcome: out.kind === "minted" ? "decomposed" : out.kind === "empty" ? "empty" : "failed",
          spend_usd: out.spendUsd,
        });
        // `program-rejected` is its own decision, so the retry can find a real objection
        // by looking for one rather than by matching a substring of a shared wrapper.
        appendTick(arenaDir, {
          decision: `program-${out.kind}`,
          detail,
          spend_usd: out.spendUsd,
          // Verbatim, because the next attempt reasons about these. `detail` above is
          // the summary a person reads; it is clipped and must never be the input.
          ...(out.kind === "rejected" ? { problems: out.problems } : {}),
        });
        // An empty frontier at this commit is a durable answer, not a question to ask
        // again every idle interval. It clears itself the moment HEAD moves.
        if (out.kind === "empty") {
          // "Nothing more to mint" means this feature is finished — but only if it
          // actually is. The planner saying it has nothing left while criteria of its own
          // feature reach no intent is a CONTRADICTION, and flipping the feature done on
          // that word is how requirements get dropped silently.
          const mine = intents.filter((i) => i.parent === currentFeature.id);
          const cover = lintChildren({ id: currentFeature.id, delivers: currentFeature.delivers }, mine);
          if (cover.ok) {
            // Nothing to mark: a feature has no status. `servedFeatures` computes whether
            // its units cover it, so the next tick reaches the same conclusion from the
            // artifacts rather than from a flag somebody had to remember to set.
          } else {
            // Loud, and settled at HEAD so it does not spin: the same durable-answer
            // mechanism the plan rung uses for an empty plan. It clears itself the moment
            // anything lands, because a moved HEAD is a different question.
            markProgramSettled(arenaDir, git(arenaDir, ["rev-parse", "HEAD"]), `feature ${currentFeature.id} is incomplete and its planner has nothing to add`);
            appendTick(arenaDir, { decision: "feature-incomplete", detail: cover.problems.join("; ").slice(0, 400), problems: cover.problems });
            return { decision: "feature-incomplete", detail: cover.problems.join("; ").slice(0, 400) };
          }
        }
        return { decision: `program-${out.kind}`, detail };
      }
    }

    const stalled = pauseIfStalled(arenaDir, "idle");
    if (stalled !== undefined) return stalled;
    appendTick(arenaDir, { decision: "idle" });
    return { decision: "idle" };
  } finally {
    lease.release();
  }
}
