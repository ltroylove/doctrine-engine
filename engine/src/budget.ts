import { writeFileSync } from "node:fs";
import { appendTick, consecutiveUnitFailures, spendSince } from "./ledger.js";
import { pausePath } from "./steering.js";

/**
 * The four consolidated backstops. Per-ACT budget travels on the unit
 * itself (--max-budget-usd); these are the loop-level gates checked each tick.
 * Outage runs bypass both counters by construction.
 */

export interface BudgetConfig {
  attemptsPerUnit: number;
  dailySpendUsd: number;
  consecutiveFailuresHalt: number;
}

/**
 * Defaults, overridable per target via manifest `budgets`. Note on dailySpendUsd:
 * on subscription auth the ledger's dollars are NOTIONAL (the CLI's would-be API
 * cost), so this gate is not money protection — it is (a) the one anti-spin
 * backstop that catches interleaved failures across many units ("busy, expensive,
 * producing nothing" in aggregate, which per-unit attempts and the consecutive
 * halt both miss), and (b) usage pacing so an unattended loop cannot starve the
 * operator's own interactive sessions. Size it generously, not fearfully.
 */
export const DEFAULT_BUDGETS: BudgetConfig = {
  attemptsPerUnit: 2,
  dailySpendUsd: 100,
  consecutiveFailuresHalt: 3,
};

export type BudgetCheck = { ok: true } | { ok: false; halt: string };

function midnightUtcIso(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/**
 * Checked BEFORE any paid ACT (spend gates before spend). A tripped gate writes the
 * pause file itself — the loop stops itself loudly rather than degrading quietly.
 */
export function checkBudgets(arenaDir: string, cfg: BudgetConfig, nowMs: number = Date.now()): BudgetCheck {
  const spentToday = spendSince(arenaDir, midnightUtcIso(nowMs));
  if (spentToday >= cfg.dailySpendUsd) {
    // A budget that resets at midnight must write a pause that clears at midnight.
    // Without the resume_at line this said "until tomorrow" and meant "until a person
    // deletes this file" — the loop's most common stop was one only a human could end.
    const tomorrow = new Date(new Date(midnightUtcIso(nowMs)).getTime() + 24 * 60 * 60_000).toISOString();
    return halt(
      arenaDir,
      `daily spend gate: $${spentToday.toFixed(2)} >= $${cfg.dailySpendUsd} — waiting for the budget window to roll over`,
      tomorrow,
    );
  }
  const failures = consecutiveUnitFailures(arenaDir);
  if (failures >= cfg.consecutiveFailuresHalt) {
    return halt(arenaDir, `failure halt: ${failures} consecutive unit failures — something is systematically wrong; pausing for the observer`);
  }
  return { ok: true };
}

/**
 * `resumeAt` present → this is a reason to WAIT, and the loop clears it itself when the
 * window passes. Absent → a reason to STOP, and only the observer ends it.
 */
function halt(arenaDir: string, reason: string, resumeAt?: string): BudgetCheck {
  const body = resumeAt === undefined ? `${reason}\n` : `${reason}\nresume_at: ${resumeAt}\n`;
  writeFileSync(pausePath(arenaDir), body);
  // Record WHICH kind this is, here where it is known, rather than leaving a later
  // reader to infer it from the wording of `reason` — that text will drift, and what
  // depends on it is whether the failure backstop can be reset by a clock.
  appendTick(arenaDir, { decision: "self-halt", detail: reason, awaits_observer: resumeAt === undefined });
  return { ok: false, halt: reason };
}
