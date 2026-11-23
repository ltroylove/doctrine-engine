import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildClaudeArgv } from "./argv.js";
import { isolatedCwd, type RunAgentFn } from "./judge.js";
import { classifySpawn, runAgent as productionRunAgent } from "./spawn.js";
import { lintTicket, parseTicket, type Ticket, type TicketContext } from "./ticket.js";
import { repoTouchedBy, revertRepo } from "./narrowing-store.js";
import type { RawIssue, TicketStore } from "./ticket-store.js";

/**
 * One triage pass: read a raw issue, write the ticket, check it, correct it, publish it.
 *
 * The same shape as every other rung, and by now that is the point rather than a
 * coincidence:
 *
 *   write -> free mechanical checks -> judge (ONCE) -> one correction pass -> publish
 *
 * The free half is `lintTicket`, which is most of what makes a ticket buildable: every
 * path resolves, no placeholder survives, a repair's criteria exist and its feature
 * carries them, growth's proposed ids do not already exist. A checklist the agent
 * attests to having followed is a claim, not a check; here the engine checks the ticket
 * itself and the judge never spends a turn on any of it.
 */

/** A triaged ticket over this is not a ticket. See `MAX_TICKET_INTENTS`. */
export const MAX_TICKET_CHARS = 12_000;

export interface TriageContext {
  arenaDir: string;
  issue: RawIssue;
  store: TicketStore;
  /** The PRD criteria, the epics and the features — what a ticket is checked against. */
  lint: Omit<TicketContext, "arenaDir">;
  /** Program inputs, for the triager to read: it has to know what the PRD already says. */
  prdPath: string;
  archPath: string;
  logPath: string;
  agentDefinitionPath: string;
  judgeAgentPath: string;
  fixerAgentPath: string;
  budgetUsd: number;
  fixBudgetUsd?: number;
  settingsPath?: string;
  /** Why the last attempt at THIS issue was discarded — parse failures only. */
  priorRejection?: string;
  timeoutMs?: number;
  runAgent?: RunAgentFn;
}

export type TriageOutcome =
  | { kind: "triaged"; id: string; findingsFixed: number; spendUsd: number }
  | { kind: "rejected"; problems: string[]; spendUsd: number }
  | { kind: "failed"; reason: string; outage: boolean; problems: string[]; spendUsd: number };

const LF = String.fromCharCode(10);

function agentLaw(path: string): string {
  const text = readFileSync(path, "utf8");
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return (m ? m[1]! : text).trim();
}

export function assembleTriagePrompt(ctx: TriageContext, outDir: string): string {
  const features = ctx.lint.features.map((f) => `- ${f.id} [parent ${f.parent ?? "?"}] ${f.title} — delivers ${f.delivers.join(", ")}`);
  const epics = ctx.lint.epics.map((e) => `- ${e.id} ${e.title} — delivers ${e.delivers.join(", ")}`);
  return [
    agentLaw(ctx.agentDefinitionPath),
    "",
    "---",
    "",
    "# The issue you are triaging",
    "",
    `${ctx.issue.url} (#${ctx.issue.number})`,
    "",
    `## ${ctx.issue.title}`,
    "",
    ctx.issue.body.trim().length > 0 ? ctx.issue.body.trim() : "(the issue has no body — say so, and triage from the title alone)",
    "",
    "---",
    "",
    "# Your task",
    "",
    `Write the triaged ticket as a single \`.md\` file in your working directory:`,
    "",
    "  " + outDir,
    "",
    "That directory is yours and is thrown away after this run. Write nothing anywhere",
    "else — not into the repository, not into the issue. The engine reads what you leave",
    "there, checks it, and publishes it to the issue itself.",
    "",
    "- THE PROGRAM, which decides whether this is a repair or growth:",
    "  " + join(ctx.arenaDir, ctx.prdPath),
    "  " + join(ctx.arenaDir, ctx.archPath),
    "- repository root, to scan: " + ctx.arenaDir,
    "",
    "Read them by ABSOLUTE path. The repository is not your working directory, so a",
    "relative path resolves inside the scratch directory and will look like a missing file.",
    "",
    "## The epics that exist",
    epics.length > 0 ? epics.join(LF) : "(none — every ticket is growth until an epic exists)",
    "",
    "## The features that exist, and what each one delivers",
    features.length > 0 ? features.join(LF) : "(none)",
    "",
    "A repair's `home` must be one of those features, and it must already cover every",
    "criterion you list. If none does, the behaviour is not in the PRD and this is growth.",
    "",
    ctx.priorRejection !== undefined
      ? [
          "## The last ticket written here was discarded",
          "",
          "A judge's findings are corrected rather than refused, so these are not opinions",
          "about that ticket — they are the reasons nothing could be done with it at all.",
          "Do not reproduce them.",
          "",
          ctx.priorRejection,
          "",
        ].join(LF)
      : "",
    "Write the one file and nothing else. A judge reads it and says what is wrong, and one",
    "correction pass fixes those things before it is published — so write the ticket you",
    "believe in rather than hedging.",
    "",
  ].join(LF);
}

interface TriageVerdict {
  verdict: "pass" | "fail";
  checks?: Array<{ check: string; ok: boolean; cite?: string }>;
  problems?: string[];
}

/**
 * What the judge is asked, and the ONE place it is written.
 *
 * Everything mechanical is absent on purpose: paths, placeholders, criterion existence and
 * sizing are all decided for free before a judge runs, and asking it to re-decide them
 * would be paying roughly nine dollars for arithmetic.
 */
export const TRIAGE_CHECKS = [
  // The classification the rest of the flow hangs on. Getting it wrong sends a PRD change
  // through a path that has none, or invents a criterion for behaviour already stated.
  "repair-or-growth-is-right",
  // The ticket has to be about the issue somebody actually opened.
  "faithful-to-the-issue",
  // Discovery rather than plausibility: the paths resolve (checked free), but whether they
  // are the RIGHT ones is a reading.
  "the-files-are-the-ones-involved",
] as const;

function judgeSchema(verdictPath: string): string {
  const rows = TRIAGE_CHECKS.map((c) => `    { "check": ${JSON.stringify(c)}, "ok": true, "cite": "..." }`).join("," + LF);
  return [
    "## Write your verdict JSON to EXACTLY: " + verdictPath,
    "",
    "```json",
    "{",
    '  "ticket": "<the path you judged>",',
    '  "verdict": "pass|fail",',
    '  "checks": [',
    rows,
    "  ],",
    '  "problems": []',
    "}",
    "```",
    "",
    `All ${TRIAGE_CHECKS.length} checks, every time. A check you omit is not a check and cannot become a`,
    "finding — there is nothing for a correction pass to act on — so the engine fails the",
    "run and pays for another judge rather than publishing on a report that skipped one.",
    "",
    "Mark a check `ok: false` when it found something, and put what you found in `cite`.",
    "That text is handed verbatim to whoever corrects the ticket and is all they get: they",
    "cannot see the issue through your eyes and cannot ask you a question. Name the field",
    "and name what it should say instead.",
  ].join(LF);
}

type JudgeRun =
  | { ok: true; findings: string[]; spendUsd: number }
  | { ok: false; problems: string[]; outage: boolean; spendUsd: number };

async function runTriageJudge(ctx: TriageContext, ticketPath: string, verdictPath: string): Promise<JudgeRun> {
  const invoke = ctx.runAgent ?? productionRunAgent;
  const scratch = isolatedCwd("ticket-judge");
  const prompt = [
    agentLaw(ctx.judgeAgentPath),
    "",
    "---",
    "",
    "# What you are judging",
    "",
    "- THE TICKET: " + ticketPath,
    `- THE ISSUE it was triaged from: ${ctx.issue.url} (#${ctx.issue.number})`,
    "",
    `## ${ctx.issue.title}`,
    "",
    ctx.issue.body.trim().length > 0 ? ctx.issue.body.trim() : "(no body)",
    "",
    "- THE PROGRAM, which decides repair from growth:",
    "  " + join(ctx.arenaDir, ctx.prdPath),
    "  " + join(ctx.arenaDir, ctx.archPath),
    "- repository root: " + ctx.arenaDir,
    "",
    "Read them by ABSOLUTE path; you run from an empty scratch directory outside the",
    "repository, so a relative path resolves into nothing and a missing file is evidence of",
    "nothing at all.",
    "",
    judgeSchema(verdictPath),
    "",
  ].join(LF);

  let spawned;
  try {
    spawned = await invoke(prompt, {
      argv: buildClaudeArgv({
        maxBudgetUsd: ctx.budgetUsd,
        allowedTools: ["Read", "Grep", "Glob", "Write"],
        // The ticket's own directory. See the same fix in `narrowing-act.ts`: the judge
        // runs from a scratch directory that is not the writer's, so without this it
        // cannot read the ticket and would rule on the issue text alone.
        addDirs: [ctx.arenaDir, dirname(ticketPath)],
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
  if (failure !== null) return { ok: false, problems: [`ticket-judge ${failure}`], outage: spawned.outage, spendUsd };
  if (!existsSync(verdictPath)) {
    return { ok: false, problems: ["ticket-judge wrote no verdict — a judge that cannot report FAILS the run"], outage: false, spendUsd };
  }
  let v: TriageVerdict;
  try {
    v = JSON.parse(readFileSync(verdictPath, "utf8")) as TriageVerdict;
  } catch (e) {
    return { ok: false, problems: [`ticket-judge verdict is not JSON: ${String(e).slice(0, 120)}`], outage: false, spendUsd };
  }

  const seen = new Map((v.checks ?? []).map((c) => [c.check, c]));
  const cited = (c: { cite?: string }): boolean => typeof c.cite === "string" && c.cite.trim().length > 0;
  const findings: string[] = [
    ...(v.problems ?? []).filter((x) => typeof x === "string" && x.trim().length > 0),
    ...(v.checks ?? []).filter((c) => c.ok !== true && cited(c)).map((c) => `${c.check}: ${c.cite!.trim()}`),
  ];

  // The three ways a judge can fail to REPORT — identical to every other rung, in the same
  // words, because a finding that names nothing cannot be acted on wherever it came from.
  const problems: string[] = [
    ...TRIAGE_CHECKS.filter((n) => !seen.has(n)).map((n) => `ticket-judge reported no result for: ${n}`),
    ...(v.checks ?? [])
      .filter((c) => c.ok !== true && !cited(c))
      .map((c) => `ticket-judge marked ${c.check} not ok and gave no citation — a finding that names nothing cannot be acted on`),
  ];
  if (v.verdict !== "pass" && findings.length === 0 && problems.length === 0) {
    problems.push("ticket-judge refused the ticket without saying what is wrong with it");
  }
  if (problems.length > 0) return { ok: false, problems, outage: false, spendUsd };
  return { ok: true, findings, spendUsd };
}

async function runTriageFix(ctx: TriageContext, scratch: string, file: string, findings: readonly string[]): Promise<{ spendUsd: number; failure: string | null; outage: boolean }> {
  const invoke = ctx.runAgent ?? productionRunAgent;
  const prompt = [
    agentLaw(ctx.fixerAgentPath),
    "",
    "---",
    "",
    "# The ticket to correct",
    "",
    "  " + join(scratch, file),
    "",
    "It is in your working directory. Read it, correct it, and write it back to the SAME",
    "path with `Write`. Do not create a second file and do not rename it.",
    "",
    `- THE ISSUE it must be faithful to: ${ctx.issue.url} (#${ctx.issue.number})`,
    "",
    `## ${ctx.issue.title}`,
    "",
    ctx.issue.body.trim().length > 0 ? ctx.issue.body.trim() : "(no body)",
    "",
    "- THE PROGRAM, which decides repair from growth:",
    "  " + join(ctx.arenaDir, ctx.prdPath),
    "  " + join(ctx.arenaDir, ctx.archPath),
    "- repository root, to scan: " + ctx.arenaDir,
    "",
    "**Your tools are `Read`, `Grep`, `Glob`, `Bash` and `Write`.** Use `Bash` to check that",
    "a path you name exists before you name it — the engine refuses a ticket whose paths do",
    "not resolve, and that refusal costs a whole round.",
    "",
    `## The findings — ${findings.length} of them, and this is the complete list`,
    "",
    findings.map((f, i) => `${i + 1}. ${f.trim()}`).join(LF + LF),
    "",
    "Address every one, then stop. This is the only correction pass and what you write is",
    "published to the issue: there is no later round, and equally nothing else about this",
    "ticket is under review.",
    "",
  ].join(LF);
  const spawned = await invoke(prompt, {
    argv: buildClaudeArgv({
      maxBudgetUsd: ctx.fixBudgetUsd ?? Math.max(1, ctx.budgetUsd / 2),
      allowedTools: ["Read", "Grep", "Glob", "Bash", "Write"],
      addDirs: [ctx.arenaDir],
      permissionMode: "dontAsk",
      ...(ctx.settingsPath !== undefined ? { settingsPath: ctx.settingsPath } : {}),
    }),
    cwd: scratch,
    timeoutMs: ctx.timeoutMs ?? 15 * 60_000,
    logPath: ctx.logPath.replace(/\.log$/, "-fix.log"),
  });
  return { spendUsd: spawned.resultMessage?.total_cost_usd ?? 0, failure: classifySpawn(spawned), outage: spawned.outage };
}

/**
 * The tripwire, and this rung was written without one.
 *
 * Both triage ACTs hold `Bash` and `Write` with the repository in `addDirs` — the triager
 * so it can grep the codebase, the fixer so it can verify a path before naming it. The
 * prompts say the run writes only its scratch ticket, and a prompt is not a boundary: a
 * `sed -i` against the PRD, or an edit to source, would persist into the target's
 * uncommitted state and the NEXT tick would plan against it.
 *
 * The narrowing rung has had this since it was built. Copying that rung's shape without
 * copying its guard is the eighth instance this session of a rule applied to one path and
 * not its sibling; external review caught it here.
 *
 * `.doctrine/` is skipped because the scheduler writes run logs there around the ACT.
 */
function touchedRepo(ctx: TriageContext, who: string, spendUsd: number): TriageOutcome | undefined {
  const touched = repoTouchedBy(ctx.arenaDir);
  if (touched.length === 0) return undefined;
  revertRepo(ctx.arenaDir, touched);
  return {
    kind: "failed",
    reason: `${who} wrote into the repository instead of its scratch directory`,
    outage: false,
    problems: touched.map((f) => `wrote ${f}`),
    spendUsd,
  };
}

export async function runTriageAct(ctx: TriageContext): Promise<TriageOutcome> {
  const invoke = ctx.runAgent ?? productionRunAgent;
  const scratch = isolatedCwd("ticket-triage");
  const lintCtx: TicketContext = { arenaDir: ctx.arenaDir, ...ctx.lint };
  try {
    const spawned = await invoke(assembleTriagePrompt(ctx, scratch), {
      argv: buildClaudeArgv({
        maxBudgetUsd: ctx.budgetUsd,
        allowedTools: ["Read", "Grep", "Glob", "Bash", "Write"],
        addDirs: [ctx.arenaDir],
        permissionMode: "dontAsk",
        ...(ctx.settingsPath !== undefined ? { settingsPath: ctx.settingsPath } : {}),
      }),
      cwd: scratch,
      timeoutMs: ctx.timeoutMs ?? 20 * 60_000,
      logPath: ctx.logPath,
    });

    const actSpend = spawned.resultMessage?.total_cost_usd ?? 0;
    const failure = classifySpawn(spawned);
    if (failure !== null) {
      return { kind: "failed", reason: `triage ACT ${failure}`, outage: spawned.outage, problems: [], spendUsd: actSpend };
    }

    const touched = touchedRepo(ctx, "the triage ACT", actSpend);
    if (touched !== undefined) return touched;

    const written = readdirSync(scratch).filter((f) => f.endsWith(".md"));
    if (written.length === 0) {
      return { kind: "failed", reason: "the triage ACT wrote no ticket", outage: false, problems: [], spendUsd: actSpend };
    }
    if (written.length > 1) {
      return { kind: "failed", reason: "the triage ACT wrote more than one ticket", outage: false, problems: written, spendUsd: actSpend };
    }

    const file = written[0]!;
    const read = (): string => readFileSync(join(scratch, file), "utf8");
    const text = read();

    // A ticket the parser cannot read is the one hard refusal: no kind, no home, no
    // delivers, so neither a judge nor a fixer could be pointed at it.
    const first = parseTicket(text, ctx.issue.number, ctx.issue.url);
    if (!first.ok) return { kind: "rejected", problems: first.errors, spendUsd: actSpend };
    if (first.ticket.body.length > MAX_TICKET_CHARS) {
      return {
        kind: "rejected",
        spendUsd: actSpend,
        problems: [`the ticket body is ${first.ticket.body.length} characters, over the ${MAX_TICKET_CHARS} ceiling — a ticket describes one request, it does not restate the codebase`],
      };
    }

    const mechanical = lintTicket(first.ticket, lintCtx);

    const runDir = join(ctx.arenaDir, ".doctrine", "runs");
    mkdirSync(runDir, { recursive: true });
    const verdictPath = join(runDir, `ticket-verdict-${ctx.issue.number}-${Date.now()}.json`);
    const judged = await runTriageJudge(ctx, join(scratch, file), verdictPath);
    let spendUsd = actSpend + judged.spendUsd;
    if (!judged.ok) {
      return { kind: "failed", reason: judged.problems[0] ?? "ticket-judge failed", outage: judged.outage, problems: judged.problems, spendUsd };
    }

    const findings = [...mechanical, ...judged.findings];
    if (findings.length === 0) {
      ctx.store.publish(first.ticket, text);
      return { kind: "triaged", id: first.ticket.id, findingsFixed: 0, spendUsd };
    }

    const fixed = await runTriageFix(ctx, scratch, file, findings);
    spendUsd += fixed.spendUsd;
    if (fixed.failure !== null) {
      return { kind: "failed", reason: `the correction pass ${fixed.failure}`, outage: fixed.outage, problems: findings, spendUsd };
    }

    const touchedByFix = touchedRepo(ctx, "the correction pass", spendUsd);
    if (touchedByFix !== undefined) return touchedByFix;

    // The free half again: free, so it can afford to be the gate. The paid judge ran once.
    const afterFiles = readdirSync(scratch).filter((f) => f.endsWith(".md"));
    if (afterFiles.length !== 1 || afterFiles[0] !== file) {
      return {
        kind: "rejected",
        problems: [`the correction pass left ${afterFiles.join(", ") || "no ticket"} where it was given ${file}`],
        spendUsd,
      };
    }
    const afterText = read();
    if (afterText === text) {
      return { kind: "rejected", problems: [`the correction pass changed nothing, with ${findings.length} finding(s) outstanding`, ...findings], spendUsd };
    }
    const after = parseTicket(afterText, ctx.issue.number, ctx.issue.url);
    if (!after.ok) {
      return { kind: "rejected", problems: ["the correction pass left a ticket that does not parse", ...after.errors], spendUsd };
    }
    const remaining = lintTicket(after.ticket, lintCtx);
    if (remaining.length > 0) {
      return { kind: "rejected", problems: [`${remaining.length} mechanical finding(s) survived the correction pass`, ...remaining], spendUsd };
    }

    ctx.store.publish(after.ticket, afterText);
    return { kind: "triaged", id: after.ticket.id, findingsFixed: findings.length, spendUsd };
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
  }
}
