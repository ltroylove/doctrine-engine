import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { engineStateTampering, restoreEngineState, snapshotEngineState } from "../src/engine-state.js";

const LF = String.fromCharCode(10);
const tmp = mkdtempSync(join(tmpdir(), "doctrine-es-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function arena(): string {
  const dir = join(tmp, `a-${n++}`);
  mkdirSync(join(dir, ".doctrine"), { recursive: true });
  writeFileSync(join(dir, ".doctrine", "manifest.json"), "{}" + LF);
  writeFileSync(join(dir, ".doctrine", "ticks.jsonl"), "{}" + LF);
  return dir;
}
const pause = (dir: string): string => join(dir, ".doctrine", "pause");

describe("the observer's pause is guarded in one direction only", () => {
  it("a pause that APPEARS during an ACT is the observer, not tampering", () => {
    // Measured on a target: the observer paused mid-ACT, the running gap
    // decompose was failed for "modifying engine-owned state", and $2.13 was thrown away.
    // The permission layer already denies every ACT a write to this file, so a new pause can
    // only be the person stopping the loop.
    const dir = arena();
    const before = snapshotEngineState(dir);
    writeFileSync(pause(dir), "observer pause: restarting onto a fix" + LF);
    expect(engineStateTampering(dir, before)).toEqual([]);
  });

  it("the restore never deletes a pause the snapshot did not have", () => {
    // The worse half of the same incident: restoring "what was there before" DELETED the pause,
    // the loop did not stop, and it started the next paid ACT. Even when something else WAS
    // tampered with, the observer's stop must survive the restore.
    const dir = arena();
    const before = snapshotEngineState(dir);
    writeFileSync(pause(dir), "observer pause" + LF);
    writeFileSync(join(dir, ".doctrine", "manifest.json"), JSON.stringify({ budgets: { dailySpendUsd: 99999 } }));
    expect(engineStateTampering(dir, before)).toEqual([".doctrine/manifest.json"]);
    restoreEngineState(dir, before);
    expect(readFileSync(join(dir, ".doctrine", "manifest.json"), "utf8")).toBe("{}" + LF);
    expect(existsSync(pause(dir)), "the loop must still stop").toBe(true);
  });

  it("a pause that DISAPPEARS during an ACT is still tampering, and comes back", () => {
    // The direction the guard exists for: an ACT un-halting the loop.
    const dir = arena();
    writeFileSync(pause(dir), "halted: three consecutive failures" + LF);
    const before = snapshotEngineState(dir);
    rmSync(pause(dir));
    expect(engineStateTampering(dir, before)).toEqual([".doctrine/pause"]);
    restoreEngineState(dir, before);
    expect(readFileSync(pause(dir), "utf8")).toContain("halted");
  });

  it("a pause that CHANGES during an ACT is still tampering — a weakened pause un-halts", () => {
    // Adding a `resume_at` turns a STOP into a WAIT. Indistinguishable from the observer editing
    // mid-ACT, so it errs toward staying halted: the prior pause is restored, and still stops.
    const dir = arena();
    writeFileSync(pause(dir), "halted" + LF);
    const before = snapshotEngineState(dir);
    writeFileSync(pause(dir), "resume_at: 2026-01-01T00:00:00Z" + LF);
    expect(engineStateTampering(dir, before)).toEqual([".doctrine/pause"]);
    restoreEngineState(dir, before);
    expect(readFileSync(pause(dir), "utf8")).toBe("halted" + LF);
  });
});

describe("only a regular FILE at the pause path is the observer's (PR #98 review, round two)", () => {
  it("a directory an ACT creates there is tampering, and is removed", () => {
    // The file-shaped deny rule matches `.doctrine/pause`, not `.doctrine/pause/child`. Kept, a
    // directory at the pause path makes every later tick throw reading it as the pause.
    const dir = arena();
    const before = snapshotEngineState(dir);
    mkdirSync(pause(dir), { recursive: true });
    writeFileSync(join(pause(dir), "child"), "not a pause" + LF);
    expect(engineStateTampering(dir, before)).toEqual([".doctrine/pause/child"]);
    restoreEngineState(dir, before);
    expect(existsSync(pause(dir)), "no directory left where the pause is read").toBe(false);
  });
});
