import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LevelGradeRecord } from "./grade.js";
import type { WorkUnit } from "./work-unit.js";

/**
 * What is still wrong when the loop has nothing left it can do.
 *
 * A loop that reaches `chain-complete` or `idle` is saying "nothing to build". If the program is
 * also not done, that is a STALL, and it used to be silent: a target once idled for two days
 * after a screen unit was refused and its dependents retired, and again overnight
 * after a correct judge escalation did the same, while three failed epic grades sat
 * unanswered. Each time the evidence was all on disk; nothing put it in front of anyone.
 *
 * Read from the artifacts every time, like everything else in the tick: escalated units, and
 * feature or epic grades whose latest record is not a pass. Empty means a quiet idle is honest.
 */
export function outstanding(arenaDir: string, units: readonly WorkUnit[], activeSubjects: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const u of units) {
    if (u.status === "escalated") out.push(`unit ${u.id} is escalated`);
  }
  // Only grades of epics and features the ladder still asks about. A retired epic's record
  // stays on disk (records are stable per subject), and counting its old `fail` would turn a
  // deliberate retirement into a permanent pause (doctrine#102 review).
  for (const level of ["feature", "epic"] as const) {
    const dir = join(arenaDir, ".doctrine", "grades", level);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      let rec: LevelGradeRecord;
      try {
        rec = JSON.parse(readFileSync(join(dir, file), "utf8")) as LevelGradeRecord;
      } catch {
        out.push(`${level} grade record ${file} is unreadable`);
        continue;
      }
      if (!activeSubjects.has(rec.subject)) continue;
      if (rec.verdict !== "pass") {
        out.push(`${level} ${rec.subject} is ${rec.verdict}${rec.detail !== undefined ? ` (${rec.detail.slice(0, 120)})` : ""}`);
      }
    }
  }
  return out;
}

/** The pause body an observer reads: what stalled, and every item still outstanding. */
export function stallReason(where: "chain-complete" | "idle", items: readonly string[]): string {
  return [
    `stalled at ${where}: the loop has nothing it can do, and the program is not done.`,
    "Outstanding (each needs an observer):",
    ...items.map((i) => `- ${i}`),
    "",
  ].join("\n");
}
