import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acquireLease, leaseDir, LEASE_STALE_S } from "../src/lease.js";
import { pausePath, readSteering } from "../src/steering.js";
import { checkBudgets } from "../src/budget.js";
import { appendUnitMetric } from "../src/ledger.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-lsb-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const arena = (): string => join(tmp, `arena-${n++}`);

describe("lease (WIP=1)", () => {
  it("acquires, blocks a second acquirer, releases", () => {
    const a = arena();
    const first = acquireLease(a);
    expect(first.acquired).toBe(true);
    expect(acquireLease(a).acquired).toBe(false);
    first.release();
    expect(acquireLease(a).acquired).toBe(true);
  });

  it("breaks a stale lease — age is the only honest signal after SIGKILL", () => {
    const a = arena();
    expect(acquireLease(a).acquired).toBe(true);
    // Backdate the lease dir past the staleness window.
    const old = (Date.now() - (LEASE_STALE_S + 60) * 1000) / 1000;
    utimesSync(leaseDir(a), old, old);
    expect(acquireLease(a).acquired).toBe(true);
  });
});

describe("steering", () => {
  it("silence means proceed", () => {
    const a = arena();
    mkdirSync(join(a, ".doctrine"), { recursive: true });
    const s = readSteering(a);
    expect(s.paused).toBe(false);
    expect(s.veto).toEqual([]);
    expect(s.intakeMode).toBe("auto");
  });

  it("reads pause + directives", () => {
    const a = arena();
    mkdirSync(join(a, ".doctrine"), { recursive: true });
    writeFileSync(pausePath(a), "observer: hold while I look at wu-x\n");
    writeFileSync(
      join(a, ".doctrine", "directives.md"),
      `---\nveto: [wu-bad]\npriority: [wu-urgent]\nintake_mode: manual\n---\nNotes for humans.\n`,
    );
    const s = readSteering(a);
    expect(s.paused).toBe(true);
    expect(s.pauseReason).toContain("wu-x");
    expect(s.veto).toEqual(["wu-bad"]);
    expect(s.priority).toEqual(["wu-urgent"]);
    expect(s.intakeMode).toBe("manual");
  });

  it("unparseable directives fail SAFE (treated as paused), never silently ignored", () => {
    const a = arena();
    mkdirSync(join(a, ".doctrine"), { recursive: true });
    writeFileSync(join(a, ".doctrine", "directives.md"), "---\nveto: [unclosed\n---\n");
    const s = readSteering(a);
    expect(s.paused).toBe(true);
    expect(s.pauseReason).toContain("unparseable");
  });
});

describe("budgets (spend gates before spend)", () => {
  const cfg = { attemptsPerUnit: 2, dailySpendUsd: 5, consecutiveFailuresHalt: 3 };
  const base = { time_to_verified_done_s: 10, spend_usd: 0, attempts: 1, reworked: false } as const;

  it("passes under the gates", () => {
    const a = arena();
    expect(checkBudgets(a, cfg)).toEqual({ ok: true });
  });

  it("daily spend gate halts and writes the pause file itself", () => {
    const a = arena();
    appendUnitMetric(a, { unit: "wu-1", outcome: "merged", ...base, spend_usd: 6 });
    const res = checkBudgets(a, cfg);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.halt).toContain("daily spend gate");
    expect(existsSync(pausePath(a))).toBe(true);
  });

  it("failure halt trips on consecutive failures", () => {
    const a = arena();
    for (const u of ["wu-1", "wu-2", "wu-3"]) {
      appendUnitMetric(a, { unit: u, outcome: "failed", ...base });
    }
    const res = checkBudgets(a, cfg);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.halt).toContain("failure halt");
    expect(existsSync(pausePath(a))).toBe(true);
  });

  it("a halt the observer answered is not counted again — the door opens both ways", () => {
    // The three rows that caused a halt stay the last three rows forever, so counting
    // from the end of the ledger re-halted on the very next tick and the observer's
    // only way out was to edit the audit log. Reaching this function proves the halt
    // was answered: its pause carries no expiry, steering is checked first, so a person
    // removed that file on purpose.
    const a = arena();
    for (const u of ["wu-1", "wu-2", "wu-3"]) {
      appendUnitMetric(a, { unit: u, outcome: "failed", ...base });
    }
    expect(checkBudgets(a, cfg).ok).toBe(false);
    rmSync(pausePath(a), { force: true }); // the observer, having fixed the cause

    expect(checkBudgets(a, cfg)).toEqual({ ok: true });
    expect(existsSync(pausePath(a))).toBe(false);

    // And it still halts on three NEW failures, so the backstop is not disarmed.
    for (const u of ["wu-4", "wu-5", "wu-6"]) {
      appendUnitMetric(a, { unit: u, outcome: "failed", ...base });
    }
    const again = checkBudgets(a, cfg);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.halt).toContain("failure halt");
  });

  it("a halt that a CLOCK ended is not an answer — the spend gate cannot disarm the backstop", () => {
    // The daily spend pause carries resume_at and clears itself at midnight, with no
    // observer involved. Treating every self-halt as acknowledged would mean two
    // failures, a spend cap and a sunrise silently reset the one backstop that catches
    // interleaved failures.
    const a = arena();
    appendUnitMetric(a, { unit: "wu-1", outcome: "failed", ...base });
    appendUnitMetric(a, { unit: "wu-2", outcome: "failed", ...base, spend_usd: 6 });
    const spend = checkBudgets(a, cfg);
    expect(spend.ok).toBe(false);
    if (spend.ok) return;
    expect(spend.halt).toContain("daily spend gate");
    rmSync(pausePath(a), { force: true }); // as clearExpiredPause does, on a timer

    // Tomorrow: the spend window has rolled over, so the spend gate is satisfied and
    // the failure gate is the one that speaks. The third failure must be the third.
    const tomorrow = Date.now() + 36 * 60 * 60_000;
    appendUnitMetric(a, { unit: "wu-3", outcome: "failed", ...base });
    const res = checkBudgets(a, cfg, tomorrow);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.halt).toContain("failure halt");
  });
});
