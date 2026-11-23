import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  appendDecomposeMetric,
  appendTick,
  appendUnitMetric,
  consecutiveUnitFailures,
  metricsPath,
  spendSince,
  unbilledRoundSpend,
} from "../src/ledger.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-ledger-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("ledgers", () => {
  it("appends ticks and unit metrics; spend counts METRICS only (tick spends duplicate them)", () => {
    const arena = join(tmp, "a1");
    appendTick(arena, { decision: "landed", unit: "wu-a", spend_usd: 1.5 }); // duplicate of the metric below
    appendUnitMetric(arena, {
      unit: "wu-a",
      outcome: "merged",
      time_to_verified_done_s: 300,
      spend_usd: 1.5,
      attempts: 1,
      reworked: false,
    });
    expect(spendSince(arena, "2000-01-01T00:00:00Z")).toBeCloseTo(1.5);
    expect(spendSince(arena, "2999-01-01T00:00:00Z")).toBe(0);
  });

  it("counts consecutive trailing unit failures only", () => {
    const arena = join(tmp, "a2");
    const base = { time_to_verified_done_s: 10, spend_usd: 0.1, attempts: 1, reworked: false } as const;
    appendUnitMetric(arena, { unit: "wu-1", outcome: "failed", ...base });
    appendUnitMetric(arena, { unit: "wu-2", outcome: "merged", ...base });
    appendUnitMetric(arena, { unit: "wu-3", outcome: "failed", ...base });
    appendUnitMetric(arena, { unit: "wu-4", outcome: "failed", ...base });
    expect(consecutiveUnitFailures(arena)).toBe(2);
  });

  it("decompose spend reaches the daily gate and decompose failures reach the failure halt", () => {
    const arena = join(tmp, "a4");
    // The 2026-08-24 truncation loop: repeated $3 decompose failures must not be invisible.
    appendDecomposeMetric(arena, { intent: "in-x", outcome: "failed", spend_usd: 3.07 });
    appendDecomposeMetric(arena, { intent: "in-x", outcome: "failed", spend_usd: 3.05 });
    expect(spendSince(arena, "2000-01-01T00:00:00Z")).toBeCloseTo(6.12);
    expect(consecutiveUnitFailures(arena)).toBe(2);
    // A success resets the trailing count, mixed with unit rows.
    appendDecomposeMetric(arena, { intent: "in-x", outcome: "decomposed", spend_usd: 8 });
    expect(consecutiveUnitFailures(arena)).toBe(0);
    appendUnitMetric(arena, { unit: "wu-1", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 0.1, attempts: 1, reworked: false });
    expect(consecutiveUnitFailures(arena)).toBe(1);
  });

  it("a torn write from a crashed tick does not poison accounting", () => {
    const arena = join(tmp, "a3");
    appendUnitMetric(arena, {
      unit: "wu-a",
      outcome: "merged",
      time_to_verified_done_s: 1,
      spend_usd: 1,
      attempts: 1,
      reworked: false,
    });
    appendFileSync(metricsPath(arena), '{"type":"unit","outcome":"fail'); // torn line, no newline
    expect(spendSince(arena, "2000-01-01T00:00:00Z")).toBe(1);
    expect(consecutiveUnitFailures(arena)).toBe(0);
  });
});

describe("the review-landing path's spend reaches the daily gate", () => {
  const arena = () => mkdtempSync(join(tmpdir(), "doctrine-spend-"));

  it("bills the round aggregate a later tick will settle", () => {
    const a = arena();
    // The shape the review path produces: the tick that judged and opened the PR
    // carries the money, and a LATER tick merges. settleMerge wrote 0 here, so the
    // daily gate — which reads metrics.jsonl alone — saw none of it.
    appendTick(a, { decision: "pr-opened", unit: "wu-a", spend_usd: 12.5, detail: "https://pr/1" });
    appendTick(a, { decision: "pr-opened", unit: "wu-other", spend_usd: 99, detail: "https://pr/2" });
    expect(unbilledRoundSpend(a, "wu-a")).toBeCloseTo(12.5, 5);
    rmSync(a, { recursive: true, force: true });
  });

  it("does not charge component ticks that are already inside the aggregate", () => {
    const a = arena();
    // `pr-opened` is implement + judge + design, and after a review fix the "implement"
    // term IS the fixer's spend. `design-verdict-pass` and `review-fixed` record those
    // same dollars on their own ticks. Summing every spend-bearing tick would charge
    // them twice and halt the loop below its real ceiling.
    appendTick(a, { decision: "design-verdict-pass", unit: "wu-a", spend_usd: 3 });
    appendTick(a, { decision: "pr-opened", unit: "wu-a", spend_usd: 12.5, detail: "https://pr/1" });
    appendTick(a, { decision: "review-fixed", unit: "wu-a", spend_usd: 2, detail: "1 finding addressed" });
    appendTick(a, { decision: "pr-opened", unit: "wu-a", spend_usd: 6, detail: "https://pr/1" });
    // Two rounds: 12.5 and 6. The 3 and the 2 are inside them.
    expect(unbilledRoundSpend(a, "wu-a")).toBeCloseTo(18.5, 5);
    rmSync(a, { recursive: true, force: true });
  });

  it("stops billing a round once a metric has taken it", () => {
    const a = arena();
    appendTick(a, { decision: "pr-opened", unit: "wu-a", spend_usd: 12.5, detail: "https://pr/1" });
    appendUnitMetric(a, { unit: "wu-a", outcome: "merged", time_to_verified_done_s: 1, spend_usd: 12.5, attempts: 1, reworked: false });
    expect(unbilledRoundSpend(a, "wu-a")).toBe(0);
    rmSync(a, { recursive: true, force: true });
  });

  it("bills the review round that answered without changing code", () => {
    // The fixer answers a finding in prose, changes nothing, opens no PR — and the next
    // tick merges the PR already standing. That pass costs real money and reached no
    // aggregate at all: its spend sat in the tick log, which the daily gate does not read.
    const a = arena();
    appendTick(a, { decision: "pr-opened", unit: "wu-b", spend_usd: 10, detail: "https://pr/1" });
    appendTick(a, { decision: "review-fixed", unit: "wu-b", spend_usd: 3, detail: "answered without a code change" });
    expect(unbilledRoundSpend(a, "wu-b")).toBeCloseTo(13, 5);
    rmSync(a, { recursive: true, force: true });
  });

  it("survives a failed re-judge — the round that opened the PR is not lost", () => {
    const a = arena();
    // Round 1 opens a PR for $12.50 and no metric is written. Review finds something,
    // the fixer runs, the re-judge FAILS. That failure's metric must carry the $12.50
    // as well as its own cost, because it advances the cutoff past it.
    appendTick(a, { decision: "pr-opened", unit: "wu-a", spend_usd: 12.5, detail: "https://pr/1" });
    appendTick(a, { decision: "review-fixed", unit: "wu-a", spend_usd: 2, detail: "1 finding addressed" });
    const carried = unbilledRoundSpend(a, "wu-a");
    expect(carried).toBeCloseTo(12.5, 5);
    // dispatch adds `carried` to the failing row, which is what keeps the dollars.
    appendUnitMetric(a, { unit: "wu-a", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 5 + carried, attempts: 1, reworked: true, detail: "code-judge fail: x" });
    // Nothing is left owing, and the next attempt starts from zero rather than
    // re-billing a round someone already paid for.
    expect(unbilledRoundSpend(a, "wu-a")).toBe(0);
    expect(spendSince(a, "1970-01-01T00:00:00.000Z")).toBeCloseTo(17.5, 5);
    rmSync(a, { recursive: true, force: true });
  });

  it("is zero when the unit has opened no PR", () => {
    const a = arena();
    appendTick(a, { decision: "pr-opened", unit: "wu-other", spend_usd: 4 });
    expect(unbilledRoundSpend(a, "wu-a")).toBe(0);
    rmSync(a, { recursive: true, force: true });
  });
});

describe("what an escalation does to the failure streak", () => {
  it("is stepped over, so the failures underneath it still count", () => {
    const a = mkdtempSync(join(tmpdir(), "doctrine-esc-"));
    // Exactly tonight's shape: a unit failed twice and escalated, then another unit
    // failed. The halt must still see three. Before an escalated row was written at all
    // the walk-back passed over the gap and reached these — that accident was
    // load-bearing, and recording the outcome has to preserve it on purpose.
    appendUnitMetric(a, { unit: "wu-a", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 1, attempts: 1, reworked: false, detail: "x" });
    appendUnitMetric(a, { unit: "wu-a", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 1, attempts: 2, reworked: true, detail: "x" });
    appendUnitMetric(a, { unit: "wu-a", outcome: "escalated", time_to_verified_done_s: 1, spend_usd: 0, attempts: 2, reworked: true, detail: "attempts exhausted" });
    appendUnitMetric(a, { unit: "wu-b", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 1, attempts: 1, reworked: false, detail: "x" });
    expect(consecutiveUnitFailures(a)).toBe(3);
    rmSync(a, { recursive: true, force: true });
  });

  it("does not itself count, so running out of attempts does not halt the loop", () => {
    const a = mkdtempSync(join(tmpdir(), "doctrine-esc-"));
    // Two failures and an escalation is a unit that ran out of attempts. The loop is
    // designed to move on — "attempts exhausted: unit escalated, loop moves on" — so this
    // must stay under the three-failure gate.
    appendUnitMetric(a, { unit: "wu-a", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 1, attempts: 1, reworked: false, detail: "x" });
    appendUnitMetric(a, { unit: "wu-a", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 1, attempts: 2, reworked: true, detail: "x" });
    appendUnitMetric(a, { unit: "wu-a", outcome: "escalated", time_to_verified_done_s: 1, spend_usd: 0, attempts: 2, reworked: true, detail: "attempts exhausted" });
    expect(consecutiveUnitFailures(a)).toBe(2);
    rmSync(a, { recursive: true, force: true });
  });

  it("a queue of units that each fail and escalate still reaches the gate", () => {
    const a = mkdtempSync(join(tmpdir(), "doctrine-esc-"));
    // The hole this closes. If an escalation broke the streak, every one of these would
    // clear the count the next unit was rebuilding and the loop would spend indefinitely
    // with the one backstop that watches ACROSS units blind to it.
    for (const u of ["wu-a", "wu-b"]) {
      appendUnitMetric(a, { unit: u, outcome: "failed", time_to_verified_done_s: 1, spend_usd: 1, attempts: 1, reworked: false, detail: "x" });
      appendUnitMetric(a, { unit: u, outcome: "failed", time_to_verified_done_s: 1, spend_usd: 1, attempts: 2, reworked: true, detail: "x" });
      appendUnitMetric(a, { unit: u, outcome: "escalated", time_to_verified_done_s: 1, spend_usd: 0, attempts: 2, reworked: true, detail: "attempts exhausted" });
    }
    expect(consecutiveUnitFailures(a)).toBe(4);
    rmSync(a, { recursive: true, force: true });
  });

  it("a merge still breaks it, because a landed unit is progress", () => {
    const a = mkdtempSync(join(tmpdir(), "doctrine-esc-"));
    appendUnitMetric(a, { unit: "wu-a", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 1, attempts: 1, reworked: false, detail: "x" });
    appendUnitMetric(a, { unit: "wu-b", outcome: "merged", time_to_verified_done_s: 1, spend_usd: 1, attempts: 1, reworked: false });
    appendUnitMetric(a, { unit: "wu-c", outcome: "escalated", time_to_verified_done_s: 1, spend_usd: 0, attempts: 2, reworked: true, detail: "attempts exhausted" });
    appendUnitMetric(a, { unit: "wu-d", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 1, attempts: 1, reworked: false, detail: "x" });
    // The escalation is stepped over; the merge below it stops the walk.
    expect(consecutiveUnitFailures(a)).toBe(1);
    rmSync(a, { recursive: true, force: true });
  });

  it("records the terminal outcome with its reason", () => {
    const a = mkdtempSync(join(tmpdir(), "doctrine-esc-"));
    appendUnitMetric(a, { unit: "wu-a", outcome: "escalated", time_to_verified_done_s: 1, spend_usd: 0, attempts: 2, reworked: true, detail: "attempts exhausted (2 of 4 recorded a reason)" });
    const rows = readFileSync(metricsPath(a), "utf8").trim().split("\n").map((l: string) => JSON.parse(l) as Record<string, unknown>);
    expect(rows[0]!["outcome"]).toBe("escalated");
    expect(String(rows[0]!["detail"])).toContain("attempts exhausted");
    rmSync(a, { recursive: true, force: true });
  });
});
