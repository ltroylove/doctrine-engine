import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { ENGINE_OWNED_STATE } from "./guardrails.js";

/**
 * Engine-owned state under `.doctrine/`, defended on the rungs the diff guardrail
 * cannot reach.
 *
 * `guardrails.ts` checks implementer and review-fix branches. The decompose and program
 * ACTs are not branch-based, and both deliberately skip `.doctrine/` when deciding what
 * an ACT touched and what to revert — they treat that tree as runtime state an ACT
 * could not have caused. An ACT holding the `Write` tool breaks that assumption, and
 * the consequences are quiet rather than loud: an edited `objections.md` softens the
 * case the next attempt must answer, and an `intents-settled.json` pre-set to the
 * current HEAD marks other intents as already answered, so they are never asked again.
 * Neither produces a rejected diff. Neither looks like anything.
 *
 * The comparison is against a SNAPSHOT taken before the ACT ran, not against the last
 * commit. Scheduler state is written by the engine between commits and is legitimately
 * dirty — comparing to HEAD accused the engine of its own bookkeeping and failed the
 * tick after every settle. The only question being asked is "did the ACT change this",
 * and a before/after pair is the honest way to ask it.
 *
 * The snapshot holds CONTENTS, not digests, so restoring is exact for a file that was
 * never committed. These are a few small JSON and Markdown files for one tick.
 */

export type EngineStateSnapshot = ReadonlyMap<string, Buffer>;

/**
 * The observer's stop channel. Guarded, and guarded in ONE direction only.
 *
 * It is engine-owned so that an ACT cannot delete the pause that halted the loop. But a
 * pause that APPEARS while an ACT runs is not the ACT: the permission layer already denies
 * every ACT a write to this file (`GUARDED_FILES`), so a new pause can only be the observer
 * stopping the loop — the exact thing the file exists for.
 *
 * Read as tampering, it did the worst thing available, measured on a target:
 * an observer paused the loop mid-ACT to restart it onto a fix; the running gap decompose was
 * failed for "modifying engine-owned state" ($2.13 thrown away), and the restore then DELETED
 * the pause — so the loop did not stop, and started the next paid ACT. The one instruction
 * that must never be a tick late was silently undone.
 *
 * So appearing is honoured and never reverted. Disappearing or changing is still tampering
 * and is restored — which, if an observer happens to UNpause mid-ACT, errs toward staying
 * halted. That is the safe direction, and the only one that cannot be told apart from an ACT.
 */
const OBSERVER_PAUSE = ".doctrine/pause";

function walk(root: string, out: string[]): void {
  if (!existsSync(root)) return;
  if (!statSync(root).isDirectory()) {
    out.push(root);
    return;
  }
  for (const entry of readdirSync(root)) walk(join(root, entry), out);
}

export function snapshotEngineState(arenaDir: string): EngineStateSnapshot {
  const snap = new Map<string, Buffer>();
  for (const guarded of ENGINE_OWNED_STATE) {
    const files: string[] = [];
    walk(join(arenaDir, guarded.replace(/\/$/, "")), files);
    for (const abs of files) {
      snap.set(relative(arenaDir, abs).replaceAll("\\", "/"), readFileSync(abs));
    }
  }
  return snap;
}

/** Which guarded paths the ACT changed, added or removed since the snapshot. */
export function engineStateTampering(arenaDir: string, before: EngineStateSnapshot): string[] {
  const after = snapshotEngineState(arenaDir);
  const touched = new Set<string>();
  for (const [path, body] of after) {
    const was = before.get(path);
    if (was === undefined && path === OBSERVER_PAUSE) continue; // the observer stopping the loop
    if (was === undefined || !was.equals(body)) touched.add(path);
  }
  for (const path of before.keys()) if (!after.has(path)) touched.add(path);
  return [...touched].sort();
}

function isRegularFile(abs: string): boolean {
  try { return statSync(abs).isFile(); } catch { return false; }
}

/** Put the guarded paths back exactly as the snapshot found them. */
export function restoreEngineState(arenaDir: string, before: EngineStateSnapshot): void {
  // Clear first, then rewrite from the snapshot: anything the ACT added is absent from
  // it, so what remains afterwards is precisely what was there before.
  for (const guarded of ENGINE_OWNED_STATE) {
    // Never delete a pause the snapshot did not have: that is the observer's, written while
    // the ACT ran, and restoring "what was there before" would silently un-halt the loop.
    // Only a REGULAR FILE is the observer's pause. A directory at that path — an ACT writing
    // `.doctrine/pause/child`, which the file-shaped deny rule does not match — is tampering
    // like any other, and left in place it would make every later tick throw reading a
    // directory as the pause (PR #98 review). So it is removed like everything else.
    if (guarded === OBSERVER_PAUSE && !before.has(OBSERVER_PAUSE) && isRegularFile(join(arenaDir, OBSERVER_PAUSE))) continue;
    rmSync(join(arenaDir, guarded.replace(/\/$/, "")), { recursive: true, force: true });
  }
  for (const [path, body] of before) {
    const abs = join(arenaDir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

/** One line per touched path, for a failure reason the observer can act on. */
export function describeTampering(paths: readonly string[]): string[] {
  return paths.map(
    (f) => `${f}: engine-owned state — an ACT may not edit the scheduler's record or the case standing against its own plan`,
  );
}
