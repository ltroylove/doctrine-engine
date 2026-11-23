import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tick, type TickDeps, type TickResult } from "./dispatch.js";
import { appendTick } from "./ledger.js";
import { dirname } from "node:path";
import { clearExpiredPause, pausePath, pauseResumeAt } from "./steering.js";

/**
 * The only stateful thing in the system: an infinite tick loop with two sleep
 * cadences. Every tick is a fresh, stateless pass.
 */

export interface SuperviseOptions {
  activeSleepMs?: number;
  idleSleepMs?: number;
  /** Test/ceiling knob: stop after N ticks. */
  maxTicks?: number;
  /** Consecutive throwing ticks before the loop gives up. Default 3. */
  maxConsecutiveErrors?: number;
  onTick?: (result: TickResult) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Write the pause file, the same durable halt every other self-halt in the engine uses. */
function haltLoudly(arenaDir: string, reason: string): void {
  try {
    const path = pausePath(arenaDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${reason}
`);
  } catch { /* if even the pause file cannot be written, the throw is the only channel left */ }
}

export async function supervise(deps: TickDeps, opts: SuperviseOptions = {}): Promise<TickResult[]> {
  const active = opts.activeSleepMs ?? 120_000;
  const idle = opts.idleSleepMs ?? 180_000;
  const maxErrors = opts.maxConsecutiveErrors ?? 3;
  const results: TickResult[] = [];
  let consecutiveErrors = 0;

  for (let i = 0; opts.maxTicks === undefined || i < opts.maxTicks; i++) {
    let result: TickResult;
    try {
      result = await tick(deps);
      consecutiveErrors = 0;
    } catch (e) {
      // A tick that throws must not end the run. The loop exists to keep working
      // without anyone watching it, and an unhandled throw made "the supervisor is
      // dead" indistinguishable from "there is nothing to do" — twice in one day, once
      // from a git commit with an empty index. The throw is recorded as a tick, the
      // loop backs off, and it gives up only if it cannot make progress at all.
      consecutiveErrors += 1;
      const detail = (e instanceof Error ? e.message : String(e)).split(/\r?\n/)[0]!.slice(0, 300);
      result = { decision: "tick-threw", detail: `${detail} (${consecutiveErrors}/${maxErrors})` };
      try { appendTick(deps.arenaDir, { decision: "tick-threw", detail: result.detail ?? "" }); } catch { /* ledger unwritable too */ }
      results.push(result);
      opts.onTick?.(result);
      if (consecutiveErrors >= maxErrors) {
        // Stopping loudly means the process says so. Breaking here and resolving
        // normally made loop-cli print "supervisor stopped" and exit 0 — a broken
        // arena reported as a clean shutdown, which is the silent death this whole
        // change exists to prevent, reintroduced two lines from the fix for it.
        // Two channels, because either one alone can be missed: the pause file, which
        // is durable and is what every other self-halt in the engine writes, and a
        // throw, which the CLI turns into a nonzero exit.
        haltLoudly(deps.arenaDir, `supervisor halted: ${maxErrors} consecutive throwing ticks; last was ${detail}`);
        throw new Error(`supervisor halted after ${maxErrors} consecutive throwing ticks; last: ${detail}`);
      }
      if (opts.maxTicks !== undefined && i + 1 >= opts.maxTicks) break;
      await sleep(idle);
      continue;
    }
    results.push(result);
    opts.onTick?.(result);

    // A pause is either a reason to WAIT or a reason to STOP, and the file says which.
    // One carrying `resume_at` is a window the loop sits out — the daily spend gate is
    // the only one today — and the process stays alive to resume itself. One without is
    // the observer, or a systematic failure, and only a person ends it.
    //
    // This distinction is the whole difference between a loop that runs unattended and
    // one that runs until the first budget day ends. Before it, "pausing until
    // tomorrow" meant "pausing until someone deletes a file", and the most routine stop
    // in the system was the one that needed a human.
    if (existsSync(pausePath(deps.arenaDir))) {
      const rawPause = readFileSync(pausePath(deps.arenaDir), "utf8");
      const resumeAt = pauseResumeAt(rawPause);
      if (resumeAt === null) break;
      const waitMs = resumeAt.getTime() - Date.now();
      if (waitMs > 0) {
        opts.onTick?.({ decision: "waiting", detail: `until ${resumeAt.toISOString()}` });
        await sleep(Math.min(waitMs, idle)); // wake early enough to notice an observer pause
        continue;
      }
      // The window has passed. Clear it here rather than leaving it for the next tick's
      // readSteering: the loop that decided to carry on should remove the reason it was
      // waiting, and a stale pause on disk misleads anyone reading the arena.
      //
      // Only if it is still the same file. The observer can replace a pause at any
      // instant, including during the wait — and unlinking a permanent hold written
      // seconds ago, then proceeding into paid work, is the worst thing this branch
      // could do. If the bytes changed, whatever replaced them is newer and wins.
      if (!clearExpiredPause(deps.arenaDir, rawPause)) break;
    }
    const acted = result.decision === "landed" || result.decision.startsWith("decompose") || result.decision.startsWith("intent-graded");
    if (opts.maxTicks !== undefined && i + 1 >= opts.maxTicks) break;
    await sleep(acted ? active : idle);
  }
  return results;
}
