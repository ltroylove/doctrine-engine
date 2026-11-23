import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { buildClaudeArgv } from "./argv.js";
import { isolatedCwd, type RunAgentFn } from "./judge.js";
import type { RunFailureReason } from "./outcome.js";
import { classifySpawn, runAgent as productionRunAgent } from "./spawn.js";

/**
 * The design-judge. The conformance gate proves no raw value escaped the
 * token file; this is the other half — whether the result was designed or generated.
 *
 * The mechanism is target-generic and the taste is not. Everything specific lives in
 * the target's manifest `design` block: which file is the contract, which command
 * renders the screens, where they land. A target with no UI declares none and pays
 * nothing.
 *
 * The judge RUNS the screens command itself rather than being handed images. That is
 * what makes the screenshots self-produced evidence in the sense the isolation law
 * means: it saw the thing, it was not shown a picture of the thing.
 */

export interface DesignBlock {
  /** Repo-relative path to the design contract (a token file, or a document). */
  contract: string;
  /** Command that renders every screen to `out`. Run by the judge, in the worktree. */
  screens: string;
  /** Repo-relative directory the command fills with images. */
  out: string;
  /**
   * Exit code the screens command uses to say "nothing is registered yet, and that is
   * legitimate" — as opposed to "I tried to render and could not". Default 3.
   *
   * This has to be explicit. The engine probes the base worktree to decide whether a
   * baseline exists, and inferring it from "no images appeared" cannot tell an empty
   * register from a browser that failed to launch. Getting that wrong is not a missing
   * check but an inverted one: a transient capture failure on the base would be read as
   * "this app has never had screens", and a change to a mature UI would be graded
   * absolutely, with the real baseline never compared (doctrine#22 review).
   */
  emptyExitCode?: number;
}

/** The documented "nothing registered yet" exit code, when a target does not set one. */
export const DEFAULT_EMPTY_EXIT_CODE = 3;

export interface DesignJudgeContext {
  /** The worktree holding the change under judgement. */
  headDir: string;
  /**
   * The worktree WITHOUT the change. The judge renders both and grades the difference.
   *
   * Judging head alone was the first design and it was wrong. The loop's
   * provable job is "to not degrade" the design — a delta claim — and a judge that
   * grades the screen absolutely fails an innocent change for whatever was already
   * imperfect. Calibration proved it on the first run: the control, a one-token spacing
   * improvement, was failed for a type-size inconsistency the judge measured in the
   * BASELINE. It was right about the defect and wrong about whose fault it was, and a
   * judge that fails every change cannot gate anything.
   */
  baseDir: string;
  /**
   * True when the base renders NO screens at all — the bootstrap case.
   *
   * The engine decides this by running the screens command in the base worktree
   * ITSELF, never by asking the judge. That distinction is the whole point: "the
   * baseline is legitimately empty" and "the judge skipped the baseline render" look
   * identical from inside the verdict, and only one of them may relax the gate.
   *
   * Every target reaches this exactly once. A target's first UI unit is by definition
   * the one that registers the first screen, so its base has an empty register and the
   * capture command exits non-zero. Requiring images on both sides made that unit
   * impossible to pass — it failed `no-screens`, the branch was reaped, and all UI work
   * behind it was blocked on a human seeding a baseline by hand, in a loop whose
   * premise is that no human is in it (found in review on doctrine#20).
   */
  baselineEmpty: boolean;
  design: DesignBlock;
  verdictPath: string;
  logPath: string;
  budgetUsd: number;
  agentDefinitionPath: string;
  settingsPath?: string;
  timeoutMs?: number;
  runAgent?: RunAgentFn;
}

export interface DesignFinding {
  screen: string;
  region: string;
  rule: string;
  observed: string;
  ok: boolean;
}

export interface DesignVerdict {
  verdict: "pass" | "fail";
  screens: string[];
  findings: DesignFinding[];
  gates_executed: string[];
}

/** Guard against a pathological verdict, not a length budget — see below. */
const CAP = 12000;

/**
 * What a design rejection tells the NEXT attempt, in the judge's own words.
 *
 * This is a retry's input, not a line in a log, and it was neither. It reported
 * `screen (region): rule` and stopped — the rule is a slug (`token-used-against-its-
 * meaning`), so the string named the violation and threw away the only field that says
 * what is wrong: `observed`, which the verdict schema requires precisely because a
 * finding that cannot say what is on screen is not a finding. Then it clipped the
 * result to 300 characters, which on a real verdict is two findings out of seven.
 *
 * That is the #29 defect one rung down. The code-judge path above was fixed and this
 * one, ten lines below it, was not — so the failure feedback worked for every unit
 * except the UI units, which are the ones that fail on judgement rather than on a
 * command's exit code.
 *
 * The cap is larger than the code-judge's for a reason and not an arbitrary one: a
 * design finding is a MEASUREMENT ("digit ink height is 10.0px where §3 names 20px"),
 * so eight of them run past 6000 characters in the ordinary case. A cap that clips the
 * ordinary case is a length budget, which is the thing this is not. It is a guard
 * against a pathological verdict.
 */
/**
 * Each failing finding as ONE string, anchored to the screen and region it is about.
 *
 * The list, rather than the joined blob, because the correction pass takes findings one
 * per entry and numbers them — and `designFailureDetail` below builds its blob from this
 * same function, so the two cannot describe a finding differently.
 */
export function designFindingList(verdict: DesignVerdict): string[] {
  return verdict.findings
    .filter((f) => !f.ok)
    .map((f) => {
      const rule = f.rule.trim();
      return `${f.screen} (${f.region})${rule.length > 0 ? ` — ${rule}` : ""}: ${f.observed}`;
    });
}

export function designFailureDetail(verdict: DesignVerdict): string {
  const parts = designFindingList(verdict);

  // Whole findings, never a slice through one. A raw `.slice(CAP)` would cut a 700-
  // character measurement mid-sentence and the retry would read the half it got as the
  // whole finding — worse than not sending it, because it looks complete. So findings
  // are dropped entire, and the string says how many, so a retry that is missing
  // something knows it is.
  const kept: string[] = [];
  let used = 0;
  for (const part of parts) {
    if (used + part.length > CAP) break;
    kept.push(part);
    used += part.length + 2;
  }
  const dropped = parts.length - kept.length;
  // A single finding longer than the cap is the pathological case the cap is for: keep
  // its opening rather than returning nothing at all, and say that is what happened.
  if (kept.length === 0 && parts.length > 0) {
    return `${parts[0]!.slice(0, CAP)}\u2026 [truncated; ${parts.length} finding(s) in the verdict, see the run's design-verdict.json]`;
  }
  const note = dropped > 0
    ? `\n\n[${dropped} further finding(s) omitted for length — the full verdict is in the run's design-verdict.json]`
    : "";
  return kept.join("\n\n") + note;
}

/** The same rejection as one line, for a person reading the tick log. */
export function designFailureSummary(verdict: DesignVerdict): string {
  return verdict.findings
    .filter((f) => !f.ok)
    .map((f) => `${f.screen} (${f.region}): ${f.rule}`)
    .join("; ")
    .slice(0, 300);
}

export type DesignJudgeOutcome =
  | { kind: "judged"; verdict: DesignVerdict; spendUsd: number; logPath: string }
  // `no-screens-head` and `no-screens-base` are separated because they have different owners.
  // A head that renders nothing is the UNIT's failure — its change broke the app or dropped the
  // screen from the register, and the retry has to be told so and has to pay for it. A base that
  // renders nothing is the instrument or the environment, and the unit did not touch it.
  | { kind: "failed"; reason: RunFailureReason | "malformed-verdict" | "missing-verdict" | "no-screens-head" | "no-screens-base"; errors: string[]; outage: boolean; spendUsd: number; logPath: string };

function agentLaw(path: string): string {
  const text = readFileSync(path, "utf8");
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return (m ? m[1]! : text).trim();
}

export function assembleDesignJudgePrompt(ctx: DesignJudgeContext): string {
  return `${agentLaw(ctx.agentDefinitionPath)}

---

# Your task

## The screens${ctx.baselineEmpty ? "" : " — BEFORE and AFTER"}

${ctx.baselineEmpty ? `This change registers the FIRST screens this app has. There is no before: the engine
ran the capture command in the base worktree and it rendered nothing, because nothing
was registered yet. Run it once, here:

    ${ctx.design.screens}

- ${ctx.headDir} → ${join(ctx.headDir, ctx.design.out)}

Read every image. If the command fails, that is your verdict.

**Grade these against the design contract directly.** There is no baseline to compare
with, so the "a flaw in both is not this change's doing" allowance below does not apply
— every flaw you find here IS this change's doing, because this change drew it. Judge
it the way you would judge a first draft against its brief: strictly, and on the
contract's own terms.` : `Run this command yourself in BOTH worktrees, before you look at anything:

    ${ctx.design.screens}

- before (without the change): ${ctx.baseDir} → ${join(ctx.baseDir, ctx.design.out)}
- after (with the change):     ${ctx.headDir} → ${join(ctx.headDir, ctx.design.out)}

Read every image in both. If either command fails, that is your verdict — a UI that
cannot be rendered cannot be judged, and saying so is the honest answer.`}

${ctx.baselineEmpty ? `**Every flaw here is this change's doing.** There is no earlier version of these
screens, so nothing on them pre-exists and nothing can be excused as someone else's.
A flaw you find is \`ok: false\`.` : `**You are grading the difference, not the screen.** Your job is that this change did not
degrade the design. A flaw visible in BOTH images is not this change's doing: record it
as a finding with \`ok: true\` and say it pre-exists, so the observer sees it without the
change being blamed for it. Only something the change introduced or made worse is
\`ok: false\`.`}

That distinction is the whole instrument. A judge that fails every change for whatever
was already imperfect cannot gate anything, and "this could be better" is always
available to say about a screen.

**Name the standard you are failing it against.** You have three, and only three: the
design contract, the ban-list of generated-UI tells, and whether the screen answers the
question it exists to answer at a glance. Every failing finding must rest on one of them
and say which. The last two are INDEPENDENT of the contract and are not weakened by it —
a wall of equal-weight cards is a finding though no token forbids it, and a ledger whose
total you have to hunt for has failed though every pixel is on-token.

What you may not do is fail a screen against a standard none of the three supplies —
your own preference for how it should have been drawn. If the contract does not pin a
property, the ban-list does not name it, and its absence does not stop the screen being
read at a glance, then it is not a flaw: record it as a finding with \`ok: true\`, say
which standard you checked it against and that none covers it, and let the observer read
it. And where a clause of the contract can honestly be read two ways and the render
satisfies one of them, that is not a failure either — record the measurement, name both
readings, and pass it.

With no baseline this is the only brake there is, so it matters most exactly where it is
easiest to skip: being told that every flaw on the screen belongs to this change settles
who OWNS a flaw, and never what COUNTS as one. Without this rule a first screen can be
failed for anything a reader might have wanted on it, the gate is unpassable, and the
unit burns its whole budget against a standard nobody wrote down.

## The design contract
${join(ctx.headDir, ctx.design.contract)}

Read it by that absolute path. You are NOT in the repository — you run from an empty
scratch directory, so a relative path resolves into nothing and a missing file is
evidence of nothing.

## Write your verdict to EXACTLY
${ctx.verdictPath}

Record the screens command you ran and its exit code in \`screens_command\`, and list
the image files you actually opened in \`screens\`.
`;
}

/** A verdict is only a verdict if it looked at something and said where. */
export function validateDesignVerdict(raw: unknown): { ok: true; verdict: DesignVerdict } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) return { ok: false, errors: ["verdict is not an object"] };
  const v = raw as Record<string, unknown>;

  if (v["verdict"] !== "pass" && v["verdict"] !== "fail") errors.push('verdict must be "pass" or "fail"');
  const screens = Array.isArray(v["screens"]) ? v["screens"].filter((s): s is string => typeof s === "string") : [];
  if (screens.length === 0) errors.push("screens is empty — a judge that opened no image did not look");

  const findings: DesignFinding[] = [];
  if (!Array.isArray(v["findings"])) {
    errors.push("findings must be a list");
  } else {
    v["findings"].forEach((f, i) => {
      const e = f as Record<string, unknown>;
      const str = (k: string): boolean => typeof e[k] === "string" && (e[k] as string).trim().length > 0;
      if (!str("screen")) errors.push(`findings[${i}].screen must name a screenshot`);
      if (!str("region")) errors.push(`findings[${i}].region must say WHERE — cite the region or it did not happen`);
      if (!str("observed")) errors.push(`findings[${i}].observed must say what is actually on screen`);
      if (typeof e["ok"] !== "boolean") errors.push(`findings[${i}].ok must be a boolean`);
      else {
        findings.push({
          screen: String(e["screen"]), region: String(e["region"]),
          rule: typeof e["rule"] === "string" ? e["rule"] : "",
          observed: String(e["observed"]), ok: e["ok"],
        });
      }
    });
  }
  // No findings at all is a judge that did not look, not a clean screen.
  if (findings.length === 0 && errors.length === 0) {
    errors.push("no findings — a pass must say what it saw on each screen, or it is a judge that did not look");
  }
  // Honesty: a pass may not coexist with a failing finding.
  if (v["verdict"] === "pass" && findings.some((f) => !f.ok)) {
    errors.push("verdict is pass but a finding fails — a pass with failing entries is dishonest by construction");
  }
  // And the other way: a rejection has to name what it rejected. On the delta path a
  // verdict of all `ok: true` findings is exactly the shape of a PASS — every flaw seen
  // was ruled pre-existing — so calling that a fail rejects the change for something it
  // did not do, and hands the retry nothing to answer.
  if (v["verdict"] === "fail" && findings.length > 0 && !findings.some((f) => !f.ok)) {
    errors.push("verdict is fail but every finding passes — a rejection that names nothing it rejected is not a verdict");
  }
  const gates = Array.isArray(v["gates_executed"]) ? v["gates_executed"].filter((g): g is string => typeof g === "string") : [];
  for (const required of ["screens-rendered", "screens-viewed"]) {
    if (!gates.includes(required)) errors.push(`gate "${required}" has no execution proof — green-by-absence is banned`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, verdict: { verdict: v["verdict"] as "pass" | "fail", screens, findings, gates_executed: gates } };
}

export async function runDesignJudge(ctx: DesignJudgeContext): Promise<DesignJudgeOutcome> {
  const invoke = ctx.runAgent ?? productionRunAgent;
  mkdirSync(join(ctx.verdictPath, ".."), { recursive: true });
  const scratch = isolatedCwd("design-judge");
  let spawned;
  try {
    spawned = await invoke(assembleDesignJudgePrompt(ctx), {
      argv: buildClaudeArgv({
        maxBudgetUsd: ctx.budgetUsd,
        allowedTools: ["Bash", "Read", "Grep", "Glob", "Write"],
        addDirs: [ctx.baseDir, ctx.headDir, join(ctx.verdictPath, "..")],
        permissionMode: "dontAsk",
        ...(ctx.settingsPath !== undefined ? { settingsPath: ctx.settingsPath } : {}),
      }),
      cwd: scratch,
      // Longer than the code-judge: this one installs the target, renders every
      // screen in a real browser, and then reads images. 15 minutes timed out a canary.
      timeoutMs: ctx.timeoutMs ?? 30 * 60_000,
      logPath: ctx.logPath,
    });
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
  }

  const spendUsd = spawned.resultMessage?.total_cost_usd ?? 0;
  const failure = classifySpawn(spawned);
  if (failure !== null) {
    return { kind: "failed", reason: failure, errors: [], outage: spawned.outage, spendUsd, logPath: ctx.logPath };
  }

  // Trust artifacts: the images must actually be on disk, on BOTH sides, whatever the
  // verdict says. Checking head alone lets a judge that skipped the baseline render
  // report `screens-rendered` and hand back an absolute judgement — which is exactly
  // the false-positive the before/after comparison exists to prevent, arriving through
  // the one door the validator could not see.
  const images = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)) : [];
  const outDir = join(ctx.headDir, ctx.design.out);
  const baseOutDir = join(ctx.baseDir, ctx.design.out);
  const rendered = images(outDir);
  // A baseline the ENGINE already established is empty is not a baseline the judge
  // failed to render, and only the second is a reason to refuse a verdict.
  const baseRendered = ctx.baselineEmpty ? ["(bootstrap: no baseline)"] : images(baseOutDir);
  if (rendered.length === 0 || baseRendered.length === 0) {
    const headFailed = rendered.length === 0;
    const which = headFailed ? outDir : baseOutDir;
    return {
      kind: "failed", reason: headFailed ? "no-screens-head" : "no-screens-base",
      errors: [`the screens command produced no images in ${which} — a change cannot be judged against a baseline that was never rendered`],
      outage: false, spendUsd, logPath: ctx.logPath,
    };
  }

  if (!existsSync(ctx.verdictPath)) {
    return { kind: "failed", reason: "missing-verdict", errors: ["design-judge wrote no verdict"], outage: false, spendUsd, logPath: ctx.logPath };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(ctx.verdictPath, "utf8"));
  } catch (e) {
    return { kind: "failed", reason: "malformed-verdict", errors: [String(e).slice(0, 200)], outage: false, spendUsd, logPath: ctx.logPath };
  }
  const validated = validateDesignVerdict(raw);
  if (!validated.ok) {
    return { kind: "failed", reason: "malformed-verdict", errors: validated.errors, outage: false, spendUsd, logPath: ctx.logPath };
  }
  // A verdict naming screens that were never rendered is not evidence of anything, and a QUALIFIED
  // name is checked against the worktree it names.
  //
  // The judge is entitled to say which side it opened: on the delta path two directories hold the
  // same file names, so "billing.png" cannot tell the before from the after, and it writes
  // `impl/.artifacts/screens/billing.png` and `base/...`. Comparing bare `readdir` names refused
  // those as malformed — it cost u-2026-09-05-invoice-review an attempt on 2026-09-07, the first UI
  // unit judged against a real baseline, and stood in front of every UI unit after it.
  //
  // But reducing a qualified name to its file name throws away the very claim that needs checking.
  // On the bootstrap path `base/shots/billing.png` would then pass whenever the HEAD rendered
  // `billing.png`, though the base rendered nothing — a judge claiming a comparison it could not
  // have made, admitted by the check that exists to catch exactly that.
  //
  // So: a name qualified by a worktree is verified against that worktree's images; a bare name may
  // match either side, which is the older, laxer behaviour and all a bare name can support.
  const headWorktree = basename(ctx.headDir);
  const baseWorktree = basename(ctx.baseDir);
  const headImages = new Set(rendered);
  const baseImages = new Set(ctx.baselineEmpty ? [] : images(baseOutDir));
  const missing = validated.verdict.screens.filter((s) => {
    const parts = s.replace(/\\/g, "/").split("/").filter((x) => x.length > 0);
    const file = parts[parts.length - 1] ?? s;
    if (parts.length > 1) {
      if (parts.includes(baseWorktree)) return !baseImages.has(file);
      if (parts.includes(headWorktree)) return !headImages.has(file);
    }
    return !headImages.has(file) && !baseImages.has(file);
  });
  if (missing.length > 0) {
    return {
      kind: "failed", reason: "malformed-verdict",
      errors: [`verdict cites screens that were not rendered: ${missing.join(", ")}`],
      outage: false, spendUsd, logPath: ctx.logPath,
    };
  }
  return { kind: "judged", verdict: validated.verdict, spendUsd, logPath: ctx.logPath };
}
