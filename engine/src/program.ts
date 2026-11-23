import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildClaudeArgv } from "./argv.js";
import { describeTampering, engineStateTampering, restoreEngineState, snapshotEngineState } from "./engine-state.js";
import { engineCommit, stagePaths } from "./git-commit.js";
import { parseIntent, type Intent } from "./intent.js";
import { lintChildren, type Narrowing } from "./narrowing.js";
import { isolatedCwd, type RunAgentFn } from "./judge.js";
import type { RunFailureReason } from "./outcome.js";
import { classifySpawn, runAgent as productionRunAgent } from "./spawn.js";

type ProgramJudgeRun =
  /** The judge RAN. `findings` is what it found; empty means there is nothing to correct. */
  | { ok: true; findings: string[]; spendUsd: number }
  /** The judge could not run, could not report, or did not look. Not a fault in the plan. */
  | { ok: false; problems: string[]; outage: boolean; spendUsd: number };

/**
 * The program rung. One level above decompose: where the decompose ACT
 * turns one intent into units, this turns a PRD + ARCH into the next one to three
 * intents, and it runs when the intent frontier is empty and the program is not done.
 *
 * Without it an app-sized program stalls on a person. That is not a theory — one
 * target's harness intent finished, the loop went idle, and it *had* to wait,
 * because nothing in the engine could look at the PRD and say what came next. A loop
 * that cannot find its own next work is a loop someone has to remember to feed.
 *
 * Two rules, both enforced here rather than requested:
 * **at most three intents a run**, because a program decomposed up front is a plan
 * that reality has not touched; and **the walking skeleton first**, so every later
 * intent lands on a running system and grades against it from day one.
 */

export interface ProgramContext {
  arenaDir: string;
  /** Repo-relative paths, from the manifest's `program` block. */
  prdPath: string;
  archPath: string;
  /**
   * The FEATURE this intent set is cut from. **Required — there is one path, and it runs
   * through the narrowing chain.**
   *
   * It REPLACES the PRD and the ARCH in this ACT's task; that substitution is the entire
   * reason the rung above exists. Reading 81KB is what produced three intents running
   * whose own acceptance entries contradicted each other, and handing over both the brief
   * and its sources would put that back.
   *
   * It was optional, with a PRD/ARCH fallback, and the option was the defect. A fallback
   * means two paths to the same artifact: one where an intent is checked against the
   * narrow document that was itself checked against its parent, and one where it is
   * checked against the whole program with no coverage check anywhere. Which path a run
   * took depended on whether a file happened to exist. An intent may only be cut from a
   * feature; no feature is a refusal, not a different route.
   */
  featurePath: string;
  /** The feature itself, for hop 3's arithmetic — its `delivers` bound what the intents may claim. */
  /**
   * Structural, not a `Narrowing`: a feature is a TRACE inside its epic (ADR-0001) and
   * only its id and the criteria it delivers are read here. Widening rather than importing
   * `Feature` keeps this module ignorant of where a feature lives, which is the same
   * reason `lintChildren` takes a shape instead of a document.
   */
  feature: { id: string; delivers: readonly string[] };
  /** The law for the pass that ADDRESSES findings. See `runIntentFix` for why it exists. */
  intentFixerAgentPath: string;
  /** The correction pass's budget. Defaults to half: it addresses a list, it does not plan. */
  fixBudgetUsd?: number;
  /** Every intent already on disk — minted ones must not duplicate or rival these. */
  existing: readonly Intent[];
  logPath: string;
  agentDefinitionPath: string;
  programJudgeAgentPath: string;
  budgetUsd: number;
  programJudgeBudgetUsd?: number;
  /** Deny-rules settings file (one-way doors) passed to the CLI, as the other writers get. */
  settingsPath?: string;
  /** The judge's objections to the LAST attempt, so a retry converges instead of
   *  re-minting the same intents until the failure halt trips. */
  priorRejection?: string;
  timeoutMs?: number;
  runAgent?: RunAgentFn;
}

export type ProgramOutcome =
  | { kind: "minted"; intentIds: string[]; spendUsd: number; findingsFixed: number }
  | { kind: "empty"; detail: string; spendUsd: number }
  /**
   * The judge looked at the intents and refused them. This is the ONLY outcome whose
   * reasons are worth handing to the next attempt — it is an argument about the plan.
   * Kept separate from `failed` because it used to share its wrapper string, and a
   * prefix check on that string cheerfully accepted "program-judge rejected the
   * intents: program-judge timed-out", feeding a harness fact back as an objection.
   */
  | { kind: "rejected"; problems: string[]; spendUsd: number }
  | { kind: "failed"; reason: string; outage: boolean; problems: string[]; spendUsd: number };

/** At most this many intents per run. A program planned to the end is fiction. */
export const MAX_INTENTS_PER_RUN = 3;

/** A newline, written this way because a literal one here gets mangled by shell edits. */
const LF = String.fromCharCode(10);

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function agentLaw(path: string): string {
  const text = readFileSync(path, "utf8");
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return (m ? m[1]! : text).trim();
}

/** Only `work/intents/` may change. Anything else and the run is reverted wholesale. */
const ALLOWED_TOUCH = /^work\/intents\/[^/]+\.md$/;

function changedFiles(arenaDir: string): { allowed: string[]; forbidden: string[] } {
  const allowed: string[] = [];
  const forbidden: string[] = [];
  for (const line of git(arenaDir, ["status", "--porcelain", "-uall"]).split(/\r?\n/)) {
    // Parse by PATTERN, not by position, and the distinction is a real defect rather than
    // a preference. `git()` trims its whole output, which eats the leading space of the
    // first line — so a MODIFIED tracked file that happens to sort first arrives as
    // `M docs/program/PRD.md`, not ` M docs/program/PRD.md`. Against `/^..\s+/` that is
    // "M" + " " consumed by the two dots, leaving `\s+` to match the `d` of `docs`. It
    // does not, the line is skipped, and the modification is INVISIBLE to the guard.
    //
    // Which means an ACT on this rung could edit the PRD, the ARCH, its own feature or
    // `context/contracts.md` and be reported as having touched nothing — the one-way
    // doors this function exists to watch. Found 2026-09-13 by a test written for the new
    // correction pass; it was never specific to that pass, and the planner had the hole
    // from the beginning.
    //
    // `decompose.ts` gets this right, with a comment saying exactly why. That is the
    // shape this repo has now paid for six times: two implementations of one rule, and
    // only one of them got the fix.
    const m = /^[ MADRCU?!]{1,2}\s+(.+)$/.exec(line);
    if (!m) continue;
    const file = m[1]!.trim().replace(/^"|"$/g, "");
    if (file.startsWith(".doctrine/")) continue; // engine-owned runtime state
    (ALLOWED_TOUCH.test(file) ? allowed : forbidden).push(file);
  }
  return { allowed, forbidden };
}

/**
 * Undo everything the ACT did. `paths` is what it actually touched — cleaning exactly
 * those is the difference between "reverted" and "reverted except the untracked file
 * it was not allowed to write". `git clean -fd -- work` alone left a stray `src/app.ts`
 * on disk after a run that was reported as reverted wholesale, which is a lie the next
 * tick would have inherited.
 */
function revertAll(arenaDir: string, paths: readonly string[] = []): void {
  git(arenaDir, ["checkout", "--", ".", ":(exclude).doctrine"]);
  const targets = ["work", ...paths.filter((p) => !p.startsWith(".doctrine/"))];
  try {
    git(arenaDir, ["clean", "-fd", "--", ...targets]);
  } catch {
    git(arenaDir, ["clean", "-fd", "--", "work"]); // a path git will not accept must not block the revert
  }
}

/**
 * Review findings the loop deferred and still owes, as maintenance the program rung can mint.
 *
 * `handleReview` writes these when it merges a unit with a finding still open, and tells the
 * reviewer they "enter intake as a maintenance unit". That was not true: nothing read the
 * directory. No engine code touched it, and no agent's law listed it — the decomposer is told
 * to read `context/contracts.md`, `context/decisions.md` and `context/defects/`, and that is
 * all. Seven files had accumulated on one target, and one held a defect that was found,
 * deferred, never reaped, and rediscovered by the promotion review three days
 * later — the loop paying twice to learn the same thing.
 *
 * `context/defects/` was the tempting home, because the decomposer already reads it. It is the
 * wrong one: that is a registry of defects already FIXED, each with its ratchet guard, and
 * filling it with outstanding work would destroy what it means.
 *
 * Fed here rather than left for an agent to go looking: D7's guardrail is that load-bearing
 * context is retrieved deterministically, and a finding nobody is guaranteed to read is the
 * exact state this ends. No "reaped" marker travels with it — that would be a new piece of
 * state with several readers, and the program judge already refuses intents that duplicate
 * what is built. A re-mint costs one rejected ACT; a marker costs a class of bug this engine
 * has produced four times.
 */
export function readOutstandingFindings(arenaDir: string): string {
  const dir = join(arenaDir, "context", "review-findings");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8").trim())
    .filter((t) => t.length > 0)
    .join("\n\n");
}

export function assembleProgramDecomposerPrompt(ctx: ProgramContext): string {
  const built = ctx.existing.length === 0
    ? "None. This is the first intent of the program, so it is the walking skeleton."
    : ctx.existing.map((i) => `- ${i.id} [${i.status}] ${i.title}`).join("\n");
  const rejection = ctx.priorRejection === undefined
    ? ""
    : `\n## Your last attempt was rejected — do not repeat it\n${ctx.priorRejection}\n`;
  const findings = readOutstandingFindings(ctx.arenaDir);
  const outstanding = findings.length === 0 ? "" : `
## Maintenance this program already owes

Review findings the loop merged past and recorded rather than fixed. They are defects in code
that is already live, not new product. An intent still has to trace to the PRD or the ARCH, and
that is what decides how a finding gets paid off.

Where the CORRECTED behaviour is something the PRD or ARCH already requires — an invoice pushed
once, a figure that can be traced to its source — a maintenance intent is legitimate: cite the
requirement the live code fails, not the finding, and its acceptance is that the requirement now
holds. Where the corrected behaviour is required by neither, do not mint for it; say so in
whichever intent you are already minting that touches the code the finding names, and let that
intent's acceptance cover it. A finding in code nothing here touches waits for work that does.

${findings}
`;
  return `${agentLaw(ctx.agentDefinitionPath)}

---

# The program

- YOUR SOURCE, and the only one you need: ${ctx.featurePath}

  It is one rung of the program's ladder, already narrowed from the PRD and the ARCH and
  already checked against them in both directions. Mint intents for THIS step only. Do not
  go looking for the PRD or the ARCH to second-guess it — everything binding was carried
  across, and reaching past it is how an intent picks up scope from a step that is not
  being built yet.

Read both from the repository root, which is your working directory.

**Your tools are \`Read\`, \`Grep\`, \`Glob\` and \`Write\`, and nothing else.** There is no
\`Bash\`, no \`Edit\`, no \`PowerShell\`. A call to one is denied unanswered and costs you a turn
of a budget you are paying for out of the same purse as the work — two attempts on
2026-09-10 spent four turns each that way. To change a file you have already written,
write the whole file again with \`Write\`. Do not try to RUN the acceptance commands you are
drafting: you cannot, and the rung below you is what runs them.

## Intents that already exist
${built}
${outstanding}${rejection}
## Your task

Mint the next 1 to ${MAX_INTENTS_PER_RUN} intents, as \`work/intents/<id>.md\`, each with
\`status: proposed\` and drafted acceptance evidence. Write nothing else — not a work
unit, not a contract, not a line of code.

Every intent carries two fields that tie it to the feature above it, and the engine
refuses the run without them:

- \`parent: ${ctx.feature.id}\` — the feature it is cut from, named with the same field an
  epic and a feature use because it is the same edge. Without it the intent is an orphan:
  nothing can check it against a parent, so its coverage claim answers to no one.
- \`level: intent\` — what kind of artifact this is.
- \`delivers: [...]\` — the criterion ids it accounts for, **a subset of this feature's**:
  ${ctx.feature.delivers.join(", ")}. An id outside that list is scope the feature has no
  record of, and the run is refused before a judge is paid. An intent may legitimately
  cover NOTHING if it is pure structural work — say so in the body, and know that the
  engine reports it rather than hiding it.

Every acceptance entry must be a command that is **self-verifying**: the engine runs it
and takes exit 0 as met, so a command that merely prints a number proves nothing. An
acceptance list where nothing would fail against the tree as it stands today is a list
that grades nothing.
`;
}

interface ProgramVerdict {
  verdict: "pass" | "fail";
  intents: Array<{ id: string; ok: boolean; cite: string; problems: string[] }>;
  coverage_check: string;
  /** The other direction: what the source still lists as remaining, and who takes it. */
  nothing_dropped?: string;
}

function assembleProgramJudgePrompt(ctx: ProgramContext, minted: readonly Intent[], files: readonly string[], verdictPath: string): string {
  const bodies = files
    .map((f) => `--- ${f} ---\n${readFileSync(join(ctx.arenaDir, f), "utf8").trim()}`)
    .join("\n\n");
  return `${agentLaw(ctx.programJudgeAgentPath)}

---

# What you are judging

${minted.length} newly minted intent(s), against the program that is supposed to have
produced them.

- THE FEATURE these intents were minted from, and the document they answer to:
  ${join(ctx.arenaDir, ctx.featurePath)}

  This is your source, not the PRD and not the ARCH — there is no other path, and a run
  where the PRD stood in for the feature is a run this engine no longer performs. The
  planner was told the feature is "YOUR SOURCE, and the only one you need", and a judge
  grading against a document its planner was forbidden to read fails faithful work and
  passes work that reached past its own slice. The feature was itself checked against its
  PRD and the ARCH by the rung above you, in both directions; that hop is not yours to
  re-litigate.
- repository root: ${ctx.arenaDir}

Read them all by ABSOLUTE path. The repository is **not** your working directory — you
run from an empty scratch directory outside every repository, so the harness cannot
hand you the minting commit's own subject line. A relative path resolves inside that
empty directory and will look like a missing file, which is evidence of nothing.

**Your tools are \`Read\`, \`Grep\`, \`Glob\` and \`Write\`, and nothing else.** There is no
\`Bash\`, no \`Edit\`, no \`PowerShell\`. A call to one is denied unanswered and costs you a turn
of the budget you need to finish ruling — on 2026-09-10 a judge spent eight turns on denied
calls, then ran out one write short of its own verdict. Judge by READING the tree, never by
running it. To correct a verdict you have already written, write the whole file again with
\`Write\`.

## Intents already in the program
${ctx.existing.map((i) => `- ${i.id} [${i.status}] ${i.title}`).join("\n") || "(none)"}

## The minted intents
${bodies}

## Write your verdict to EXACTLY: ${verdictPath}

\`\`\`json
{
  "verdict": "pass" | "fail",
  "intents": [{ "id": "...", "ok": true, "cite": "the source text this intent serves, quoted from the document named above", "problems": [] }],
  "coverage_check": "what you checked in the repo to confirm these are not already built, and what you found",
  "nothing_dropped": "an account of your source's remaining slices: for each, the intent that takes it, or that it is still outstanding. Outstanding is a PASS — the ceiling is three intents and a source may take several rounds. What fails is a slice a minted intent takes only PART of, because an intent reaching done then reports the ungraded part as built."
}
\`\`\`
`;
}

async function runProgramJudge(
  ctx: ProgramContext,
  minted: readonly Intent[],
  files: readonly string[],
): Promise<ProgramJudgeRun> {
  const runDir = join(ctx.arenaDir, ".doctrine", "runs", `program-${Date.now()}`);
  mkdirSync(runDir, { recursive: true });
  const verdictPath = join(runDir, "program-verdict.json");
  const invoke = ctx.runAgent ?? productionRunAgent;
  const scratch = isolatedCwd("program-judge");
  let spawned;
  try {
    spawned = await invoke(assembleProgramJudgePrompt(ctx, minted, files, verdictPath), {
      argv: buildClaudeArgv({
        // The act's budget, as every other verdict-issuing judge gets (`judge.ts`,
        // `plan-judge.ts`). A flat $5 made this the one judge whose ceiling did not
        // move with the work under it, and on one target it ran out
        // mid-verdict — the ruling was reasoned, the file was written `pass`, and the
        // correction to `fail` never landed, so the engine discarded a real judgement
        // as an outage and the failure halt counted it. A cap is a ceiling and not a
        // target: a judge that needs $2 still spends $2.
        maxBudgetUsd: ctx.programJudgeBudgetUsd ?? ctx.budgetUsd,
        allowedTools: ["Read", "Grep", "Glob", "Write"],
        addDirs: [ctx.arenaDir],
        permissionMode: "dontAsk",
      }),
      cwd: scratch,
      timeoutMs: ctx.timeoutMs ?? 10 * 60_000,
      logPath: join(runDir, "program-judge.log"),
    });
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
  }

  const spendUsd = spawned.resultMessage?.total_cost_usd ?? 0;
  const failure = classifySpawn(spawned);
  if (failure !== null) return { ok: false, problems: [`program-judge ${failure}`], outage: spawned.outage, spendUsd };
  if (!existsSync(verdictPath)) {
    return { ok: false, problems: ["program-judge wrote no verdict — a judge that cannot report FAILS the run"], outage: false, spendUsd };
  }
  let v: ProgramVerdict;
  try {
    v = JSON.parse(readFileSync(verdictPath, "utf8")) as ProgramVerdict;
  } catch (e) {
    return { ok: false, problems: [`program-judge verdict is not JSON: ${String(e).slice(0, 120)}`], outage: false, spendUsd };
  }
  // --- the judge's PRODUCT is findings, and the verdict line is no longer a door ---
  //
  // Whatever the verdict says, anything it wrote against an intent is a finding and
  // anything it marked not-ok is a finding. A verdict that "passes" while an entry is
  // not ok is not a contradiction to resolve; it is a judge that found something and
  // rounded it off, and taking the entries as authoritative costs nothing.
  const stated = (i: { problems?: string[] }): string[] =>
    (i.problems ?? []).filter((x) => typeof x === "string" && x.trim().length > 0);
  const findings: string[] = (v.intents ?? []).flatMap((i) => stated(i).map((x) => `${i.id}: ${x}`));

  // --- a judge that cannot say WHAT is wrong has not reported, and that is not a finding ---
  //
  // A finding is an instruction a correction pass carries out on an intent. With nothing
  // named, there is nothing to carry out — and any unrelated byte the pass changes then
  // satisfies the "changed something" guard, the paid judge is never re-run, and the
  // original defect is promoted to `ready`. So both shapes fail the RUN and the engine
  // buys another judge. Kept identical to `runNarrowingJudge`, which refuses the same two
  // things for the same reason; that rung had only one of them until external review
  // caught it on 2026-09-13.
  const unreported = (v.intents ?? [])
    .filter((i) => i.ok !== true && stated(i).length === 0)
    .map((i) => `${i.id}: marked not ok with no reason given — a finding that names nothing cannot be acted on`);
  if (unreported.length > 0) {
    return { ok: false, problems: unreported, outage: false, spendUsd };
  }
  if (v.verdict !== "pass" && findings.length === 0) {
    return { ok: false, problems: ["program-judge refused the intents without saying what is wrong with any of them"], outage: false, spendUsd };
  }
  // A pass has to be a pass ABOUT SOMETHING, and about all of it.
  //
  // Checking only the entries that happen to be present made the gate optional: a verdict
  // of `{"verdict": "pass", "intents": []}` cleared it, so did one that silently omitted a
  // minted intent, and so did one whose entries were marked `ok: false` — and every draft
  // was promoted to `ready` regardless. The gate failed open exactly when the judge's output
  // was incomplete or self-contradictory, which is when it was most needed.
  //
  // So the verdict must account for the minted set: every intent judged, nothing invented,
  // each entry ok, each carrying a citation. Any shortfall is a rejection, not a pass.
  //
  // These are NOT findings and can never become them: each one says the judge did not do
  // its job, and there is nothing in an intent for a correction pass to change in
  // response. Handing them to a fixer would launder an unperformed check into a corrected
  // one. So they fail the RUN and the engine pays for another judge.
  const judged = new Map((v.intents ?? []).map((i) => [i.id, i]));
  const problems: string[] = [];
  for (const m of minted) {
    const j = judged.get(m.id);
    if (j === undefined) {
      problems.push(`${m.id}: the judge reported no result for this intent at all`);
      continue;
    }
    // `ok !== true`, not `ok === false`. The verdict is unvalidated external JSON cast to a
    // type, so a missing, null or otherwise malformed `ok` is not an affirmation — and
    // checking only for the literal `false` let every one of those promote a draft. That is
    // the same failing-open shape this whole change exists to close, one field deeper.
    // `ok !== true` is handled above, as a FINDING — it is the judge reporting something
    // about the intent, which is exactly what a correction pass acts on. What is checked
    // here is whether the judge reported at all.
    //
    // A pass that does not cite is not a pass — the same cite-or-fail law the plan-judge
    // runs on. An uncited `ok: true` is a judge that did not look, not an intent with a
    // fault, so it belongs here and not in the findings.
    if (j.ok === true && (typeof j.cite !== "string" || j.cite.trim().length === 0)) {
      problems.push(`${m.id}: passed with no citation from its source document`);
    }
  }
  // And the other direction, which the ladder had nowhere at all: a pass must ACCOUNT for
  // what the source still lists as remaining.
  //
  // Account for, not finish. The schema said "no intent takes it, which is a fail" and
  // external review caught that it contradicts the judge's own law two files over, which
  // says naming the outstanding slices IS a pass. A judge following the schema would have
  // rejected every partial batch — and since the ceiling is three intents, every source
  // needing a fourth would have been unable to progress at all. The failure this field
  // exists for is a slice taken only in PART, not a slice honestly left for next time.
  //
  // Every gate on this ladder checked that nothing was INVENTED and not one checked that
  // nothing was DROPPED, so an intent set that faithfully served half its brief passed
  // exactly like one that served all of it. Blank is not an answer: a judge that cannot
  // say what is left has not looked, and "nothing remains" is a claim it is free to make
  // and be wrong about — which a later brief or grade then catches.
  if (typeof v.nothing_dropped !== "string" || v.nothing_dropped.trim().length === 0) {
    problems.push("the verdict passes without accounting for what the source still lists as remaining (`nothing_dropped` is blank)");
  }
  const mintedIds = new Set(minted.map((m) => m.id));
  for (const id of judged.keys()) {
    if (!mintedIds.has(id)) problems.push(`${id}: judged, but no such intent was minted`);
  }
  if (problems.length > 0) return { ok: false, problems, outage: false, spendUsd };
  return { ok: true, findings, spendUsd };
}

/**
 * One budgeted program-decompose ACT, then the same two gates the plan gets: a
 * mechanical lint on shape, and a judge on meaning. Promotion is `proposed → ready`,
 * performed by the engine, never by the ACT and never by a person.
 */
/**
 * Where a refused draft is kept so the next attempt can revise it.
 *
 * Committed, not scratch: the loop re-derives its state from artifacts every tick
 * (design D6), and an objection the planner can only act on while one process stays
 * alive is not state, it is a memory.
 */
export function rejectedDraftDir(arenaDir: string): string {
  return join(arenaDir, ".doctrine", "rejected");
}

/** The file the shelf keeps its objections in, beside the drafts they are about. */
const OBJECTIONS_FILE = "objections.md";

/**
 * The reasons the judge last refused, read from the shelf rather than the ledger.
 *
 * `.doctrine/ticks.jsonl` is not committed — it is a local append-only log — so in a
 * fresh clone the objections were gone while the shelved drafts survived, and the
 * planner was handed a draft with no idea what was wrong with it. Worse, the caller
 * gave up before even that. The shelf now carries both halves and stands alone.
 */
export function readRejectedObjections(arenaDir: string): string {
  const path = join(rejectedDraftDir(arenaDir), OBJECTIONS_FILE);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

/**
 * The drafts the judge last refused, verbatim.
 *
 * The revert wipes `work/intents/` back to the pre-attempt state, which is right — a
 * refused intent must never be visible to the decompose rung as though it were real
 * work. But it also meant the next attempt was handed a critique of a document that
 * no longer existed anywhere, so it did the only thing it could: wrote a NEW intent
 * from scratch, with new holes. Two attempts, ~$17, and the second shared not one
 * paragraph with the first. Revision needs the thing being revised.
 */
export function readRejectedDrafts(arenaDir: string): string {
  const dir = rejectedDraftDir(arenaDir);
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== OBJECTIONS_FILE)
    .sort()
    .map((f) => `### ${f}\n\n${readFileSync(join(dir, f), "utf8").trim()}`)
    .join("\n\n");
}

/** Shelve the refused drafts, then clear the shelf once something is accepted. */
function shelveRejected(arenaDir: string, files: readonly string[], problems: readonly string[]): void {
  const dir = rejectedDraftDir(arenaDir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const src = join(arenaDir, f);
    if (!existsSync(src)) continue;
    writeFileSync(join(dir, f.split(/[/\\]/).pop()!), readFileSync(src, "utf8"));
  }
  const objections = problems.map((x, n) => `${n + 1}. ${x}`).join("\n\n");
  if (objections.length > 0) writeFileSync(join(dir, OBJECTIONS_FILE), `${objections}\n`);
}

/**
 * Empty the shelf. Exported because a NEW BRIEF makes it stale.
 *
 * The shelf exists so a refused plan is revised rather than re-invented, and that is only
 * sound while the planner is answering the same question from the same sources. A brief
 * changes both. On 2026-09-08 the first brief narrowed the planner's source to 27KB and
 * the shelf handed it back 108KB of drafts minted from the whole PRD — two of them for a
 * ladder step the new brief does not cover — and the run timed out at thirty minutes with
 * more context than it had before the brief existed.
 */
export function clearRejected(arenaDir: string): void {
  rmSync(rejectedDraftDir(arenaDir), { recursive: true, force: true });
}

/** One intent as it was written, with the path it was written to. Kept together. */
interface Draft {
  intent: Intent;
  /** Repo-relative, and the name every finding about this intent quotes. */
  file: string;
}

/**
 * Everything the engine can decide about a minted set for FREE.
 *
 * Extracted because these are now FINDINGS rather than a refusal: they used to revert the
 * whole run, and they now describe what is wrong with it in the same list the judge's
 * observations go into, so one pass corrects both. The engine re-runs this after that
 * pass — it costs nothing, so unlike the judge it can afford to be a gate.
 *
 * Parse failures are NOT here. They are the one hard refusal on this rung, because a
 * correction pass needs something to correct and a judge needs something to judge.
 *
 * It takes PAIRS rather than two parallel arrays, and that is not tidiness. The first
 * version indexed `files[i]` against `minted[i]`, which was correct only while nothing
 * could be skipped while building `minted` — a precondition that held, was load-bearing,
 * and was written down nowhere near the indexing. An earlier shape of this function DID
 * skip (it pushed only intents that parsed), and every filename after a skip would have
 * been attributed to the wrong intent: a finding naming a file that is fine, about a
 * fault in one that is not. Pairing them makes the property structural instead of
 * remembered.
 */
function mechanicalIntentFindings(ctx: ProgramContext, drafts: readonly Draft[]): string[] {
  const problems: string[] = [];
  const minted = drafts.map((d) => d.intent);
  const existingIds = new Set(ctx.existing.map((i) => i.id));
  for (const { intent, file: f } of drafts) {
    if (intent.status !== "proposed") {
      problems.push(`${f}: the ACT must write proposed intents, found status "${intent.status}"`);
    }
    if (intent.evidence.length === 0) {
      problems.push(`${f}: no acceptance evidence — an intent without it can never grade`);
    }
    if (existingIds.has(intent.id)) {
      problems.push(`${f}: id "${intent.id}" already exists in the program`);
    }
    if (!f.endsWith(`${intent.id}.md`)) {
      problems.push(`${f}: filename does not match the intent id "${intent.id}"`);
    }
  }
  if (minted.length > MAX_INTENTS_PER_RUN) {
    problems.push(`minted ${minted.length} intents; the ceiling is ${MAX_INTENTS_PER_RUN} — a program planned to the end is fiction`);
  }

  // --- hop 3, mechanically ---
  //
  // Every intent belongs to the feature it was cut from, and says so. Without the
  // backlink an intent is an orphan: nothing can check it against a parent, so its
  // coverage claim answers to no one and the program counts it toward nothing. This is
  // the same edge a unit carries to its intent, one level up.
  for (const intent of minted) {
    if (intent.parent !== ctx.feature.id) {
      problems.push(`${intent.id}: parent is "${intent.parent ?? ""}", expected "${ctx.feature.id}" — an intent is cut from the feature it names`);
    }
  }
  // And the arithmetic in both directions, against that feature alone — via
  // `lintChildren`, the same function hop 2 uses, rather than a second copy of it here.
  //
  // It had a second copy for one commit and that is the sibling divergence this repo has
  // paid for five times: two implementations of one rule, one of which gets the next fix.
  //
  // Only the BLOAT half is acted on HERE, and the filter is the asymmetry rather than a
  // reimplementation. A feature is served over several ACTs and the ceiling is three
  // intents, so a set that does not yet cover the whole feature is not this ACT's
  // failure — external review caught the opposite reading deadlocking every feature that
  // needs a fourth intent. The gap half belongs to the judge's `nothing_dropped`, which
  // sees the whole feature rather than one ACT's slice of it.
  if (problems.length === 0) {
    const mintedIdSet = new Set(minted.map((m) => m.id));
    for (const p of lintChildren(ctx.feature, minted).problems) {
      if ([...mintedIdSet].some((id) => p.startsWith(id))) problems.push(p);
    }
  }
  return problems;
}

/**
 * The correction pass at the intent rung — the same change the narrowing rung just made,
 * one level down, and the last rung of the ladder that did not have it.
 *
 * Before this, a judge's refusal reverted the drafts to a shelf and the next tick paid a
 * PLANNER to answer the same question again. The shelf was already half the fix: it was
 * added after an incident costing two attempts and roughly seventeen dollars for a second
 * draft sharing not one paragraph with the first, and its conclusion — *revision needs
 * the thing being revised* — is what this completes. The draft survived; nothing revised
 * it. A planner handed its own refused work and a list of objections rewrites, because
 * writing is what a planner does.
 *
 * So the judge runs ONCE, this pass addresses what it found, and the intents are
 * promoted. The unbounded part was never the judge's strictness; it was that every
 * refusal bought a DIFFERENT plan rather than a better one.
 *
 * It writes in the repository, as the planner does, and is therefore checked the same
 * three ways afterwards: `changedFiles` for the one-way doors, `engineStateTampering` for
 * the ledgers and the shelf, and the free arithmetic re-run over what it left behind.
 */
async function runIntentFix(
  ctx: ProgramContext,
  files: readonly string[],
  findings: readonly string[],
): Promise<{ spendUsd: number; failure: RunFailureReason | null; outage: boolean }> {
  const invoke = ctx.runAgent ?? productionRunAgent;
  const numbered = findings.map((f, i) => `${i + 1}. ${f}`).join(LF + LF);
  const prompt = [
    agentLaw(ctx.intentFixerAgentPath),
    "",
    "---",
    "",
    "# The intents to correct",
    "",
    ...files.map((f) => "  " + join(ctx.arenaDir, f)),
    "",
    "Read each one, correct it, and write it back to the SAME path with `Write`. Do not",
    "create a new intent and do not delete one: the engine refuses a pass that changes",
    "WHICH intents exist rather than what is wrong with them.",
    "",
    "- THE FEATURE they must conform to, and the authority on every finding below:",
    "  " + join(ctx.arenaDir, ctx.featurePath),
    "",
    "  Read it. A finding says these intents depart from it; the correction is to match",
    "  it, never to argue with it, and never to edit it. Do not go looking for the PRD or",
    "  the ARCH — the feature was checked against them by the rung above, in both",
    "  directions, and reaching past it picks up scope from a step nobody is building.",
    "",
    "**Your tools are `Read`, `Grep`, `Glob` and `Write`, and nothing else.** There is no",
    "`Bash` and no `Edit`. To change a file, write the whole file again. Write nothing",
    "outside `work/intents/` — not a work unit, not a contract, not a line of code, and",
    "not a change to the feature. The run is reverted wholesale if you do.",
    "",
    "## The findings — " + String(findings.length) + " of them, and this is the complete list",
    "",
    numbered,
    "",
    "Address every one, then stop. This is the only correction pass and what you write is",
    "promoted to `ready` and built from: there is no later round to hold something back",
    "for, and equally nothing else about these intents is under review — a change nobody",
    "asked for is a change nobody checked.",
    "",
  ].join(LF);
  const spawned = await invoke(prompt, {
    argv: buildClaudeArgv({
      maxBudgetUsd: ctx.fixBudgetUsd ?? Math.max(1, ctx.budgetUsd / 2),
      allowedTools: ["Read", "Grep", "Glob", "Write"],
      permissionMode: "dontAsk",
      ...(ctx.settingsPath !== undefined ? { settingsPath: ctx.settingsPath } : {}),
    }),
    cwd: ctx.arenaDir,
    timeoutMs: ctx.timeoutMs ?? 15 * 60_000,
    logPath: ctx.logPath.replace(/\.log$/, "-fix.log"),
  });
  return {
    spendUsd: spawned.resultMessage?.total_cost_usd ?? 0,
    failure: classifySpawn(spawned),
    outage: spawned.outage,
  };
}

export async function runProgramDecompose(ctx: ProgramContext): Promise<ProgramOutcome> {
  const invoke = ctx.runAgent ?? productionRunAgent;
  // Taken BEFORE the ACT runs: the only question is what the ACT changed, and the
  // engine's own scheduler writes are legitimately uncommitted between ticks.
  const stateBefore = snapshotEngineState(ctx.arenaDir);
  const spawned = await invoke(assembleProgramDecomposerPrompt(ctx), {
    argv: buildClaudeArgv({
      maxBudgetUsd: ctx.budgetUsd,
      allowedTools: ["Read", "Grep", "Glob", "Write"],
      permissionMode: "dontAsk",
      // The same containment every other write-capable ACT runs under. This one was
      // spawned without it — the only agent in the engine holding `Write` with nothing
      // at the permission layer stopping it reaching one-way doors. The snapshot below
      // is a detector; this is the lock, and a detector is not a substitute for one.
      ...(ctx.settingsPath !== undefined ? { settingsPath: ctx.settingsPath } : {}),
    }),
    cwd: ctx.arenaDir,
    // 30, not 15. This ACT reads the whole program — 80KB of PRD and ARCH for
    // one target — decides what comes next, and writes intents with drafted
    // acceptance. The first production run timed out at 15 and cost real money that
    // arrived as $0, because a killed run never returns a result message to bill from.
    timeoutMs: ctx.timeoutMs ?? 30 * 60_000,
    logPath: ctx.logPath,
  });

  const actSpend = spawned.resultMessage?.total_cost_usd ?? 0;

  // The shelf, before anything else looks at the run.
  //
  // This ACT is the one that READS the shelf, which makes it the one with a motive:
  // softening the objections standing against its own plan, or editing the draft they
  // refer to, changes what the next attempt is asked to answer. Neither the guardrail
  // diff check (it runs on implementer and review-fix branches, not here) nor the
  // ordinary revert would have caught it — `changedFiles` skips `.doctrine/` as
  // engine-owned runtime state, and `revertAll` excludes that directory outright, so
  // the edit would have survived a run that returned empty or failed and been read as
  // genuine next tick. Found in review on doctrine#21.
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

  const failure = classifySpawn(spawned);
  if (failure !== null) {
    revertAll(ctx.arenaDir);
    return { kind: "failed", reason: failure, outage: spawned.outage, problems: [], spendUsd: actSpend };
  }

  const { allowed, forbidden } = changedFiles(ctx.arenaDir);
  if (forbidden.length > 0) {
    revertAll(ctx.arenaDir, [...allowed, ...forbidden]);
    return {
      kind: "failed",
      reason: "program-decomposer touched files outside work/intents/ — reverted wholesale",
      outage: false,
      problems: forbidden,
      spendUsd: actSpend,
    };
  }
  if (allowed.length === 0) {
    return { kind: "empty", detail: "program-decomposer minted no intents — an honest empty program frontier", spendUsd: actSpend };
  }

  // --- what the engine can decide for free ---
  //
  // A document the parser cannot read is the ONE hard refusal here, and for the same
  // reason it is one on the rung above: the correction pass needs something to correct
  // and the judge needs something to judge, and an intent without an envelope has no id,
  // no parent and no `delivers`. Neither could be pointed at it.
  const read = (f: string): string => readFileSync(join(ctx.arenaDir, f), "utf8");
  const drafts: Draft[] = [];
  const unreadable: string[] = [];
  for (const f of allowed) {
    const parsed = parseIntent(read(f));
    if (parsed.ok) drafts.push({ intent: parsed.intent, file: f });
    else unreadable.push(`${f}: ${parsed.errors.join("; ")}`);
  }
  if (unreadable.length > 0) {
    revertAll(ctx.arenaDir, allowed);
    return { kind: "failed", reason: "an intent could not be read", outage: false, problems: unreadable, spendUsd: actSpend };
  }

  // Everything else the engine knows is a FINDING, not a refusal — the same change the
  // narrowing rung made. It costs nothing to compute, so it is re-run after the
  // correction pass and can afford to be a gate then.
  const minted = drafts.map((d) => d.intent);
  const mechanical = mechanicalIntentFindings(ctx, drafts);

  // --- the fidelity half: meaning, not shape. It runs ONCE. ---
  const pj = await runProgramJudge(ctx, minted, allowed);
  let spendUsd = actSpend + pj.spendUsd;
  if (!pj.ok) {
    // The judge could not run or could not report. Not the plan's fault, and it must
    // never read as "nothing found" — intents published unjudged because a spawn timed
    // out is the gate-becomes-optional failure, arriving quietly.
    revertAll(ctx.arenaDir, allowed);
    return { kind: "failed", reason: "the program-judge could not run", outage: pj.outage, problems: pj.problems, spendUsd };
  }

  const findings = [...mechanical, ...pj.findings];
  let current = minted;
  if (findings.length > 0) {
    // --- one correction pass, then it lands ---
    const before = allowed.map((f) => read(f));
    const fixed = await runIntentFix(ctx, allowed, findings);
    spendUsd += fixed.spendUsd;
    const refuse = (reason: string, problems: string[]): ProgramOutcome => {
      // Order matters: shelve first, because the revert is what deletes the drafts;
      // commit after, so the shelf is a committed artifact rather than a file that
      // happens to still be lying around. A fresh clone, or anyone's `git clean -fdx`,
      // would otherwise silently restore the starved behaviour the shelf exists to end.
      shelveRejected(ctx.arenaDir, allowed, problems);
      revertAll(ctx.arenaDir, allowed);
      stagePaths(ctx.arenaDir, [join(".doctrine", "rejected")]);
      engineCommit(ctx.arenaDir, `doctrine: program-decompose refused (${minted.length} draft(s) shelved for revision)`);
      return { kind: "rejected", problems: [reason, ...problems], spendUsd };
    };

    if (fixed.failure !== null) {
      revertAll(ctx.arenaDir, allowed);
      return { kind: "failed", reason: `the correction pass ${fixed.failure}`, outage: fixed.outage, problems: findings, spendUsd };
    }

    // Containment, and it is not a copied precaution. The correction pass holds `Write`
    // in the repository exactly as the planner does, and it has a motive the planner
    // does not: a finding says these intents disagree with their feature, and editing
    // the FEATURE resolves it just as well. `docs/program/**` is outside `work/intents/`,
    // so `changedFiles` already names it — this is the check that consults it.
    const afterChange = changedFiles(ctx.arenaDir);
    if (afterChange.forbidden.length > 0) {
      revertAll(ctx.arenaDir, [...afterChange.allowed, ...afterChange.forbidden]);
      return {
        kind: "failed",
        reason: "the correction pass touched files outside work/intents/ — reverted wholesale",
        outage: false,
        problems: afterChange.forbidden,
        spendUsd,
      };
    }
    // The same ENGINE-STATE question the planner is asked, for the same reason one rung
    // up: this pass can see the objections standing against the drafts it is correcting,
    // and softening them changes what the next attempt is asked to answer. `changedFiles`
    // skips `.doctrine/` as engine-owned, so nothing above would have caught it.
    const tamperedByFix = engineStateTampering(ctx.arenaDir, stateBefore);
    if (tamperedByFix.length > 0) {
      restoreEngineState(ctx.arenaDir, stateBefore);
      revertAll(ctx.arenaDir, allowed);
      return { kind: "failed", reason: "the correction pass modified engine-owned state", outage: false, problems: describeTampering(tamperedByFix), spendUsd };
    }

    // It must have corrected THESE intents — not added one, not deleted one, and not
    // left them all untouched. The set is checked by NAME because the re-reads below are
    // by name: a pass that writes a fourth intent and leaves the three alone would
    // otherwise re-check clean and publish, reporting every finding as addressed.
    const nowPresent = changedFiles(ctx.arenaDir).allowed.slice().sort();
    const wasPresent = allowed.slice().sort();
    if (nowPresent.join("|") !== wasPresent.join("|")) {
      return refuse(
        "the correction pass changed WHICH intents exist, not what is wrong with them",
        [`was: ${wasPresent.join(", ") || "(none)"}`, `now: ${nowPresent.join(", ") || "(none)"}`],
      );
    }
    if (allowed.every((f, i) => read(f) === before[i])) {
      return refuse(`the correction pass changed nothing, with ${findings.length} finding(s) outstanding`, findings);
    }

    // --- the free half, re-run: it costs nothing, so it can afford to be a gate ---
    //
    // The asymmetry is the point. The paid judge ran once and its findings have been
    // addressed; asking it again is the unbounded loop this change removes. The
    // arithmetic is deterministic and free, so there is no reason to take the correction
    // pass's word for it — and it is the half that protects the coverage chain, where a
    // wrong `delivers` list means a criterion silently reaches no child.
    const after: Draft[] = [];
    const stillUnreadable: string[] = [];
    for (const f of allowed) {
      const parsed = parseIntent(read(f));
      if (parsed.ok) after.push({ intent: parsed.intent, file: f });
      else stillUnreadable.push(`${f}: ${parsed.errors.join("; ")}`);
    }
    if (stillUnreadable.length > 0) {
      return refuse("the correction pass left an intent that does not parse", stillUnreadable);
    }
    const remaining = mechanicalIntentFindings(ctx, after);
    if (remaining.length > 0) {
      return refuse(`${remaining.length} mechanical finding(s) survived the correction pass`, remaining);
    }
    current = after.map((d) => d.intent);
  }

  // --- mechanical promotion ---
  for (const f of allowed) {
    const path = join(ctx.arenaDir, f);
    writeFileSync(path, readFileSync(path, "utf8").replace(/^status:\s*proposed/m, "status: ready"));
  }
  // Accepted: the objection is spent and the shelf is stale. Leaving it would argue
  // with the next attempt about a plan that no longer exists.
  clearRejected(ctx.arenaDir);
  stagePaths(ctx.arenaDir, [join("work", "intents"), join(".doctrine", "rejected")]);
  engineCommit(
    ctx.arenaDir,
    `doctrine: program-decompose (+${current.length} intent(s), lint-promoted${findings.length > 0 ? `, ${findings.length} finding(s) corrected` : ""})`,
  );

  return { kind: "minted", intentIds: current.map((i) => i.id), findingsFixed: findings.length, spendUsd };
}
