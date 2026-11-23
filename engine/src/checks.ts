import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASH } from "./setup.js";
import type { WorkUnit } from "./work-unit.js";

/**
 * The FREE half of verifying a diff: run the target's gates and the unit's own evidence,
 * and report what failed. No model, no budget, no judgement.
 *
 * **Why this exists, and why it is what makes the rest of the rung safe.** Every other
 * rung on this ladder pairs a paid reader with a free computation, and the free half is
 * what lets the paid one run exactly once: the narrowing and intent rungs re-run their
 * coverage arithmetic after a correction pass, so the judge is never asked twice. A diff
 * had no free half — the evidence commands existed, but the only thing that ever ran them
 * was the code-judge, from inside a paid spawn. So a failed unit could only be re-checked
 * by paying a judge again, and the engine's answer was instead to DELETE the branch and
 * build the unit from scratch.
 *
 * Measured on one target: $271 of $1,123 — 24% — went to work that was discarded that
 * way, and a failed attempt cost $15.92 against $9.69 for one that merged, because it ran
 * implement plus judge plus often design-judge before being thrown away. Thirteen of
 * twenty-one failures were findings about code that existed and could have been corrected.
 *
 * **`gates` was documentary until now.** The manifest has carried a `gates` map since
 * onboarding and nothing executed it; the UI admissibility check read its KEYS to decide
 * whether a design gate existed and never ran the command. A declared gate nobody runs is a
 * comment.
 */

/** How much of a failing command's output travels into a finding. */
const OUTPUT_TAIL = 3_000;

export interface CheckRun {
  /** `gate:typecheck`, or `evidence[0]` — what this was, for the log and the finding. */
  label: string;
  command: string;
  exitCode: number;
  /** Where the full output was written. Findings carry only the tail. */
  logPath: string;
  outputSha256: string;
}

export interface CheckResult {
  runs: CheckRun[];
  /**
   * One per failing command, written to be ACTED ON rather than read.
   *
   * A finding reaches a correction pass verbatim and is all it gets: it cannot ask what
   * was meant, and it cannot see this terminal. So each one names the command, what the
   * unit expected of it, and the tail of what actually happened.
   */
  findings: string[];
}

function run(cwd: string, label: string, command: string, logPath: string): { run: CheckRun; output: string } {
  const res = spawnSync(BASH, ["-c", command], { cwd, encoding: "utf8", timeout: 10 * 60_000 });
  const output = `${res.stdout ?? ""}${res.stderr ? `\n--- stderr ---\n${res.stderr}` : ""}`;
  mkdirSync(join(logPath, ".."), { recursive: true });
  writeFileSync(logPath, output);
  return {
    run: {
      label,
      command,
      // `status` is null when the process was killed — a timeout, or a signal. -1 is not
      // a real exit code and is deliberately distinguishable from any code a command can
      // return, so "the command was killed" never reads as "the command failed with 1".
      exitCode: res.status ?? -1,
      logPath,
      outputSha256: createHash("sha256").update(output).digest("hex"),
    },
    output,
  };
}

/** The last of a command's output, which is where a compiler or a test runner says why. */
function tail(output: string): string {
  const trimmed = output.trim();
  return trimmed.length <= OUTPUT_TAIL ? trimmed : `...\n${trimmed.slice(-OUTPUT_TAIL)}`;
}

/**
 * Run every gate and every piece of the unit's evidence, in that order, against `cwd`.
 *
 * Gates first because they are the cheap, broad ones — a typecheck failure explains an
 * evidence failure, and reporting both as separate findings sends a correction pass
 * chasing a symptom. They all run regardless: a correction pass gets ONE round, so it has
 * to be handed everything that is wrong at once, and stopping at the first failure would
 * hand it a third of the list and cost a whole extra attempt to discover the rest.
 *
 * **Exit 0 is the only thing that counts as met**, for the same reason the intent's
 * acceptance uses it: output is a claim and an exit code is a fact. A command that prints
 * a number and exits 0 proves nothing, which is why `decomposer.md` requires evidence to
 * be self-verifying (`test "$(...)" -eq 0`, never `... | wc -l`).
 */
export function runUnitChecks(
  cwd: string,
  unit: WorkUnit,
  gates: Readonly<Record<string, string>> | undefined,
  logDir: string,
): CheckResult {
  const runs: CheckRun[] = [];
  const findings: string[] = [];

  for (const [name, command] of Object.entries(gates ?? {})) {
    if (typeof command !== "string" || command.trim().length === 0) continue;
    const { run: r, output } = run(cwd, `gate:${name}`, command, join(logDir, `gate-${name.replace(/[^A-Za-z0-9_-]/g, "_")}.log`));
    runs.push(r);
    if (r.exitCode !== 0) {
      findings.push(
        `gate \`${name}\` failed (exit ${r.exitCode}): \`${command}\`\n` +
        `This is the target's own standing gate and it must pass before anything lands.\n` +
        `--- the end of its output ---\n${tail(output)}`,
      );
    }
  }

  unit.evidence.forEach((spec, i) => {
    const { run: r, output } = run(cwd, `evidence[${i}]`, spec.run, join(logDir, `evidence-${i}.log`));
    runs.push(r);
    if (r.exitCode !== 0) {
      findings.push(
        `evidence[${i}] failed (exit ${r.exitCode}): \`${spec.run}\`\n` +
        `The unit says this should mean: ${spec.expect}\n` +
        `--- the end of its output ---\n${tail(output)}`,
      );
    }
  });

  return { runs, findings };
}

/**
 * Did the same set of commands pass this time? Compared by LABEL, not by position.
 *
 * Used after a correction pass, where the question is not "is everything green" but "is
 * anything that was failing still failing" — and by-position comparison would silently
 * re-home every finding if the evidence list were ever reordered, reporting a fault in
 * one command against another. The planning rungs learned the same lesson about pairing
 * an intent with its filename rather than indexing two arrays.
 */
export function stillFailing(before: CheckResult, after: CheckResult): string[] {
  const wasFailing = new Set(
    before.runs.filter((r) => r.exitCode !== 0).map((r) => r.label),
  );
  return after.runs
    .filter((r) => r.exitCode !== 0 && wasFailing.has(r.label))
    .map((r) => `${r.label} is still failing after the correction pass: \`${r.command}\``);
}
