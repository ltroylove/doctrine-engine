import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { engineCommit, stagePaths } from "./git-commit.js";
import type { EvidenceSpec } from "./envelope.js";
import type { Intent } from "./intent.js";
import { BASH, runSetup } from "./setup.js";

/**
 * The intent-grade tick: the ENGINE — no LLM — executes the intent's
 * acceptance evidence after all children merge. Pass → intent done. Fail → the
 * failure output becomes the gap-decompose input. Coverage is settled by reality.
 *
 * Convention: acceptance `run` commands must be self-verifying — exit 0 means met.
 * The prose `expect` is for humans and the decomposer.
 */

export interface GradeRun {
  command: string;
  exit_code: number;
  output_sha256: string;
  log: string;
}

/**
 * What this grade FAILED on, as one stable string.
 *
 * The gap decomposer is asked what is left to slice, and its answer is a function of the
 * evidence: the same failing commands with byte-identical output get the same answer. So
 * this is the key for "has anything changed that could change the answer" — over the
 * command, its exit code and the hash of what it printed, which `GradeRun` already carries
 * because the grade artifact is the audit trail.
 *
 * It is exactly right for the case it was built for, and that is not a coincidence — an
 * intent blocked on a module that does not exist fails with an import error naming it, and
 * the moment a sibling slice lands that module the error changes, so the signature changes
 * and the decomposer is asked again at precisely the tick where it has something new to say.
 */
export function failureSignature(runs: readonly GradeRun[]): string {
  const h = createHash("sha256");
  for (const r of runs) {
    // Command and exit code for EVERY run, so a check that flips from passing to failing —
    // or the reverse — moves the signature even when nothing else does.
    h.update(r.command).update("\u0000").update(String(r.exit_code)).update("\u0000");
    // Output for the FAILING runs only, and this is the whole correction. A passing test
    // runner prints its own duration, so `npm test` hashes differently on every run while
    // the thing being asked about has not moved at all. Measured on a target: of seven
    // acceptance commands, `npm test` differed between two consecutive grades and the other
    // six — including all five failures — were byte-identical, so a signature over every run
    // never matched and the skip never fired once.
    //
    // It is also the semantically right half. The decomposer is asked what is still FAILING;
    // what a passing command printed on its way to exit 0 is not part of that question.
    if (r.exit_code !== 0) h.update(r.output_sha256).update("\u0000");
  }
  return h.digest("hex").slice(0, 16);
}

export type GradeOutcome =
  | { kind: "pass"; runs: GradeRun[] }
  | { kind: "fail"; runs: GradeRun[]; failureLog: string };



function execEvidence(cwd: string, command: string, logPath: string): GradeRun {
  const res = spawnSync(BASH, ["-c", command], { cwd, encoding: "utf8", timeout: 10 * 60_000 });
  const output = `${res.stdout ?? ""}${res.stderr ? `\n--- stderr ---\n${res.stderr}` : ""}`;
  writeFileSync(logPath, output);
  return {
    command,
    exit_code: res.status ?? -1,
    output_sha256: createHash("sha256").update(output).digest("hex"),
    log: logPath,
  };
}

/**
 * Bring the arena's dependencies up to what the landed units declare, before grading
 * against them.
 *
 * Units are built and judged in worktrees, each of which gets the manifest's setup
 * command run in it. The arena root does not — its `node_modules` is whatever the
 * last install left there, which on a target being built from nothing is the install
 * from onboarding, against a `package.json` that has since been rewritten by the very
 * units now being graded.
 *
 * The harness intent hit this exactly: six units landed, all judged green in their
 * worktrees, and the intent grade then reported `npm test` and `npm run typecheck`
 * failing with "Cannot find module 'vitest'" and "'preact/jsx-runtime'". Nothing was
 * wrong with the work — every one of the nine acceptance commands passed the moment
 * the arena was installed. A grade that measures a stale environment does not measure
 * the intent, and it fails in the most expensive direction: it says finished work is
 * unfinished, and sends a gap-decompose ACT off to build what is already there.
 *
 * Setup failure is NOT a grade failure and must not be reported as one — it is an
 * environment fault, and the caller decides. It throws.
 */
function prepareArena(arenaDir: string, setup: string | undefined): void {
  runSetup(setup, [arenaDir]);
}

/**
 * **Bound to the intent DIALECT, not to the type.** `Intent` is `WorkUnit` now, so nothing
 * in the signature stops a unit being handed to this — and it would go badly quietly: the
 * status flip writes to `work/intents/<id>.md`, which for a unit does not exist, and the
 * write is wrapped in a `catch {}` whose whole justification was that a failure surfaces
 * as the intent never reaching `done`. For a unit that reasoning does not hold; it would
 * grade, pass, and record nothing.
 *
 * It is not guarded here because the only caller loads from `work/intents/` and the guard
 * would be a second statement of the collection rule.
 *
 * **This was NOT re-pointed**, which is what an earlier version of this comment said
 * would happen. The feature grade is `runLevelGrade` beside it, and this one stays exactly
 * as it is: it serves the legacy intent rung, which runs unchanged until cutover, and
 * re-pointing a function two ladders share would have put the new rung's behaviour into the
 * old rung's path. Both call `runGrade`, so the executor is shared and only the recording
 * differs — a status flip here, a committed record there, because an intent has a `status:`
 * field and a feature deliberately has none.
 *
 * It is deleted with the dialect at cutover.
 */
/**
 * Run one level's acceptance and say what happened. **The whole of what a grade IS**, at
 * every level: prepare the arena, execute each command, hash what it printed, keep the log.
 *
 * Shared by all three rungs on purpose. ADR-0003 makes acceptance lighter going up, and
 * lightness is a property of what is WRITTEN, not of how it is run — a feature's
 * end-to-end check and a unit's probe are both a line that must exit 0. A second executor
 * per level would be the same rule written three times, which is how a rule comes to be
 * applied at one level and not its sibling.
 */
export function runGrade(
  arenaDir: string,
  subject: { id: string; evidence: readonly EvidenceSpec[] },
  setup?: string,
): GradeOutcome & { gradeDir: string } {
  const gradeDir = join(arenaDir, ".doctrine", "grades", `${gradeSlug(subject.id)}-${Date.now()}`);
  mkdirSync(gradeDir, { recursive: true });
  prepareArena(arenaDir, setup);

  const runs: GradeRun[] = [];
  for (const [i, spec] of subject.evidence.entries()) {
    runs.push(execEvidence(arenaDir, spec.run, join(gradeDir, `acceptance-${i}.log`)));
  }
  writeFileSync(join(gradeDir, "grade.json"), JSON.stringify({ subject: subject.id, runs }, null, 2));

  const failures = runs.filter((r) => r.exit_code !== 0);
  if (failures.length === 0) return { kind: "pass", runs, gradeDir };
  const failureLog = failures
    .map((f) => `command: ${f.command}\nexit: ${f.exit_code}\noutput (tail):\n${readFileSync(f.log, "utf8").slice(-2000)}`)
    .join("\n\n");
  return { kind: "fail", runs, failureLog, gradeDir };
}

/**
 * A level's id as a path segment.
 *
 * A feature id is `<epic id>#<n.m>` (`feature.ts`), derived from its position so it cannot
 * drift. `#` is legal in a filename on every platform this runs on and is a FRAGMENT
 * separator everywhere a path becomes a URL or a `gh` argument, so it is replaced once,
 * here, rather than at each of the places an id becomes a name.
 */
export function gradeSlug(id: string): string {
  return id.replace(/#/g, "--");
}

export function runIntentGrade(arenaDir: string, intent: Intent, setup?: string): GradeOutcome {
  const graded = runGrade(arenaDir, intent, setup);
  const runs = graded.runs;

  if (graded.kind === "pass") {
    // Flip intent -> done; the grade record is the evidence.
    const intentPath = join(arenaDir, "work", "intents", `${intent.id}.md`);
    try {
      writeFileSync(intentPath, readFileSync(intentPath, "utf8").replace(/^status:\s*decomposed/m, "status: done"));
      stagePaths(arenaDir, [join("work", "intents", `${intent.id}.md`)]);
      engineCommit(arenaDir, `doctrine: intent-grade PASS ${intent.id} (status: done)`);
    } catch { /* status flip failure surfaces as the intent never reaching done — loud by absence in the ladder */ }
    return { kind: "pass", runs };
  }

  return { kind: "fail", runs, failureLog: graded.failureLog };
}

/**
 * **The feature and epic grades (ADR-0003), and the record that makes them artifacts.**
 *
 * The intent grade could get away without one. An intent is a document with a `status:`
 * field, so "this level passed" was recorded by flipping it to `done` and committing —
 * and the grade's own runs were audit trail, committed later by an observer doing
 * housekeeping, or not at all.
 *
 * Neither level here has that option. A feature is a HEADING inside its epic (ADR-0001)
 * and deliberately has no status; an epic lost its stored status, because done
 * is computed from its features. So the grade record IS the artifact — it is what the
 * next tick reads to know this level is closed, which makes it load-bearing state and not
 * a log. It is written to a stable path per subject, overwritten by each grade, and
 * COMMITTED by the engine that wrote it.
 *
 * That is the D6 rule applied honestly: real state is re-derived from committed artifacts
 * every tick. A pass kept only in an uncommitted local JSON would make the loop stateful
 * at the one rung ADR-0003 calls the ratchet, and a fresh clone would re-run — or worse,
 * re-plan — work that was finished.
 */
export type LevelGradeVerdict = "pass" | "fail" | "ungraded";

export interface LevelGradeRecord {
  /** The feature or epic id this is about. */
  subject: string;
  level: "feature" | "epic";
  verdict: LevelGradeVerdict;
  /** ISO 8601, UTC. */
  at: string;
  /** The commit the acceptance was run against, so a stale record is recognisable. */
  head: string;
  /** `failureSignature` over the runs — the key the gap ratchet re-asks on. */
  signature: string;
  runs: GradeRun[];
  /** Why, when the verdict is `ungraded`. */
  detail?: string;
}

/** Where one level's grade record lives, repo-relative. Stable per subject, never per run. */
export function levelGradeRel(level: "feature" | "epic", id: string): string {
  return join(".doctrine", "grades", level, `${gradeSlug(id)}.json`);
}

export function readLevelGrade(
  arenaDir: string,
  level: "feature" | "epic",
  id: string,
): LevelGradeRecord | undefined {
  try {
    const rec = JSON.parse(readFileSync(join(arenaDir, levelGradeRel(level, id)), "utf8")) as LevelGradeRecord;
    return rec.subject === id && typeof rec.verdict === "string" ? rec : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Has this level been graded and passed?
 *
 * **Not keyed on HEAD, and that is the difference from `intentSettled`.** Settlement
 * answers "is it worth asking again at this commit" and clears itself when anything lands.
 * This answers "did the acceptance for this level pass", which does not stop being true
 * because a sibling slice merged. Re-running a passing feature suite on every subsequent
 * tick would make the loop slower the more of the program is finished, which is exactly
 * backwards.
 */
export function levelPassed(arenaDir: string, level: "feature" | "epic", id: string): boolean {
  return readLevelGrade(arenaDir, level, id)?.verdict === "pass";
}

/**
 * Withdraw a level's pass because new work was added under it, and commit why.
 *
 * The epic ratchet parents its gap units under a feature that already passed. Left alone,
 * that pass outlives the change: the feature selector skips a passed feature for good, so
 * once the gap unit merges nothing re-runs the feature's own acceptance, and the epic can be
 * graded on a stale pass even if the new unit broke the feature (doctrine#100 review). An
 * `ungraded` record with the reason is the existing state for "not shown to work", so every
 * reader already treats it as not passed, and the feature is graded again once its units land.
 */
export function reopenLevel(arenaDir: string, level: "feature" | "epic", id: string, head: string, reason: string): void {
  const rel = levelGradeRel(level, id);
  const record: LevelGradeRecord = {
    subject: id, level, verdict: "ungraded", at: new Date().toISOString(),
    head, signature: "", runs: [], detail: `reopened: ${reason}`,
  };
  mkdirSync(dirname(join(arenaDir, rel)), { recursive: true });
  writeFileSync(join(arenaDir, rel), JSON.stringify(record, null, 2));
  try {
    stagePaths(arenaDir, [rel]);
    engineCommit(arenaDir, `doctrine: ${level}-grade REOPENED ${id} (${reason})`);
  } catch { /* the record is on disk either way; an uncommitted one is re-derived next tick */ }
}

export type LevelGradeOutcome =
  | { kind: "pass"; runs: GradeRun[]; record: LevelGradeRecord }
  | { kind: "fail"; runs: GradeRun[]; failureLog: string; record: LevelGradeRecord }
  /** Nothing to run. NOT a pass — see below. */
  | { kind: "ungraded"; detail: string; record: LevelGradeRecord };

/**
 * Grade one feature or one epic, and commit what it found.
 *
 * **A level carrying no acceptance is `ungraded`, never a pass.** This is the same
 * distinction drawn one field over: a criterion nothing names is absent from the
 * satisfied set, not satisfied by default. A feature with an empty `Acceptance` bullet has
 * not been shown to work — nothing ran — and closing it on that would let the ratchet be
 * switched off by omitting a bullet, which is the quietest possible way to lose the one
 * mechanism that makes plan coverage answerable against reality.
 *
 * It is recorded rather than thrown for the same reason every other refusal here is: the
 * observer needs to see WHICH level is unclosable and why, and the next tick needs to stop
 * asking. A thrown error would take the supervisor down over a missing bullet.
 */
export function runLevelGrade(
  arenaDir: string,
  level: "feature" | "epic",
  subject: { id: string; evidence: readonly EvidenceSpec[] },
  head: string,
  setup?: string,
): LevelGradeOutcome {
  const rel = levelGradeRel(level, subject.id);
  const write = (record: LevelGradeRecord): void => {
    mkdirSync(dirname(join(arenaDir, rel)), { recursive: true });
    writeFileSync(join(arenaDir, rel), JSON.stringify(record, null, 2));
    try {
      stagePaths(arenaDir, [rel]);
      engineCommit(arenaDir, `doctrine: ${level}-grade ${record.verdict.toUpperCase()} ${subject.id}`);
    } catch { /* the record is on disk either way; an uncommitted one is re-derived next tick */ }
  };

  if (subject.evidence.length === 0) {
    const detail = `${subject.id} carries no acceptance — nothing ran, so nothing was shown to work`;
    const record: LevelGradeRecord = {
      subject: subject.id, level, verdict: "ungraded", at: new Date().toISOString(),
      head, signature: "", runs: [], detail,
    };
    write(record);
    return { kind: "ungraded", detail, record };
  }

  const graded = runGrade(arenaDir, subject, setup);
  const record: LevelGradeRecord = {
    subject: subject.id, level,
    verdict: graded.kind === "pass" ? "pass" : "fail",
    at: new Date().toISOString(),
    head,
    signature: failureSignature(graded.runs),
    runs: graded.runs,
  };
  write(record);
  return graded.kind === "pass"
    ? { kind: "pass", runs: graded.runs, record }
    : { kind: "fail", runs: graded.runs, failureLog: graded.failureLog, record };
}
