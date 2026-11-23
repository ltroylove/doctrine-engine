import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildClaudeArgv } from "./argv.js";
import { isolatedCwd, type RunAgentFn } from "./judge.js";
import type { Narrowing } from "./narrowing.js";
import type { SetReview } from "./narrowing-set.js";
import { classifySpawn, runAgent as productionRunAgent } from "./spawn.js";

const LF = "\n";

/**
 * The paid half of the set rung: what arithmetic cannot decide, read by a judge.
 *
 * **It cannot gate and that is the design, not a limitation.** The free half already
 * refused what it can prove; everything this returns is recorded for the operator. So a
 * judge that is wrong costs a paragraph in a report and never a stalled program — which is
 * why it is given no correction pass and no retry. One spawn, one verdict, recorded.
 */

export interface SetJudgeContext {
  arenaDir: string;
  /** The law — `.claude/agents/narrowing-set-judge.md`. */
  agentDefinitionPath: string;
  /** Absolute paths of every document in the set. */
  documentPaths: readonly string[];
  /** What they all answer to: the PRD and ARCH for epics, the epic itself for features. */
  parent: { label: string; paths: readonly string[] };
  /** Total size of the set, so the judge can tell a five-document read from a thirty-document one. */
  totalChars: number;
  /**
   * Where to look first: identifiers more than one epic's features make an ownership claim
   * about, most contested first. Computed by `crossEpicCandidates`, deterministic, and a
   * HINT — the judge is told it is a starting order and not a list of findings.
   *
   * Empty or absent for a set small enough to read whole.
   */
  candidates?: ReadonlyArray<{ name: string; claimedBy: string[]; epics: string[] }>;
  verdictPath: string;
  logPath: string;
  budgetUsd: number;
  timeoutMs?: number;
  settingsPath?: string;
  runAgent?: RunAgentFn;
}

export interface SetFinding {
  documents: string[];
  text: string;
  quotes: string[];
}

export type SetJudgeRun =
  /** The judge ran. `findings` is what it found between the documents. */
  | { ok: true; findings: SetFinding[]; spendUsd: number }
  /**
   * The judge could not run or could not report. NOT a finding, and not a failure of the
   * set either — an advisory pass that could not happen is recorded as not having happened,
   * which is the honest artifact. The free gate's verdict stands on its own.
   */
  | { ok: false; problems: string[]; outage: boolean; spendUsd: number };

const REQUIRED_CHECKS = [
  "no-two-build-one-thing",
  "order-matches-parent",
  "gaps-are-shared",
  "no-contradicted-boundaries",
] as const;

interface RawVerdict {
  verdict?: string;
  checks?: Array<{ check?: string; ok?: boolean; cite?: string }>;
  findings?: Array<{ documents?: unknown; text?: unknown; quotes?: unknown }>;
}

function agentLaw(path: string): string {
  const raw = readFileSync(path, "utf8");
  // The frontmatter is the harness's, not the law's; the agent reads what follows it.
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  return (m?.[1] ?? raw).trim();
}

/**
 * The verdict shape, rendered HERE and stated nowhere else.
 *
 * `narrowing-set-judge.md` does not name a single check, on purpose. A check named in the
 * law and in the validator is one rule with two statements, and the two drift — not by
 * anyone loosening one, but by the next author writing from memory. Adding to
 * `REQUIRED_CHECKS` changes what the judge is asked for and what it is validated against
 * in the same edit, which is the only version of this that cannot fall out of step.
 */
function verdictSchema(verdictPath: string): string {
  const rows = REQUIRED_CHECKS.map((c) => `    { "check": ${JSON.stringify(c)}, "ok": true, "cite": "what settles it" }`).join("," + LF);
  return [
    "# Your verdict",
    "",
    `Write this JSON to EXACTLY: ${verdictPath}`,
    "",
    "```json",
    "{",
    '  "verdict": "coherent | incoherent",',
    '  "checks": [',
    rows,
    "  ],",
    '  "findings": [',
    '    { "documents": ["ep-a", "ep-b"], "text": "what is wrong, which document should change, and to what", "quotes": ["the line from ep-a", "the line from ep-b"] }',
    "  ]",
    "}",
    "```",
    "",
    `All ${REQUIRED_CHECKS.length} checks, every time. A check you did not perform is not a check`,
    "that passed, and every one you omit is reported as unperformed rather than as satisfied.",
    "",
    '`findings` is empty when there is nothing between these documents to report.',
  ].join(LF);
}

/**
 * The starting order, handed to the judge as a HINT.
 *
 * A set of thirty documents cannot be read whole and must not be read in part and ruled on
 * whole. This is the third option: the engine says where to look, deterministically, and
 * the judge reads around the hits.
 *
 * Framed as a place to start and never as findings, because it is a text heuristic over
 * prose and some of these will be innocent. It is advisory input to an advisory pass;
 * nothing gates on it, and a wrong hint costs one wasted grep.
 */
function candidateSection(candidates: ReadonlyArray<{ name: string; claimedBy: string[]; epics: string[] }>): string[] {
  if (candidates.length === 0) return [];
  return [
    "# Where to start",
    "",
    "These identifiers carry ownership language — creates, owns, builds, or the disclaimers:",
    '"does not create", "belongs to" — in features under MORE THAN ONE epic. Most contested',
    "first. The engine found them by reading the prose; it has not judged any of them.",
    "",
    ...candidates.map((c) => `- \`${c.name}\` — claimed or disclaimed by ${c.claimedBy.length} features across ${c.epics.length} epics: ${c.claimedBy.join(", ")}`),
    "",
    "**This is a starting order, not a list of findings.** Most will be innocent: a shared",
    "vocabulary word, or one document properly consuming what another properly owns. Read",
    "around each and decide. It is also not exhaustive — a collision phrased in words this",
    "list does not match is still yours to find, and a check you could not settle says so in",
    "its citation rather than passing.",
    "",
  ];
}

export async function runSetJudge(ctx: SetJudgeContext, review: SetReview): Promise<SetJudgeRun> {
  const invoke = ctx.runAgent ?? productionRunAgent;
  const scratch = isolatedCwd("narrowing-set-judge");
  const what = review.scope === "epics" ? "every epic in the program"
    : review.scope === "all-features" ? "every feature in the program, across all of its epics"
    : `every feature of ${review.epicId}`;
  const prompt = [
    agentLaw(ctx.agentDefinitionPath),
    "",
    "---",
    "",
    "# The set you are reading",
    "",
    `This is ${what}, complete — ${ctx.documentPaths.length} document(s), ${Math.round(ctx.totalChars / 1000)}k characters in total.`,
    "",
    ...ctx.documentPaths.map((p) => `- ${p}`),
    "",
    `THE PARENT they all answer to: ${ctx.parent.label}`,
    ...ctx.parent.paths.map((p) => `  ${p}`),
    "",
    `repository root: ${ctx.arenaDir}`,
    "",
    "You run from an empty scratch directory outside the repository, so a relative path",
    'resolves into nothing and a "missing" file is evidence of nothing at all.',
    "",
    "Each of these has already been judged against that parent and passed. What is left is",
    "what is wrong BETWEEN them, and that is the only thing you report.",
    "",
    ...candidateSection(ctx.candidates ?? []),
    verdictSchema(ctx.verdictPath),
  ].join(LF);

  let spawned;
  try {
    spawned = await invoke(prompt, {
      argv: buildClaudeArgv({
        maxBudgetUsd: ctx.budgetUsd,
        allowedTools: ["Read", "Grep", "Glob", "Write"],
        // Every document's directory plus the verdict's, for the same reason the narrowing
        // judge needs it: `--add-dir` is what grants a directory under `dontAsk`, and a
        // judge that cannot read the files it exists to read rules on nothing and calls it
        // a verdict. The documents are committed here rather than sitting in a writer's
        // scratch, so `arenaDir` covers them — the verdict path is the one outside it.
        addDirs: [ctx.arenaDir, dirname(ctx.verdictPath)],
        permissionMode: "dontAsk",
        ...(ctx.settingsPath !== undefined ? { settingsPath: ctx.settingsPath } : {}),
      }),
      cwd: scratch,
      timeoutMs: ctx.timeoutMs ?? 15 * 60_000,
      logPath: ctx.logPath,
    });
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
  }

  const spendUsd = spawned.resultMessage?.total_cost_usd ?? 0;
  const failure = classifySpawn(spawned);
  if (failure !== null) return { ok: false, problems: [`narrowing-set-judge ${failure}`], outage: spawned.outage, spendUsd };
  if (!existsSync(ctx.verdictPath)) {
    return { ok: false, problems: ["narrowing-set-judge wrote no verdict"], outage: false, spendUsd };
  }

  let v: RawVerdict;
  try {
    v = JSON.parse(readFileSync(ctx.verdictPath, "utf8")) as RawVerdict;
  } catch (e) {
    return { ok: false, problems: [`narrowing-set-judge verdict is not JSON: ${String(e).slice(0, 120)}`], outage: false, spendUsd };
  }

  const seen = new Map((v.checks ?? []).map((c) => [c.check, c]));
  const cited = (c: { cite?: string } | undefined): boolean => typeof c?.cite === "string" && c.cite.trim().length > 0;
  const unreported = [
    ...REQUIRED_CHECKS.filter((c) => !seen.has(c)).map((c) => `narrowing-set-judge reported no result for: ${c}`),
    // A PASSING check with no citation is the same failure as a missing one, and it is the
    // more dangerous of the two because it looks like an answer. The law requires a
    // citation on every check, passing or failing — for a pass, what was read that settles
    // it. Accepting an uncited pass would stamp the report with `review.hash`, caching an
    // unsupported clean result on this exact set forever: the paid half turned off by a
    // sentence nobody wrote. External review, PR #81.
    ...REQUIRED_CHECKS.filter((c) => seen.has(c) && seen.get(c)!.ok === true && !cited(seen.get(c)))
      .map((c) => `narrowing-set-judge passed ${c} with no citation — a pass that names nothing is not a check that was performed`),
  ];
  if (unreported.length > 0) {
    return { ok: false, problems: unreported, outage: false, spendUsd };
  }

  // Findings are the judge's PRODUCT and not its verdict line, exactly as at the rung
  // above: a set called "coherent" while a check is not ok is not a contradiction to
  // resolve, it is a judge that found something and rounded it off.
  const findings: SetFinding[] = [];
  for (const f of v.findings ?? []) {
    const text = typeof f.text === "string" ? f.text.trim() : "";
    if (text.length === 0) continue;
    findings.push({
      documents: Array.isArray(f.documents) ? f.documents.map((d) => String(d)) : [],
      text,
      quotes: Array.isArray(f.quotes) ? f.quotes.map((q) => String(q)) : [],
    });
  }
  for (const c of v.checks ?? []) {
    if (c.ok === true) continue;
    const cite = typeof c.cite === "string" ? c.cite.trim() : "";
    // A failing check whose finding is already in the list would be reported twice; one
    // with no finding and no citation names nothing and cannot be acted on. Both are
    // recorded as what they are rather than dropped.
    if (cite.length === 0) {
      findings.push({ documents: [], text: `${c.check}: marked not ok with no citation — a finding that names nothing cannot be acted on`, quotes: [] });
    } else if (!findings.some((x) => x.text.includes(cite.slice(0, 40)))) {
      findings.push({ documents: [], text: `${c.check}: ${cite}`, quotes: [] });
    }
  }

  return { ok: true, findings, spendUsd };
}

/**
 * The report, committed to the arena.
 *
 * **It is the record AND the idempotence key**, which is why it is a committed artifact and
 * not a `.doctrine/runs/` log: `hash` is over the documents exactly as written, so a set
 * whose report carries the current hash has been reviewed and a set whose prose changed has
 * not. Stateless and artifact-derived, like every other decision this loop makes.
 */
/**
 * One review, one report file. Derived from `scope` in ONE place, because it was derived
 * from `level` in two — `writeSetReport` and `reviewedHash` — and a third scope would have
 * had to be added to both or the key would read a file the writer never wrote.
 */
function reportRel(review: SetReview): string {
  const name = review.scope === "epics" ? "epics.md"
    : review.scope === "all-features" ? "features-all.md"
    : `features-${review.epicId}.md`;
  return join("docs", "program", "coherence", name);
}

export function writeSetReport(
  arenaDir: string,
  review: SetReview,
  judge: SetJudgeRun | null,
): string {
  const rel = reportRel(review);
  const path = join(arenaDir, rel);
  mkdirSync(dirname(path), { recursive: true });

  // **A run that did not do the paid work may not erase the run that did.**
  //
  // The rule lives HERE rather than in a caller's control flow, because it was written in
  // a caller's control flow once and that was not enough. External review caught the
  // CLI's `fresh` path overwriting a judged report with `hash: none`; the fix guarded that
  // path, and `--free` — the other way to reach this function without a judge — walked
  // straight past it and erased four real reports on the next run. Two statements of one
  // rule, and the one nobody wrote is the one that fired.
  //
  // So: the same set, already judged, is never downgraded. A set whose PROSE changed has a
  // different hash and is not this case — it falls through and is rewritten, which is
  // correct, because the old findings were about documents that no longer exist.
  if ((judge === null || !judge.ok) && reviewedHash(arenaDir, review) === review.hash) return rel;

  const lines: string[] = [
    "---",
    `level: ${review.level}`,
    ...(review.epicId !== undefined ? [`epic: ${review.epicId}`] : []),
    // The key is what the JUDGE reviewed, not what the arithmetic saw. A `--free` run
    // writes a real report and stamps no hash: it did not do the paid half, so a later
    // run must still do it. Recording the hash here anyway would let one cheap sweep
    // suppress the expensive check forever — a gate turned off by the thing that reports
    // on it.
    `hash: ${judge !== null && judge.ok ? review.hash : "none"}`,
    `members: [${review.members.join(", ")}]`,
    "---",
    "",
    `# Set coherence — ${review.scope === "epics" ? "the epic set" : review.scope === "all-features" ? "every feature in the program" : `features of ${review.epicId}`}`,
    "",
    `${review.members.length} document(s) reviewed as a set. Each was already judged against its`,
    "parent and passed; what follows is only what is wrong BETWEEN them.",
    "",
    "## Blocking",
    "",
  ];
  lines.push(
    review.problems.length === 0
      ? "None. The arithmetic over the complete set is clean."
      : review.problems.map((p) => `- ${p}`).join(LF),
  );
  lines.push("", "## Advisory", "");
  const advisory = [
    ...review.advisory,
    ...(judge === null
      ? ["the set judge did not run — the free arithmetic above stands on its own"]
      : judge.ok
        ? judge.findings.map((f) => `${f.documents.length > 0 ? `**${f.documents.join(" / ")}** — ` : ""}${f.text}${f.quotes.length > 0 ? LF + f.quotes.map((q) => `  > ${q}`).join(LF) : ""}`)
        : judge.problems.map((p) => `the set judge could not report: ${p}`)),
  ];
  lines.push(advisory.length === 0 ? "None." : advisory.map((a) => `- ${a}`).join(LF));
  lines.push("", "## Not checked here", "");
  lines.push(
    "Order has no declared edge between siblings to check against, so it is read as prose by",
    "the judge above and is never blocking. A mechanical order check needs a frontmatter",
    "field these documents do not carry.",
    "",
  );

  writeFileSync(path, lines.join(LF), "utf8");
  return rel;
}

/** Has this exact set already been reviewed? Read from the artifact, never from memory. */
export function reviewedHash(arenaDir: string, review: SetReview): string | undefined {
  const path = join(arenaDir, reportRel(review));
  if (!existsSync(path)) return undefined;
  return /^hash:\s*(\S+)$/m.exec(readFileSync(path, "utf8"))?.[1];
}
