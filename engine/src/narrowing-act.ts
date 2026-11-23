import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildClaudeArgv } from "./argv.js";
import { edgeProblems, type Dependent } from "./depends.js";
import { parseFeatures, type Feature } from "./feature.js";
import { engineCommit, stagePaths } from "./git-commit.js";
import {
  lintEpics,
  lintFeatures,
  parseNarrowing,
  type ChainLint,
  type Narrowing,
  type NarrowingLevel,
} from "./narrowing.js";
import { narrowingDirRel, repoTouchedBy, revertRepo, type NarrowingStore } from "./narrowing-store.js";
import { sharedCriteria } from "./narrowing-set.js";
import { parseEnvelope, parseFrontmatter } from "./envelope.js";
import { lintScaffold, type CriteriaParse } from "./coverage.js";
import { isolatedCwd, type RunAgentFn } from "./judge.js";
import { classifySpawn, runAgent as productionRunAgent } from "./spawn.js";
import { parseWorkUnit, type WorkUnit } from "./work-unit.js";

/**
 * One budgeted ACT that writes ONE narrowing, then the same two gates everything else on
 * this ladder gets: a mechanical lint on the arithmetic, then a judge on the meaning.
 *
 * The order matters and is the same order the plan rung uses. The lint is free and
 * decides a question the judge is bad at — does this set of ids add up — so it runs
 * first and a failure costs nothing. The judge then spends its whole round on the half
 * only it can do: are the quotations real, is the narrowing faithful, is anything
 * binding missing.
 *
 * Everything about spawning, reverting, classifying failures and billing is the same
 * machinery the brief rung used, because that machinery is a list of paid-for incidents
 * and rewriting it would rediscover them.
 */

/**
 * The size a narrowing's body came out at is REPORTED, and nothing refuses it.
 *
 * There was a 12,000-character ceiling here, in code, because the instruction alone had
 * not held for three documents running — each spent 31-38% of itself restating the ARCH
 * and ran 27,943 to 44,516 characters against a PRD of 28,191.
 *
 * It is gone, on the operator's call, and the reasoning is better than the ceiling was: a
 * stated limit is a target. A model told a document may run to 12,000 characters writes
 * one near 12,000, and the number stops measuring what the model would have produced and
 * starts producing it. The bloat this was aimed at is a SHAPE — copying the architecture
 * instead of pointing at it — and the checks that catch that shape are `points-not-copies`
 * and `right-size`, which a reader performs on the document rather than on its length.
 *
 * So the engine measures and says nothing. `narrowing-act` puts the character count in the
 * tick, which makes the first real runs answerable — what DOES it write when nothing is
 * anchoring it — instead of guessing from a number we chose.
 *
 * If it turns out to need a bound again, the bound should be discovered from what these
 * runs produce, not restored from memory.
 */
export const REPORT_NARROWING_SIZE = true;

/**
 * A newline. Written this way because a literal one inside a string in this file has
 * been mangled by every shell heredoc it has been edited through.
 */
const LF = String.fromCharCode(10);

export interface NarrowingContext {
  arenaDir: string;
  level: NarrowingLevel;
  /** The document being narrowed. For an epic: the PRD and ARCH. For a feature: its epic. */
  parent: { label: string; paths: string[] };
  /** The epic a new feature must belong to. Absent when minting an epic. */
  epic?: Narrowing;
  /** The PRD's criteria, for hop 1's arithmetic. */
  criteria: CriteriaParse;
  /** Narrowings already at this level — the new one must not duplicate or rival them. */
  existing: readonly Narrowing[];
  /**
   * Units already scaffolded, under every OTHER epic (ADR-0006).
   *
   * Two readers, and both are what per-epic minting costs. An id must not collide with one
   * of these, because the store writes one file per id and publishing a second would leave
   * one document where there were two. And an edge on a criterion an earlier epic's units
   * deliver is an edge that CAN clear — handed only the new set, `edgeProblems` would call
   * it unsatisfiable, which is the quiet kind of stuck inside the gate built to stop it.
   */
  existingUnits?: readonly WorkUnit[];
  /** What a unit's `depends_on` can resolve against. See `dependableSlices`. */
  dependable?: readonly Dependent[];
  /** Where narrowings are persisted. The ACT never writes to it; the engine publishes. */
  store: NarrowingStore;
  logPath: string;
  agentDefinitionPath: string;
  judgeAgentPath: string;
  /** The law for the ACT that ADDRESSES findings. See `runNarrowingFix` for why it exists. */
  fixerAgentPath: string;
  budgetUsd: number;
  /** The fix pass's budget. Defaults to half: it is addressing a list, not writing a document. */
  fixBudgetUsd?: number;
  judgeBudgetUsd?: number;
  settingsPath?: string;
  /** The judge's objections to the LAST attempt, so a retry converges rather than re-rolls. */
  priorRejection?: string;
  timeoutMs?: number;
  runAgent?: RunAgentFn;
}

export type NarrowingOutcome =
  | { kind: "minted"; id: string; path: string; spendUsd: number; findingsFixed: number; bodyChars: number; units: string[] }
  /** The level is complete: the ACT honestly wrote nothing because nothing is owed. */
  | { kind: "empty"; detail: string; spendUsd: number }
  | { kind: "rejected"; problems: string[]; spendUsd: number }
  | { kind: "failed"; reason: string; outage: boolean; problems: string[]; spendUsd: number };

function agentLaw(path: string): string {
  const text = readFileSync(path, "utf8");
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return (m ? m[1]! : text).trim();
}

export function assembleNarrowingPrompt(ctx: NarrowingContext, outDir: string): string {
  const dir = outDir;
  const owed = ctx.criteria.criteria.map((c) => c.id).filter((c) => !ctx.existing.some((e) => e.delivers.includes(c)));

  return `${agentLaw(ctx.agentDefinitionPath)}

---

# Your task

Write ONE **${ctx.level}** as a single \`.md\` file in your working directory:

  ${dir}

That directory is yours and is thrown away after this run. Do NOT write anywhere else —
not into the repository, not beside the documents you are reading. The engine reads what
you leave there, gates it, and publishes it only if it passes.

- YOUR PARENT, and the only source you need: ${ctx.parent.label}
${ctx.parent.paths.map((p) => `  ${join(ctx.arenaDir, p)}`).join("\n")}

Your working directory is the scratch directory above. Read your sources by the
ABSOLUTE paths given: the repository is not your working directory, so a relative path
resolves inside the scratch directory and will look like a missing file.

**Your tools are \`Read\`, \`Grep\`, \`Glob\` and \`Write\`, and nothing else.** There is no
\`Bash\`, no \`Edit\`. A call to one is denied unanswered and costs you a turn of a budget
you are paying for out of the same purse as the work. To change a file you have already
written, write the whole file again with \`Write\`.

## Criteria still owed at this level

These are the criterion ids your parent carries that no ${ctx.level} has taken yet. Your
\`delivers\` must be a subset of them, and you take the next coherent slice — not all of
them, unless all of them are one slice.

${owed.length > 0 ? owed.join(", ") : "(none — every criterion is already taken; write nothing and say so)"}

## Epics that already exist
${ctx.existing.length > 0 ? ctx.existing.map((e) => `- ${e.id} [${e.status}] ${e.title} — delivers ${e.delivers.join(", ")}`).join("\n") : "(none)"}
${ctx.priorRejection !== undefined ? `\n## The last document written here was discarded\n\nA judge's findings are corrected rather than refused, so these are not opinions about\nthat document — they are the reasons nothing could be done with it at all. Do not\nreproduce them.\n\n${ctx.priorRejection}\n` : ""}
${ctx.level === "epic" ? scaffoldTask(ctx, dir) : ""}Write what is asked for above and nothing else. Anything written into the repository fails the run.

A judge reads what you write and says what is wrong with it, and one correction pass fixes
those things before it is published. So write the best document you can and do not hedge:
an omission you were unsure about becomes a finding somebody has to fix, and a sentence
padded to look complete becomes one somebody has to delete.
`;
}

/**
 * The half of the epic task that asks for its units (ADR-0006).
 *
 * **Engine-assembled, not an agent law.** The same distinction is used for
 * `Criteria you may depend on:` — the law says what kind of thing to write, the engine
 * says what THIS run is given and what it must produce.
 *
 * Every rule stated here is enforced mechanically by `scaffoldFindings`, and deliberately
 * so: a scaffold that carries acceptance is refused by the parser itself, not by asking
 * nicely.
 */
function scaffoldTask(ctx: NarrowingContext, dir: string): string {
  return `
## The units under your features

Write one file per unit into \`${join(dir, SCAFFOLD_DIR)}\`, named \`<unit id>.md\`. A unit is
the implementable thing: the whole of one feature, or one of a handful under it.

Each is a SCAFFOLD, and a scaffold says what and why, never how:

\`\`\`
---
id: wu-invoice-push
title: Invoice push
tier: reversible
budget_usd: 12
status: scaffold
parent: <this epic>#<n.m>          # the feature heading it hangs off
delivers: [C3.1]                   # criteria it IMPLEMENTS; only these count for coverage
renders: [C4.1]                    # criteria it merely presents
depends_on: [C1.1]                 # criteria that must be satisfied first, never a document id
---
## Intent

Why this unit exists, in the terms of the thing being built — not a plan for building it.
\`\`\`

Three rules the engine enforces rather than requests:

  - **No \`evidence:\`, and no spec.** A scaffold carries neither. Both are written later,
    against the tree as it then is, by the ACT that builds this unit out — which is the
    whole reason a unit has two states. A scaffold carrying evidence is refused.
  - **Every criterion each of your features delivers must reach one of its units**, and a
    unit may not claim anything its own feature does not.
  - **\`depends_on\` names criteria**, and it may name one an earlier epic delivers.

Units already scaffolded under other epics — do not re-use an id, and you may depend on
what they deliver:

${(ctx.existingUnits ?? []).length > 0
  ? (ctx.existingUnits ?? []).map((u) => `- ${u.id} [${u.status}] delivers ${u.delivers.join(", ") || "(none)"}`).join(LF)
  : "(none)"}

`;
}

interface NarrowingVerdict {
  verdict: "pass" | "fail";
  checks?: Array<{ check: string; ok: boolean; cite?: string }>;
  problems?: string[];
}

/**
 * The checks a verdict must contain — and the ONE place they are written.
 *
 * The judge prompt used to list them too, in its own JSON block. That is one rule with
 * two statements, and two statements of one rule drift: add a check here and every
 * verdict fails for omitting something no judge was told to produce; add one there and it
 * is never enforced. Neither failure is visible until a real verdict is refused at ~$9.
 *
 * So the prompt no longer states them. `judgeSchema()` renders this array into the task,
 * which makes the agent law and the validator the same list by construction rather than
 * by anyone remembering. This is the structural half of a pattern that produced four
 * separate defects in this engine before it was named: a rule enforced in one place and
 * stated in another.
 */
export const REQUIRED_CHECKS = [
  "quotes-are-real",
  "nothing-invented",
  "nothing-binding-missing",
  "right-size",
  "points-not-copies",
  "dependencies-declared",
] as const;

/** The verdict shape, rendered from the list above so the two cannot disagree. */
function judgeSchema(verdictPath: string): string {
  const LFC = String.fromCharCode(10);
  const rows = REQUIRED_CHECKS.map((c) => `    { "check": ${JSON.stringify(c)}, "ok": true, "cite": "..." }`).join("," + LFC);
  return [
    "## Write your verdict JSON to EXACTLY: " + verdictPath,
    "",
    "```json",
    "{",
    '  "document": "<the path you judged>",',
    '  "parent": "<the path you judged it against>",',
    '  "verdict": "pass|fail",',
    '  "judged": true,',
    '  "checks": [',
    rows,
    "  ],",
    '  "problems": []',
    "}",
    "```",
    "",
    `All ${REQUIRED_CHECKS.length} checks, every time. A verdict that omits one is not a pass —`,
    "inspecting only what is present is how a gate becomes optional, and every check you skip",
    "is one the engine reports as unperformed rather than as satisfied.",
  ].join(LFC);
}

async function runNarrowingJudge(
  ctx: NarrowingContext,
  documentPath: string,
  verdictPath: string,
): Promise<JudgeRun> {
  const invoke = ctx.runAgent ?? productionRunAgent;
  const scratch = isolatedCwd("narrowing-judge");
  const prompt = `${agentLaw(ctx.judgeAgentPath)}

---

# What you are judging

- THE DOCUMENT: ${join(ctx.arenaDir, documentPath)}
- ITS PARENT, and the only thing it answers to: ${ctx.parent.label}
${ctx.parent.paths.map((p) => `  ${join(ctx.arenaDir, p)}`).join("\n")}
- repository root: ${ctx.arenaDir}

Read them by ABSOLUTE path. The repository is **not** your working directory — you run
from an empty scratch directory outside it, so a relative path resolves into nothing and
a "missing" file is evidence of nothing.

Do not reach past the parent named above. Whatever produced it was checked by the run
before you, and re-litigating that hop is the error you are here to catch one level down.

${judgeSchema(verdictPath)}
`;
  let spawned;
  try {
    spawned = await invoke(prompt, {
      argv: buildClaudeArgv({
        maxBudgetUsd: ctx.judgeBudgetUsd ?? ctx.budgetUsd,
        allowedTools: ["Read", "Grep", "Glob", "Write"],
        // The DOCUMENT'S directory, not just the repository — and this was missing.
        //
        // The judge runs from its own scratch directory, and the document it is judging
        // sits in the WRITER'S scratch directory, which is neither its cwd nor under
        // `arenaDir`. `--add-dir` is what grants a directory, so under `dontAsk` the judge
        // could not read the one file it exists to read: it would fail, or rule on the
        // parent alone and call that a verdict.
        //
        // `code-judge` gets this right (`[baseDir, headDir, dirname(verdictPath)]`) and
        // this rung was written without it — the eighth time in this session a rule has
        // been applied to one path and not its sibling. Caught by external review of the
        // TICKET rung, which had copied the same shape; it had never fired here because no
        // offline test enforces permissions and this rung had never run for real.
        addDirs: [ctx.arenaDir, dirname(documentPath)],
        permissionMode: "dontAsk",
      }),
      cwd: scratch,
      timeoutMs: ctx.timeoutMs ?? 10 * 60_000,
      logPath: ctx.logPath.replace(/\.log$/, "-judge.log"),
    });
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
  }

  const spendUsd = spawned.resultMessage?.total_cost_usd ?? 0;
  const failure = classifySpawn(spawned);
  if (failure !== null) return { ok: false, problems: [`narrowing-judge ${failure}`], outage: spawned.outage, spendUsd };
  if (!existsSync(verdictPath)) {
    return { ok: false, problems: ["narrowing-judge wrote no verdict — a judge that cannot report FAILS the run"], outage: false, spendUsd };
  }
  let v: NarrowingVerdict;
  try {
    v = JSON.parse(readFileSync(verdictPath, "utf8")) as NarrowingVerdict;
  } catch (e) {
    return { ok: false, problems: [`narrowing-judge verdict is not JSON: ${String(e).slice(0, 120)}`], outage: false, spendUsd };
  }
  // --- the findings, which are the judge's PRODUCT and no longer its verdict ---
  //
  // Everything it marked not-ok is a finding, whatever the verdict line says. A document
  // that "passes" while a check is not ok is not a contradiction to resolve; it is a judge
  // that found something and rounded it off. Taking the checks as authoritative costs
  // nothing and closes the gap.
  const seen = new Map((v.checks ?? []).map((c) => [c.check, c]));
  const cited = (c: { cite?: string }): boolean => typeof c.cite === "string" && c.cite.trim().length > 0;
  const findings: string[] = [
    ...(v.problems ?? []).filter((x) => typeof x === "string" && x.trim().length > 0),
    ...(v.checks ?? []).filter((c) => c.ok !== true && cited(c)).map((c) => `${c.check}: ${c.cite!.trim()}`),
  ];

  // --- three ways a judge can fail to REPORT, and none of them is a finding ---
  //
  // The distinction this rung now turns on: a finding is an instruction a correction pass
  // carries out on the document. If there is nothing in the document to change, it is not
  // a finding — it is proof the judge did not do its job, and it fails the RUN so the
  // engine buys another judge instead of publishing on the strength of a bad report.
  //
  // Getting this wrong fails OPEN, which is why all three are here rather than tolerated.
  const problems: string[] = [];

  // 1. A check it never performed. Inspecting only what is present is how a gate becomes
  //    optional — the checks it omitted were being reported as satisfied.
  problems.push(...REQUIRED_CHECKS.filter((name) => !seen.has(name)).map((n) => `narrowing-judge reported no result for: ${n}`));

  // 2. A check marked not-ok with no citation. "quotes-are-real: no reason given" tells a
  //    fixer that something is wrong and nothing about where, so it cannot act — and any
  //    unrelated byte it changes then satisfies the "changed something" guard, the paid
  //    checks are never re-run, and the original defect publishes. The verdict is
  //    model-generated JSON cast to a type; an uncited failure is an incomplete report.
  problems.push(
    ...(v.checks ?? [])
      .filter((c) => c.ok !== true && !cited(c))
      .map((c) => `narrowing-judge marked ${c.check} not ok and gave no citation — a finding that names nothing cannot be acted on`),
  );

  // 3. An explicit refusal that says nothing. Same reason, arriving by the verdict line:
  //    there is no finding to correct, so publishing would mean acting on a refusal
  //    nobody can answer. The intent rung refuses this and this one did not, which is the
  //    sibling divergence between the two correction passes that the pull request
  //    introducing them warned about. External review caught it on 2026-09-13.
  if (v.verdict !== "pass" && findings.length === 0 && problems.length === 0) {
    problems.push("narrowing-judge refused the document without saying what is wrong with it");
  }

  if (problems.length > 0) return { ok: false, problems, outage: false, spendUsd };
  return { ok: true, findings, spendUsd };
}

type JudgeRun =
  /** The judge RAN. `findings` is what it found; empty means there is nothing to correct. */
  | { ok: true; findings: string[]; spendUsd: number }
  /** The judge could not run or could not report. Not a fault in the document. */
  | { ok: false; problems: string[]; outage: boolean; spendUsd: number };

/**
 * Everything the engine can decide about this document for FREE.
 *
 * Split out because these are now FINDINGS rather than rejections: the arithmetic used to
 * kill the document, and it now describes what is wrong with it, in the same list the
 * judge's observations go into. The engine re-runs this function after the correction
 * pass — it costs nothing, so unlike the judge it can afford to be a gate.
 */
/** Where the epic ACT leaves the units it scaffolds, inside its own scratch directory. */
const SCAFFOLD_DIR = "work";

export interface Scaffolded {
  /**
   * The parsed unit and the bytes it was parsed from. **Both**, because what is published
   * is what was read — round-tripping through a serialiser would let the artifact on disk
   * differ from the one the lint and the judge ruled on, which is the same reason
   * `Narrowing` keeps its own `source`.
   */
  units: Array<{ unit: WorkUnit; source: string }>;
  /** Unreadable files, named. A unit that will not parse is invisible to the arithmetic. */
  problems: string[];
}

/**
 * Read the units the epic ACT scaffolded beside its epic (ADR-0006).
 *
 * They live in `work/` INSIDE the scratch directory, which is what keeps the epic itself
 * the only `.md` at the scratch root — so the "wrote more than one narrowing" guard above
 * still means what it says, and did not have to be loosened to make room for this.
 */
export function readScaffolds(scratch: string, subdir: string = SCAFFOLD_DIR): Scaffolded {
  const dir = join(scratch, subdir);
  if (!existsSync(dir)) return { units: [], problems: [] };
  const units: Array<{ unit: WorkUnit; source: string }> = [];
  const problems: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const where = `${SCAFFOLD_DIR}/${file}`;
    const source = readFileSync(join(dir, file), "utf8");
    const res = parseWorkUnit(source, where);
    if (res.ok) units.push({ unit: res.unit, source });
    else problems.push(...res.errors.map((e) => `${where}: ${e}`));
  }
  return { units, problems };
}

/**
 * The scaffold's arithmetic: does this epic's set of units add up, on paper, before
 * anything is built?
 *
 * **`lintScaffold` is the owner and this is only its call site.** It asks coverage against
 * this epic's `Delivers` (`scope`), id uniqueness seeded from what other epics already
 * scaffolded (`elsewhere`), and the dependency edges through `edgeProblems` — open-world,
 * because a unit here legitimately waits on a criterion an earlier epic delivers.
 *
 * The two checks added here are the ones `lintScaffold` structurally cannot make, because
 * it does not know about features: a unit must name a feature of THIS epic as its parent,
 * and it may not claim to deliver something its own feature does not. Without the second,
 * a unit parented to feature 1.2 could deliver feature 1.1's criterion, the epic-level
 * coverage arithmetic would still balance, and the feature grade — which is the ratchet —
 * would be run against units that are not its own.
 */
/** What `scaffoldFindings` needs, which both the epic rung and the gap rung can supply. */
export interface ScaffoldScope {
  level: NarrowingLevel;
  criteria: CriteriaParse;
  existingUnits?: readonly WorkUnit[];
  /** What an edge can resolve against — `dependableSlices`, shared with admissibility. */
  dependable?: readonly Dependent[];
}

export function scaffoldFindings(
  ctx: ScaffoldScope,
  epic: Narrowing,
  features: readonly Feature[],
  scaffolded: Scaffolded,
): string[] {
  // Only the epic rung scaffolds. A feature is a heading and mints nothing of its own.
  if (ctx.level !== "epic") {
    return scaffolded.units.length > 0
      ? [`${ctx.level} rung wrote ${scaffolded.units.length} unit(s) — only an epic scaffolds units`]
      : [];
  }

  const out = [...scaffolded.problems];
  if (scaffolded.units.length === 0) {
    out.push(
      `${epic.id}: scaffolded no units — an epic is written with the units under its features `
      + `(ADR-0006), each one a title, a coverage claim, a dependency edge and an \`## Intent\``,
    );
    return out;
  }

  const lint = lintScaffold(ctx.criteria, scaffolded.units.map((s) => s.unit), {
    scope: epic.delivers,
    ...(ctx.existingUnits !== undefined ? { elsewhere: ctx.existingUnits } : {}),
    ...(ctx.dependable !== undefined ? { dependable: ctx.dependable } : {}),
  });
  out.push(...lint.problems);

  const byId = new Map(features.map((f) => [f.id, f]));
  for (const { unit: u } of scaffolded.units) {
    if (u.parent === undefined) {
      out.push(`${u.id}: no \`parent\` — a unit hangs off a feature of this epic, written \`${epic.id}#<n.m>\``);
      continue;
    }
    const feature = byId.get(u.parent);
    if (feature === undefined) {
      out.push(`${u.id}: parent "${u.parent}" is not a feature of ${epic.id} — its features are ${features.map((f) => f.id).join(", ") || "(none)"}`);
      continue;
    }
    const owned = new Set([...feature.delivers, ...feature.renders]);
    const stray = [...u.delivers, ...u.renders].filter((c) => !owned.has(c));
    if (stray.length > 0) {
      out.push(`${u.id}: claims ${stray.join(", ")}, which its own feature ${feature.id} neither delivers nor renders`);
    }
  }

  // The other direction, which nothing checked (PR #97 review). Coverage asks that every
  // criterion a feature DELIVERS reach a unit; nothing asked it of what a feature RENDERS. A
  // presented criterion no unit claims is a screen nobody is told to build: build-out and the
  // implementer read the unit, never the feature, so the work would be published and never done.
  for (const f of features) {
    const reached = new Set(
      scaffolded.units.filter((s) => s.unit.parent === f.id).flatMap((s) => [...s.unit.delivers, ...s.unit.renders]),
    );
    const orphaned = f.renders.filter((c) => !reached.has(c));
    if (orphaned.length > 0) {
      out.push(`${f.id}: renders ${orphaned.join(", ")}, which none of its units claims — a criterion a feature presents is built by one of its units or by nobody; add it to that unit's \`renders\``);
    }
  }
  return out;
}

function mechanicalFindings(ctx: NarrowingContext, doc: Narrowing, pending: string): string[] {
  const out: string[] = [];

  // **The id must be free BEFORE publish, because publish is what destroys the other one.**
  //
  // `FileNarrowingStore.publish` writes `<dir>/<id>.md`, so a second feature minted under a
  // different epic with an existing id does not produce two documents that disagree — it
  // overwrites the first and leaves one. Every check downstream then sees a single feature
  // with that id and reports nothing, which is how the level review advertised a
  // duplicate-id gate it could never fire: by the time it loaded the set, the evidence was
  // gone. External review, PR #83.
  //
  // `ctx.existing` is every narrowing at this level, unfiltered by parent — which is what
  // makes this reach the cross-epic case that `lintFeatureDocs` below, scoped to one epic,
  // structurally cannot. It is a FINDING rather than a refusal, so the correction pass can
  // rename the document; the free re-check then runs again before anything is published.
  if (ctx.existing.some((e) => e.id === doc.id)) {
    out.push(`${pending}: a ${ctx.level} with id "${doc.id}" already exists — the store writes one file per id, so publishing this one would overwrite it; choose an id no ${ctx.level} has taken`);
  }

  // **`done` is a RETIREMENT marker and may not be self-awarded**. An epic
  // with `status: done` is excluded from the feature parse, the chain and both grades, while
  // its `delivers` still counts toward coverage — which is exactly what a newly minted epic
  // must never be able to claim. Written by an ACT it is a gate switched off by one word:
  // coverage satisfied, no features, no acceptance, no units, nothing built.
  //
  // It can only arrive by an observer editing a committed file, which is what retiring work
  // from a previous ladder is. See `featuresOfEpics`.
  if (doc.status === "done") {
    out.push(`${pending}: status is "done" — a newly minted ${ctx.level} is "active". "done" retires a slice whose work is already built, and nothing may award it to itself`);
  }

  if (doc.level !== ctx.level) {
    out.push(pending + ': level is "' + doc.level + '" but this rung mints a ' + ctx.level + " — set `level: " + ctx.level + "`");
  }

  // `after:` checked at MINT, not only at the set review. The chain schedules on this
  // field, so an edge to a document that does not exist is an ordering the loop will read
  // as satisfied and serve anyway — silently, which is how the alphabetical bug behaved.
  // Catching it here means the correction pass fixes it in the same round as everything
  // else, instead of a set review refusing the whole level much later.
  //
  // One implementation of the edge rules, shared with the set review, because a rule
  // written twice is a rule applied at one level and not its sibling. `edgeProblems`
  // reports an edge on a requirement nothing in the set delivers, an edge on the slice's
  // own work, and a cycle — each with the whole set in hand.
  for (const p of edgeProblems([...ctx.existing, doc], ctx.level)) {
    if (p.startsWith(`${doc.id}:`)) out.push(p.replace(`${doc.id}:`, `${pending}:`));
    else if (p.includes(doc.id)) out.push(p);
  }
  // A criterion another slice already delivers, asked at MINT and not only when the level
  // is complete. The task already tells the writer its `delivers` comes from the criteria
  // still owed; this is the same rule the set review blocks on, called at the moment the
  // duplication would be created rather than after both slices have been built.
  for (const [criterion, by] of sharedCriteria([...ctx.existing, doc])) {
    if (!by.includes(doc.id)) continue;
    const others = by.filter((id) => id !== doc.id);
    out.push(`${pending}: delivers ${criterion}, which ${others.join(", ")} already delivers — a criterion in two ${ctx.level}s is narrowed twice and built twice; take it out of \`delivers\`, or \`renders\` it if this slice only presents it`);
  }
  // Hop arithmetic. Free, and it decides the question a judge reading prose is worst at.
  const lint: ChainLint = lintEpics(ctx.criteria, [...ctx.existing, doc]);
  // The second half, and the only one left now that features are written WITH their epic:
  // is every requirement of THIS epic captured in one of its features? Free, decided by a
  // parser, and charged to this document because it is this document's own contents.
  const inside = parseFeatures(doc.id, doc.body);
  out.push(...inside.problems);
  if (inside.problems.length === 0) out.push(...lintFeatures(doc, inside.features).problems);
  // A level is not complete until its last narrowing lands, so an incomplete SET is not
  // this document's fault and must not be charged to it. Only what this document itself
  // gets wrong counts: an id its parent does not have, a wrong parent, a level mismatch.
  out.push(...lint.problems.filter((x) => x.startsWith(doc.id) || x.includes(`${doc.id} delivers`)));
  return out;
}

/**
 * The correction pass: address the findings, on the document that has them.
 *
 * **This is the pull-request model, one rung up.** A reviewer leaves four anchored
 * comments, you address the four, and it merges — the reviewer does not close the pull
 * request and make you open a new one. Closing it is what this rung used to do: a refusal
 * deleted the draft, and the next tick paid a writer to produce a DIFFERENT document for
 * the same judge to find different things wrong with. Nothing bounded that except the
 * three-consecutive-failure halt, which stops the whole loop rather than finishing this
 * document.
 *
 * Measured, that shape refused 47.8% of documents at the program rung. The number was read
 * as a judge that was too harsh, and the first response was to loosen the bar. It was not
 * harshness. It was a loop with no way to finish: a re-roll buys a document that is
 * DIFFERENT, where a correction buys one that is BETTER.
 *
 * So the judge runs ONCE and says what is wrong, this pass corrects those things, and the
 * document is published. Three spawns per document — write, judge, fix — instead of an
 * unbounded multiple of two.
 *
 * The fixer is a different law from the writer on purpose: a writer handed criticism
 * rewrites, and this one is given a document and a list and told to change what the list
 * names and nothing else. That is exactly what `review-fixer` does at the unit rung, and
 * has done since 2026-09-04.
 */
async function runNarrowingFix(
  ctx: NarrowingContext,
  scratch: string,
  file: string,
  findings: readonly string[],
): Promise<{ spendUsd: number; failure: string | null; outage: boolean }> {
  const invoke = ctx.runAgent ?? productionRunAgent;
  const numbered = findings.map((f, i) => `${i + 1}. ${f}`).join(LF + LF);
  const parents = ctx.parent.paths.map((x) => "  " + join(ctx.arenaDir, x)).join(LF);
  const prompt = [
    agentLaw(ctx.fixerAgentPath),
    "",
    "---",
    "",
    "# The document to correct",
    "",
    "  " + join(scratch, file),
    "",
    "It is in your working directory. Read it, correct it, and write it back to the SAME",
    "path with `Write`. Do not create a second file and do not rename it — the engine",
    "publishes that path, and a document written beside it is one nobody reads.",
    "",
    ...(existsSync(join(scratch, SCAFFOLD_DIR))
      ? [
        "The units scaffolded with it are in `" + SCAFFOLD_DIR + "/` beside it, and are yours to",
        "correct as well — a finding naming a unit id is about the file of that name there.",
        "Write each one back to the same path. Do not add a unit and do not remove one: the",
        "coverage arithmetic was checked against the set you were given.",
        "",
      ]
      : []),
    "- ITS PARENT, the document it must conform to: " + ctx.parent.label,
    parents,
    "",
    "Read the parent by ABSOLUTE path; the repository is not your working directory. It is",
    "the authority on every finding below: a finding says this document departs from it, and",
    "the correction is to match it, never to argue with it.",
    "",
    "**Your tools are `Read`, `Grep`, `Glob` and `Write`, and nothing else.** There is no",
    "`Bash` and no `Edit`. To change the file, write the whole file again.",
    "",
    "## The findings — " + String(findings.length) + " of them, and this is the complete list",
    "",
    numbered,
    "",
    "Address every one, then stop. This is the only correction pass and what you write is",
    "published: there is no later round to hold something back for, and equally nothing else",
    "about this document is under review — a change nobody asked for is a change nobody",
    "checked.",
    "",
  ].join(LF);
  const spawned = await invoke(prompt, {
    argv: buildClaudeArgv({
      maxBudgetUsd: ctx.fixBudgetUsd ?? Math.max(1, ctx.budgetUsd / 2),
      allowedTools: ["Read", "Grep", "Glob", "Write"],
      addDirs: [ctx.arenaDir],
      permissionMode: "dontAsk",
      ...(ctx.settingsPath !== undefined ? { settingsPath: ctx.settingsPath } : {}),
    }),
    cwd: scratch,
    timeoutMs: ctx.timeoutMs ?? 15 * 60_000,
    logPath: ctx.logPath.replace(/\.log$/, "-fix.log"),
  });
  return {
    spendUsd: spawned.resultMessage?.total_cost_usd ?? 0,
    failure: classifySpawn(spawned),
    outage: spawned.outage,
  };
}

/** Write scaffolded units into `work/`, byte-for-byte as they were read and ruled on. */
export function writeScaffolds(arenaDir: string, units: readonly { unit: WorkUnit; source: string }[]): string[] {
  const rels: string[] = [];
  for (const { unit, source } of units) {
    const rel = `work/${unit.id}.md`;
    mkdirSync(join(arenaDir, "work"), { recursive: true });
    writeFileSync(join(arenaDir, rel), source);
    rels.push(rel);
  }
  return rels;
}

/**
 * Land the epic and the units scaffolded with it, in ONE commit.
 *
 * ADR-0006 makes them one artifact, so they land as one. The mechanism is the index:
 * `store.publish` stages the narrowing directory and then commits, and `engineCommit`
 * commits whatever the index holds — so staging the units first puts them in the epic's
 * own commit without widening the store interface, which this module deliberately
 * collapsed to three operations.
 *
 * That is load-bearing rather than incidental, and it is why the units are written first.
 * A second commit would leave a window where an epic exists with no units under it, and
 * every reader in the tick — coverage, the feature grade, the build-out rung — would read
 * that window as an epic whose features nothing implements.
 *
 * **The `engineCommit` afterwards is not a second commit, it is the guarantee.** Riding the
 * index works only if the store's `publish` commits, and `NarrowingStore` does not promise
 * that — the in-memory implementation the tests use keeps nothing in git at all. Relying on
 * the file store's behaviour through an interface that does not state it is how a seam
 * quietly stops holding: `narrowing-store.ts` exists precisely so nothing above it knows
 * where documents live. So the units are committed explicitly, and when `publish` already
 * took them the index is empty and `engineCommit` returns without doing anything.
 */
function publishWithScaffolds(
  ctx: NarrowingContext,
  epic: Narrowing,
  units: readonly { unit: WorkUnit; source: string }[],
): { ref: string; ids: string[] } {
  const rels = writeScaffolds(ctx.arenaDir, units);
  if (rels.length > 0) stagePaths(ctx.arenaDir, rels);
  const ref = ctx.store.publish(epic);
  if (rels.length > 0) {
    stagePaths(ctx.arenaDir, rels);
    engineCommit(ctx.arenaDir, `doctrine: scaffold ${rels.length} unit(s) under ${epic.id}`);
  }
  return { ref, ids: units.map((u) => u.unit.id) };
}

export async function runNarrowingAct(ctx: NarrowingContext): Promise<NarrowingOutcome> {
  const invoke = ctx.runAgent ?? productionRunAgent;

  // The ACT writes into a SCRATCH DIRECTORY, not the repository.
  //
  // This is what collapsed the store interface from six operations to three. When the ACT
  // wrote into the repo, every refusal needed an undo — and on a GitHub-issue store that
  // meant compensating closes plus a reconciliation pass for a tick that died half-way
  // through creating a set. Writing to scratch removes the whole class: a refused
  // document was never in the store, so there is nothing to take back. Only an ACCEPTED
  // document is ever published.
  //
  // It reads its parent from the repo by absolute path, which `addDirs` grants, exactly
  // as the judge already does.
  const scratch = isolatedCwd("narrowing-act");
  try {
    const spawned = await invoke(assembleNarrowingPrompt(ctx, scratch), {
      argv: buildClaudeArgv({
        maxBudgetUsd: ctx.budgetUsd,
        allowedTools: ["Read", "Grep", "Glob", "Write"],
        addDirs: [ctx.arenaDir],
        permissionMode: "dontAsk",
        ...(ctx.settingsPath !== undefined ? { settingsPath: ctx.settingsPath } : {}),
      }),
      cwd: scratch,
      timeoutMs: ctx.timeoutMs ?? 20 * 60_000,
      logPath: ctx.logPath,
    });

    const actSpend = spawned.resultMessage?.total_cost_usd ?? 0;

    // The tripwire. In the normal case the ACT touched nothing here, because it was never
    // pointed at the repo — but `Write` accepts an absolute path, so an ACT that reaches
    // in anyway is a containment failure, and a silent one is worse than a loud one.
    const touched = repoTouchedBy(ctx.arenaDir);
    if (touched.length > 0) {
      revertRepo(ctx.arenaDir, touched);
      return {
        kind: "failed",
        reason: "the ACT wrote into the repository instead of its scratch directory",
        outage: false,
        problems: touched.map((f) => `wrote ${f}`),
        spendUsd: actSpend,
      };
    }

    const failure = classifySpawn(spawned);
    if (failure !== null) {
      return { kind: "failed", reason: failure, outage: spawned.outage, problems: [`narrowing ACT ${failure}`], spendUsd: actSpend };
    }

    const written = readdirSync(scratch).filter((f) => f.endsWith(".md"));
    if (written.length === 0) {
      // An honest empty answer: nothing at this level is owed. Read from the absence of a
      // document, exactly as the plan rung reads an empty plan.
      return { kind: "empty", detail: `no ${ctx.level} was owed`, spendUsd: actSpend };
    }
    if (written.length > 1) {
      return {
        kind: "failed",
        reason: "the ACT wrote more than one narrowing",
        outage: false,
        problems: written.map((f) => `wrote ${f}`),
        spendUsd: actSpend,
      };
    }

    const file = written[0]!;
    const pending = `${narrowingDirRel(ctx.level)}/${file}`;
    const read = (): string => readFileSync(join(scratch, file), "utf8");
    /** Exactly what the judge was given, kept so "the fixer changed nothing" is detectable. */
    const text = read();

    // "Cannot be read" and "one field is wrong" are NOT the same thing, and collapsing
    // them cost a good document on the first real run of this rung.
    //
    // The writer produced an epic that quoted the PRD, argued why two ladder steps were
    // one slice, cited the ARCH's decision record, and covered thirteen criteria. It
    // carried `parent: prd`. An epic has no parent — the program is not an artifact — so
    // the parse failed, the draft was discarded, and $2.77 bought nothing. Deleting one
    // line would have fixed it.
    //
    // That is the re-roll shape this engine removed from every other rung, surviving here
    // because the refusal was justified with reasoning that is true of UNREADABLE
    // documents and false of this one: "without an envelope there is no id, no level and
    // no `delivers`, so neither a judge nor a fixer could run." This document had all three.
    //
    // So the hard refusal is now what it always should have been — frontmatter that cannot
    // be parsed at all. A frontmatter that parses and then fails a field rule is a
    // finding, and the correction pass fixes it alongside whatever the judge found.
    // The units scaffolded beside the epic (ADR-0006). Read now, so their findings travel
    // with the epic's through the same judge round and the same single correction pass.
    const scaffolded = readScaffolds(scratch);

    const first = parseNarrowing(text, pending);
    let envelopeFindings: string[] = [];
    /**
     * The document's identity AS WRITTEN, kept even when a field rule failed.
     *
     * A failed field rule does not erase the id — `parent: prd` left `id: ep-skeleton`
     * sitting right there — and reading it here is what keeps the identity guard below
     * armed for exactly the documents this change added. Null only when there genuinely
     * is no id to compare, which is the one case where a correction cannot be accused of
     * renaming anything.
     */
    let writtenId: string | null = first.ok ? first.narrowing.id : null;
    /**
     * What the engine can still compute about a document that parsed as YAML and then
     * failed a field rule. `null` when even the id or the `delivers` list is missing, which
     * is the only state where the arithmetic has nothing to run on.
     */
    let readable: Narrowing | null = first.ok ? first.narrowing : null;
    if (!first.ok) {
      const front = parseFrontmatter(text, pending);
      if (front.errors.length > 0) {
        // No frontmatter block, or not valid YAML, or not a mapping. There is nothing to
        // point a judge or a fixer at.
        return { kind: "rejected", problems: front.errors, spendUsd: actSpend };
      }
      envelopeFindings = first.errors;

      // Re-read the envelope for its PARTS. `parseNarrowing` returns errors or a whole
      // document and nothing between, which is right for its other callers — the store
      // and the chain want a document or a refusal. Here the parts are the point, and
      // re-parsing a small string is cheaper than widening a type six readers depend on.
      const { envelope } = parseEnvelope(text, pending);
      if (typeof envelope.id === "string" && envelope.id.length > 0) {
        writtenId = envelope.id;
        if ((envelope.delivers ?? []).length > 0) {
          readable = {
            id: envelope.id,
            // Not re-read here. This shape exists only for the free arithmetic below, which
            // reads ids; the published document carries whatever acceptance was written,
            // and the grade parses it from the artifact rather than from this stand-in.
            evidence: [],
            // An unreadable `level:` is SUBSTITUTED, not surrendered to: this rung mints
            // one level and only one, so `ctx.level` is what the document must end up
            // saying, and assuming it is what lets the coverage arithmetic run now rather
            // than after the fixer has been paid. The level error is already in
            // `envelopeFindings`, so the fixer is still told; and because the substituted
            // level matches, `mechanicalFindings` does not report it a second time.
            level: envelope.level === "epic" || envelope.level === "feature" ? envelope.level : ctx.level,
            ...(envelope.parent !== undefined ? { parent: envelope.parent } : {}),
            dependsOn: envelope.dependsOn ?? [],
            delivers: envelope.delivers!,
            renders: envelope.renders ?? [],
            // Read by nothing below — `mechanicalFindings` and both hop lints touch only
            // id, level, parent and delivers. Filled rather than faked into meaning: this
            // value is never published, because a document reaching here is re-parsed in
            // full after the correction pass and it is THAT reading that lands.
            title: envelope.title ?? "",
            status: "active",
            body: front.body,
            source: text,
            path: pending,
          };
        }
      }
    }

    // --- everything that is wrong with it, gathered ONCE ---
    //
    // Free first, paid second, and both into the same list. The order is the one this
    // ladder has always used — the lint decides what a judge reading prose is worst at —
    // but the lint no longer kills the document, so the judge runs on it either way and
    // the correction pass is handed the complete list. Two rounds for two kinds of
    // finding would be the loop this change exists to remove.
    // Computed off the READABLE document, not the fully-valid one. A draft can carry a
    // bad field AND a criterion the PRD does not have, and gating the arithmetic on a
    // clean parse meant the fixer was handed only the field — then the free re-check
    // below found the coverage error it was never told about and rejected the document.
    // That is the paid re-roll this change exists to remove, rebuilt one layer down.
    const mechanical = readable !== null ? mechanicalFindings(ctx, readable, pending) : [];
    // The ONE case where a correction pass is allowed to change the id: the engine told it
    // to. The guard below exists so a judge's reading applies to the artifact that exists,
    // and a rename the engine ordered does not break that — same document, free id. Without
    // this the two rules deadlock: the finding says rename, the guard says a correction is
    // not a new document, and a colliding draft can never be corrected at all.
    const renameOrdered = readable !== null && ctx.existing.some((e) => e.id === readable.id);

    const runDir = join(ctx.arenaDir, ".doctrine", "runs");
    mkdirSync(runDir, { recursive: true });
    const verdictPath = join(runDir, `narrowing-verdict-${Date.now()}.json`);
    const judged = await runNarrowingJudge(ctx, join(scratch, file), verdictPath);
    let spendUsd = actSpend + judged.spendUsd;
    if (!judged.ok) {
      // The judge could not run, or could not report. That is not the document's fault,
      // and it must never read as "nothing found": a document published unjudged because
      // a spawn timed out is the gate-becomes-optional failure, arriving quietly.
      return {
        kind: "failed",
        reason: judged.problems[0] ?? "narrowing-judge failed",
        outage: judged.outage,
        problems: judged.problems,
        spendUsd,
      };
    }

    const scaffoldProblems = readable !== null
      ? scaffoldFindings(ctx, readable, parseFeatures(readable.id, readable.body).features, scaffolded)
      : [];
    const findings = [...envelopeFindings, ...mechanical, ...scaffoldProblems, ...judged.findings];
    if (findings.length === 0 && first.ok) {
      const landed = publishWithScaffolds(ctx, first.narrowing, scaffolded.units);
      return { kind: "minted", id: first.narrowing.id, path: landed.ref, spendUsd, findingsFixed: 0, bodyChars: first.narrowing.body.length, units: landed.ids };
    }

    // --- one correction pass, and then it lands ---
    const fixed = await runNarrowingFix(ctx, scratch, file, findings);
    spendUsd += fixed.spendUsd;
    if (fixed.failure !== null) {
      return {
        kind: "failed",
        reason: `the correction pass ${fixed.failure}`,
        outage: fixed.outage,
        problems: [fixed.failure, ...findings],
        spendUsd,
      };
    }

    // The tripwire again, for the SAME reason and not a copied precaution. The fixer
    // holds `Write` with the repository in `addDirs`, exactly as the writer does, so it
    // can reach in with an absolute path — and it has a motive the writer does not: a
    // finding says this document disagrees with its parent, and editing the parent
    // "resolves" it. That edit would then be swept into the publish commit by
    // `stagePaths`, which is how a correction pass could quietly rewrite the PRD.
    const touchedByFix = repoTouchedBy(ctx.arenaDir);
    if (touchedByFix.length > 0) {
      revertRepo(ctx.arenaDir, touchedByFix);
      return {
        kind: "failed",
        reason: "the correction pass wrote into the repository instead of its scratch directory",
        outage: false,
        problems: touchedByFix.map((f) => `wrote ${f}`),
        spendUsd,
      };
    }

    // It must have corrected THE DOCUMENT — not written a second one beside it.
    //
    // The ACT's own "wrote more than one" check runs before the fix, and the re-read
    // below is BY NAME, so a pass that writes `ep-ledger-v2.md` and leaves the original
    // alone produces a clean re-check of an uncorrected document and publishes it
    // reporting three findings addressed. A silent false success, which is worse than any
    // refusal: nothing downstream can tell it from real work.
    const afterFiles = readdirSync(scratch).filter((f) => f.endsWith(".md"));
    if (afterFiles.length !== 1 || afterFiles[0] !== file) {
      return {
        kind: "rejected",
        problems: [`the correction pass left ${afterFiles.join(", ") || "no documents"} where it was given ${file} — it corrects that file, it does not write another`],
        spendUsd,
      };
    }
    if (read() === text) {
      // Findings existed — that is why this pass ran — and the file is byte-identical.
      // Publishing it would report every finding as addressed when none was.
      return {
        kind: "rejected",
        problems: [`the correction pass changed nothing, with ${findings.length} finding(s) outstanding`, ...findings],
        spendUsd,
      };
    }

    // --- the free half, re-run: it costs nothing, so it can afford to be a gate ---
    //
    // The asymmetry is the point. The paid judge ran once and its findings have been
    // addressed; asking it again is the unbounded loop, in which every answer invites a
    // new question at roughly twelve dollars a turn. The arithmetic is deterministic and
    // free, so there is no reason to take the correction pass's word for it — and it is
    // the half that protects the coverage chain, where a wrong `delivers` list means a
    // criterion silently reaches no child and the whole ladder reports green for it.
    const after = parseNarrowing(read(), pending);
    if (!after.ok) {
      return { kind: "rejected", problems: ["the correction pass left a document that does not parse", ...after.errors], spendUsd };
    }
    // Identity is compared whenever there WAS an identity to compare — which includes a
    // document that failed a field rule, since the failure was never about its id. Gating
    // this on a clean first parse turned the guard OFF for precisely the drafts this
    // change added, so a correction pass could rename `parent: prd` into a new document
    // and publish it under an id the judge never read.
    if (writtenId !== null && !renameOrdered && after.narrowing.id !== writtenId) {
      // Identity is not a finding to be fixed; it is the thing findings are ABOUT. A pass
      // that renames the document has written a different one, and publishing that would
      // mean the judge's reading applies to no artifact that exists.
      return {
        kind: "rejected",
        problems: [`the correction pass changed the id from "${writtenId}" to "${after.narrowing.id}" — a correction is not a new document`],
        spendUsd,
      };
    }
    // Re-read rather than reuse: the correction pass owns the whole scratch directory, and
    // a fixer told a unit's coverage claim is wrong fixes it by rewriting that unit.
    const fixedScaffolds = readScaffolds(scratch);
    const remaining = [
      ...mechanicalFindings(ctx, after.narrowing, pending),
      ...scaffoldFindings(ctx, after.narrowing, parseFeatures(after.narrowing.id, after.narrowing.body).features, fixedScaffolds),
    ];
    if (remaining.length > 0) {
      return { kind: "rejected", problems: [`${remaining.length} mechanical finding(s) survived the correction pass`, ...remaining], spendUsd };
    }

    const landed = publishWithScaffolds(ctx, after.narrowing, fixedScaffolds.units);
    return { kind: "minted", id: after.narrowing.id, path: landed.ref, spendUsd, findingsFixed: findings.length, bodyChars: after.narrowing.body.length, units: landed.ids };
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
  }
}
