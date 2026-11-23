import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The two ledgers. jsonl, append-only, in the target's .doctrine/ —
 * `jq` is the dashboard. Everything the observer reads lives here.
 */

export interface TickRecord {
  decision: string;
  unit?: string;
  outcome?: string;
  spend_usd?: number;
  detail?: string;
  /**
   * This halt can only be ended by a person — it carries no expiry.
   *
   * The distinction is load-bearing, not descriptive: a halt is treated as ANSWERED
   * once the loop is running again, and that inference is only sound for a pause a
   * human had to remove. The daily spend gate's pause clears itself at midnight, so
   * without this flag a clock would have counted as an acknowledgement and quietly
   * reset the failure counter — the one backstop that catches interleaved failures,
   * disarmed by the passage of time.
   */
  awaits_observer?: boolean;
  /**
   * The branch tip a review fix was measured from, carried on the `review-fixed` tick.
   *
   * A re-judge can land on a LATER tick in a LATER process — an outage during the first
   * one is exactly how — and the review-fix guardrail is the delta from this sha. Held
   * only in memory it is gone by then, and the retry would judge the amendment with the
   * guardrail silently skipped.
   */
  pre_fix_sha?: string;
  /**
   * The verbatim, untruncated reasons behind this decision.
   *
   * `detail` is a summary — it is what a human and a monitor read, and it is clipped
   * to stay legible. That clip is fine for a person and fatal for a retry: the program
   * rung feeds a rejection back to the next attempt, and reading it out of `detail`
   * handed the planner one objection out of four, cut mid-sentence. It duly fixed the
   * one it could see and tripped over the three it could not, twice, at ~$9 a go.
   * Anything a later tick must REASON about lives here, in full.
   */
  problems?: string[];
  at: string;
}

export interface UnitMetric {
  type: "unit";
  unit: string;
  outcome: "merged" | "failed" | "escalated";
  time_to_verified_done_s: number;
  spend_usd: number;
  attempts: number;
  reworked: boolean;
  /**
   * Why it failed, in the reader's own words — the judge's findings, the spawn failure.
   *
   * `failedAttempts` already read `r["detail"]` here and there was never such a field,
   * so every summary it produced was the literal fallback "failed attempt". Nothing
   * noticed, because nothing consumed the summaries: they were computed for the attempt
   * COUNT and dropped. A retry therefore learned nothing from its predecessor, which
   * made two attempts at a unit two independent re-rolls of one spec rather than a
   * second try at the problem.
   */
  detail?: string;
  /**
   * The INSTRUMENT failed, not the unit — a malformed verdict, a judge that could not run, a
   * screens command that rendered nothing. The row is kept, because the money was spent and the
   * daily gate has to see it, and the detail is kept because it is how the fault gets diagnosed.
   * What it must not do is spend the unit's retry budget or reach the next attempt as feedback:
   * "verdict cites screens that were not rendered" tells an implementer nothing about its own
   * work, and charging it for that is charging it for our bug.
   *
   * u-2026-09-05-invoice-review escalated on 2026-09-07 with exactly one real attempt, because a
   * design-judge malformed-verdict had taken the other.
   */
  instrument?: boolean;
  at: string;
}

function appendJsonl(path: string, record: Record<string, unknown>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

export function ticksPath(arenaDir: string): string {
  return join(arenaDir, ".doctrine", "ticks.jsonl");
}

export function metricsPath(arenaDir: string): string {
  return join(arenaDir, ".doctrine", "metrics.jsonl");
}

export function appendTick(arenaDir: string, record: Omit<TickRecord, "at">): TickRecord {
  const full: TickRecord = { ...record, at: new Date().toISOString() };
  mkdirSync(join(arenaDir, ".doctrine"), { recursive: true });
  appendJsonl(ticksPath(arenaDir), full as unknown as Record<string, unknown>);
  return full;
}

export function appendUnitMetric(arenaDir: string, record: Omit<UnitMetric, "at" | "type">): UnitMetric {
  const full: UnitMetric = { type: "unit", ...record, at: new Date().toISOString() };
  mkdirSync(join(arenaDir, ".doctrine"), { recursive: true });
  appendJsonl(metricsPath(arenaDir), full as unknown as Record<string, unknown>);
  return full;
}

export interface DecomposeMetric {
  type: "decompose";
  intent: string;
  outcome: "decomposed" | "empty" | "failed";
  spend_usd: number;
  at: string;
}

/** Decompose ACTs are paid work: their spend must reach the daily gate and their
 *  failures must reach the failure halt (a $3 truncation loop discovered 2026-08-24
 *  was invisible to both). */
export function appendDecomposeMetric(arenaDir: string, record: Omit<DecomposeMetric, "at" | "type">): DecomposeMetric {
  const full: DecomposeMetric = { type: "decompose", ...record, at: new Date().toISOString() };
  mkdirSync(join(arenaDir, ".doctrine"), { recursive: true });
  appendJsonl(metricsPath(arenaDir), full as unknown as Record<string, unknown>);
  return full;
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // a torn write from a crashed tick must not poison budget accounting
    }
  }
  return out;
}

/**
 * What this unit has spent that no metric row has billed yet.
 *
 * The daily gate reads metrics.jsonl only, and that is right — spend appears on tick
 * records too, and counting both would trip the gate at half its ceiling. The invariant
 * it rests on is that the unit metric carries the money.
 *
 * The review-landing path broke that invariant. It settles on a LATER tick than the one
 * that paid: the implementer ran, the judge ran, the PR opened, and the spend went onto
 * that tick — then a later tick merges and `settleMerge` wrote `spend_usd: 0`. So on the
 * two targets that use review landing, the whole cost of every unit that PASSED was
 * invisible to the gate. Measured on a target: $34.52 seen, $67.50 spent.
 *
 * Only `pr-opened` is summed, and that is the load-bearing detail. It is the ROUND
 * AGGREGATE — `implementSpendUsd + judge + design`, where after a review fix the
 * "implement" term is the fixer's spend. The component ticks beside it
 * (`design-verdict-pass`, `review-fixed`) are already inside that figure, so summing
 * every spend-bearing tick would charge those twice and halt the loop below its real
 * ceiling.
 *
 * Re-derived rather than carried in a field, because the paying tick and the settling
 * tick are different processes and the loop holds no state between them (D6).
 *
 * "Since the last metric" is the window, and it only holds because every failure path
 * downstream of a `pr-opened` adds this figure to its own row. Without that, a review
 * fix whose re-judge failed would write a metric covering only the fixer and judge,
 * advance the cutoff past the round that opened the PR, and lose that round's cost for
 * good — the gate staying blind in precisely the case where reviewed work needs a retry.
 */
export function unbilledRoundSpend(arenaDir: string, unitId: string): number {
  let since = "";
  for (const r of readJsonl(metricsPath(arenaDir))) {
    if (r["type"] === "unit" && r["unit"] === unitId && typeof r["at"] === "string") since = r["at"];
  }
  // `pr-opened` carries the whole round's spend, and a review fix that CHANGED code is
  // already inside it — `handleReview` passes that pass's cost into `judgeAndLand`, which
  // bills it on the resulting metric. Adding every `review-fixed` here would charge it
  // twice.
  //
  // The gap is one specific round: a fixer that answers a finding WITHOUT changing code
  // returns immediately, opens no PR, and the next tick merges what is already there. Its
  // cost is written to that tick and read by nothing — real money invisible to the daily
  // gate, which reads `metrics.jsonl` and not the tick log.
  //
  // The two are told apart by the detail the engine itself writes, the same discriminator
  // used for instrument rows: only the no-change pass says so in those words.
  const NO_CHANGE = "answered without a code change";
  let total = 0;
  for (const r of readJsonl(ticksPath(arenaDir))) {
    if (r["unit"] !== unitId) continue;
    if (typeof r["at"] !== "string" || r["at"] <= since) continue;
    const billable = r["decision"] === "pr-opened"
      || (r["decision"] === "review-fixed" && String(r["detail"] ?? "") === NO_CHANGE);
    if (!billable) continue;
    if (typeof r["spend_usd"] === "number") total += r["spend_usd"];
  }
  return total;
}

/** Total recorded spend at or after `sinceIso` — the daily-budget read-back.
 *  Reads metrics.jsonl ONLY: a landed unit's spend also appears on its tick record,
 *  and counting both would trip the daily gate at half its intended ceiling. */
export function spendSince(arenaDir: string, sinceIso: string): number {
  let total = 0;
  for (const r of readJsonl(metricsPath(arenaDir))) {
    if (typeof r["at"] === "string" && r["at"] >= sinceIso && typeof r["spend_usd"] === "number") {
      total += r["spend_usd"];
    }
  }
  return total;
}

/** Consecutive trailing failed outcomes across unit AND decompose metrics — feeds the
 *  failure halt. A decompose that fails every tick is exactly the "systematically
 *  wrong" state the halt exists for. Outage ticks (decision "no-op-outage") are
 *  invisible to this count by construction: they are tick records, not metrics. */
/**
 * How many failures in a row stand UNANSWERED.
 *
 * Counting from the end of an append-only ledger made the failure halt a one-way
 * door. The halt writes a pause with no `resume_at`, so only an observer can end it —
 * but the three rows that caused it are still the last three rows, so the very next
 * tick counted three again and wrote the pause straight back. The observer's only way
 * out was to edit the ledger, which is the one thing an audit log must never need.
 *
 * So: failures are counted since the last halt, because reaching this function at all
 * proves that halt was answered. A failure halt's pause carries no expiry and the
 * steering check runs first — if the loop is executing, a person removed that file
 * deliberately. That is the acknowledgement, and no new row has to record it.
 */
export function consecutiveUnitFailures(arenaDir: string): number {
  const rows = readJsonl(metricsPath(arenaDir)).filter(
    (r) => r["type"] === "unit" || r["type"] === "decompose",
  );
  const since = lastHaltAt(arenaDir);
  let n = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const at = String(rows[i]!["at"] ?? "");
    if (since !== undefined && at !== "" && at <= since) break;
    // Three outcomes, three different things to do, and the middle one is the whole point.
    //
    // `failed` counts. `merged` breaks the streak, because a landed unit is progress and
    // whatever went wrong before it is behind us. `escalated` does NEITHER: it is stepped
    // over, leaving the streak to run through it to the failures underneath.
    //
    // Skipping is not a nicety. Counting it halts the loop after every unit that runs out
    // of attempts — `failed + failed + escalated` is three — which turns the designed
    // escalate-and-move-on into escalate-and-stop. Breaking on it erases the cross-unit
    // failure state entirely: each escalation would clear the count the next unit's
    // failures are rebuilding, so a target whose units all fail and escalate in turn would
    // never reach this gate at all, and would keep spending until some other one caught it.
    //
    // Before an escalated row was written at all, the walk-back passed over the gap and
    // reached those earlier failures. That accident was load-bearing, and recording the
    // terminal outcome has to preserve it deliberately.
    const outcome = rows[i]!["outcome"];
    if (outcome === "failed") n++;
    else if (outcome !== "escalated") break;
  }
  return n;
}

/**
 * When the loop last halted in a way only a person could end. ISO strings, so string
 * order is time order.
 *
 * A timed halt — the daily spend gate, which writes `resume_at` and clears itself at
 * midnight — is deliberately NOT one of these. Counting it would let two failures, a
 * spend cap and a sunrise reset the anti-spin backstop with nobody having looked.
 *
 * Rows written before the flag existed are read as observer-answered. They are almost
 * all failure halts, the allowance is bounded to a ledger's existing tail, and the
 * alternative leaves the very loops this fix unwedges still wedged.
 */
function lastHaltAt(arenaDir: string): string | undefined {
  const rows = readJsonl(ticksPath(arenaDir));
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!["decision"] !== "self-halt") continue;
    if (rows[i]!["awaits_observer"] === false) continue; // timed: a clock is not an answer
    const at = String(rows[i]!["at"] ?? "");
    return at.length > 0 ? at : undefined;
  }
  return undefined;
}
