import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as dispatch from "../src/dispatch.js";
import { supervise } from "../src/supervisor.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-supervisor-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function arena(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, ".doctrine"), { recursive: true });
  writeFileSync(join(dir, ".doctrine", "manifest.json"), JSON.stringify({ name: "t" }));
  return dir;
}

const deps = (dir: string): dispatch.TickDeps => ({
  arenaDir: dir,
  agentDefs: { implementer: "i", judge: "j", decomposer: "d", planJudge: "p" },
});

/**
 * The loop's whole purpose is to keep working with nobody watching it. An unhandled
 * throw out of one tick ended the entire run, which made "the supervisor is dead"
 * look exactly like "there is nothing left to do" — it happened twice in one day, once
 * from a `git commit` with an empty index, and both times the run sat silently stopped
 * until a person noticed.
 */
describe("supervisor — a bad tick is a tick, not the end of the run", () => {
  it("records a throwing tick, backs off, and keeps going", async () => {
    const dir = arena("recovers");
    let calls = 0;
    const spy = vi.spyOn(dispatch, "tick").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("git commit failed: nothing to commit\nsecond line dropped");
      return { decision: "idle" };
    });

    const results = await supervise(deps(dir), { maxTicks: 3, idleSleepMs: 1, activeSleepMs: 1 });
    spy.mockRestore();

    expect(results.map((r) => r.decision)).toEqual(["tick-threw", "idle", "idle"]);
    expect(results[0]?.detail).toContain("nothing to commit");
    expect(results[0]?.detail).not.toContain("second line"); // one line, not a stack
    // ...and it is in the ledger, so the failure is visible after the fact.
    expect(readFileSync(join(dir, ".doctrine", "ticks.jsonl"), "utf8")).toContain("tick-threw");
  });

  it("a run of consecutive throws stops loudly rather than spinning forever", async () => {
    const dir = arena("gives-up");
    const spy = vi.spyOn(dispatch, "tick").mockImplementation(async () => {
      throw new Error("the arena is gone");
    });

    // It must THROW, not resolve. Resolving normally made loop-cli print "supervisor
    // stopped" and exit 0 — a broken arena reported as a clean shutdown, which is the
    // silent death this whole change exists to prevent (doctrine#12 review).
    await expect(supervise(deps(dir), { maxTicks: 20, idleSleepMs: 1, maxConsecutiveErrors: 3 }))
      .rejects.toThrow(/3 consecutive throwing ticks/);
    spy.mockRestore();

    // ...and it leaves the durable halt every other self-halt in the engine writes, so
    // the next tick refuses to start and the reason survives the process.
    expect(readFileSync(join(dir, ".doctrine", "pause"), "utf8")).toContain("the arena is gone");
    // Three, not twenty: a loop that cannot make progress must not burn the night.
    expect(readFileSync(join(dir, ".doctrine", "ticks.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("the error counter resets on a good tick, so intermittent faults do not accumulate", async () => {
    const dir = arena("resets");
    let calls = 0;
    const spy = vi.spyOn(dispatch, "tick").mockImplementation(async () => {
      calls += 1;
      if (calls % 2 === 1) throw new Error("flaky");
      return { decision: "idle" };
    });

    const results = await supervise(deps(dir), { maxTicks: 6, idleSleepMs: 1, activeSleepMs: 1, maxConsecutiveErrors: 3 });
    spy.mockRestore();

    // Alternating fail/succeed never reaches three in a row, so all six ticks run.
    expect(results).toHaveLength(6);
    expect(results.filter((r) => r.decision === "tick-threw")).toHaveLength(3);
  });
});

/**
 * Every stop the loop can make is either a reason to WAIT or a reason to STOP, and the
 * pause file says which. Getting that wrong in the safe-looking direction is what made
 * the daily spend gate — the most routine halt in the system — need a human to end it.
 */
describe("stopping vs waiting — only a person ends a pause that has no window", () => {
  it("waits out a pause that carries resume_at, and resumes itself", async () => {
    const dir = arena("waits");
    const spy = vi.spyOn(dispatch, "tick").mockImplementation(async () => ({ decision: "idle" }));
    // Already expired: the loop must clear it and keep ticking rather than exit.
    writeFileSync(join(dir, ".doctrine", "pause"),
      `daily spend gate\nresume_at: ${new Date(Date.now() - 1000).toISOString()}\n`);

    const results = await supervise(deps(dir), { maxTicks: 3, idleSleepMs: 1, activeSleepMs: 1 });
    spy.mockRestore();

    expect(results).toHaveLength(3);
    expect(existsSync(join(dir, ".doctrine", "pause"))).toBe(false);
  });

  it("stops on a pause with no window — that is the observer, or something systematic", async () => {
    const dir = arena("stops");
    const spy = vi.spyOn(dispatch, "tick").mockImplementation(async () => ({ decision: "idle" }));
    writeFileSync(join(dir, ".doctrine", "pause"), "observer: hold everything\n");

    const results = await supervise(deps(dir), { maxTicks: 5, idleSleepMs: 1 });
    spy.mockRestore();

    expect(results).toHaveLength(1); // one tick, then out
    expect(existsSync(join(dir, ".doctrine", "pause"))).toBe(true); // and it is NOT cleared
  });

  it("a future window is a wait, not a stop: the process stays alive", async () => {
    const dir = arena("future");
    const spy = vi.spyOn(dispatch, "tick").mockImplementation(async () => ({ decision: "idle" }));
    writeFileSync(join(dir, ".doctrine", "pause"),
      `daily spend gate\nresume_at: ${new Date(Date.now() + 50).toISOString()}\n`);

    const seen: string[] = [];
    const results = await supervise(deps(dir), {
      maxTicks: 4, idleSleepMs: 20, activeSleepMs: 20,
      onTick: (r) => seen.push(r.decision),
    });
    spy.mockRestore();

    // It reported waiting rather than ending, and carried on once the window passed.
    expect(seen).toContain("waiting");
    expect(results.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, ".doctrine", "pause"))).toBe(false);
  });
  it("an observer pause written during the wait is never unlinked by the expiry", async () => {
    // The race review named: the loop reads an expired timed pause, and before it acts
    // the observer replaces the file with a permanent hold. Unlinking blindly there
    // deletes the human veto and lets the tick proceed into paid work.
    const dir = arena("race");
    const spy = vi.spyOn(dispatch, "tick").mockImplementation(async () => ({ decision: "idle" }));
    const timed = `daily spend gate\nresume_at: ${new Date(Date.now() + 30).toISOString()}\n`;
    writeFileSync(join(dir, ".doctrine", "pause"), timed);

    // Swap in a permanent observer pause while the supervisor is sitting out the window.
    setTimeout(() => writeFileSync(join(dir, ".doctrine", "pause"), "observer: stop now\n"), 45);

    await supervise(deps(dir), { maxTicks: 6, idleSleepMs: 15, activeSleepMs: 15 });
    spy.mockRestore();

    // The observer's file survives, and the loop stopped on it rather than clearing it.
    expect(existsSync(join(dir, ".doctrine", "pause"))).toBe(true);
    expect(readFileSync(join(dir, ".doctrine", "pause"), "utf8")).toContain("observer: stop now");
  });
});
