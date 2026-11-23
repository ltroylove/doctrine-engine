#!/usr/bin/env node
// Keep the loop running.
//
//   node scripts/run-loop.mjs <arena-dir>
//
// The engine already knows the difference between a reason to wait and a reason to
// stop: a pause carrying `resume_at` is a window it sits out itself, one without is the
// observer or a systematic failure. What it cannot do is survive its own process dying
// — a crash, a closed terminal, a reboot — and a dead supervisor looks exactly like a
// finished one from the outside.
//
// So this restarts it, and respects the same distinction: a permanent pause means stop,
// and it stops. Everything else is worth another go.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const arenaDir = resolve(process.argv[2] ?? "");
if (process.argv[2] === undefined) {
  console.error("usage: node scripts/run-loop.mjs <arena-dir>");
  process.exit(2);
}

const pausePath = join(arenaDir, ".doctrine", "pause");
const TSX = join(ROOT, "engine", "node_modules", "tsx", "dist", "cli.mjs");
const LOOP = join(ROOT, "engine", "src", "loop-cli.ts");

/** A pause the loop cannot lift by itself. Those are the ones that mean stop. */
function permanentPause() {
  if (!existsSync(pausePath)) return null;
  const text = readFileSync(pausePath, "utf8");
  return /^\s*resume_at:\s*\S+\s*$/m.test(text) ? null : text.trim();
}

// Backoff, so a loop that cannot start does not spin. Resets after a run that lasted
// long enough to have done something: a supervisor that ran for ten minutes and then
// died is a different animal from one that dies on startup every time.
const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];
const HEALTHY_RUN_MS = 10 * 60_000;
let consecutiveShortRuns = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (;;) {
  const held = permanentPause();
  if (held !== null) {
    console.log(`run-loop: stopping — the arena holds a pause with no window:\n${held}`);
    process.exit(0);
  }

  const startedAt = Date.now();
  const code = await new Promise((resolveCode) => {
    const child = spawn(process.execPath, [TSX, LOOP, arenaDir], { cwd: ROOT, stdio: "inherit" });
    child.on("exit", (c) => resolveCode(c ?? 1));
    child.on("error", (e) => {
      console.error(`run-loop: could not spawn the loop: ${e.message}`);
      resolveCode(1);
    });
  });
  const ranMs = Date.now() - startedAt;

  const held2 = permanentPause();
  if (held2 !== null) {
    console.log(`run-loop: the loop stopped and the arena holds a pause with no window:\n${held2}`);
    process.exit(code === 0 ? 0 : 1);
  }

  consecutiveShortRuns = ranMs >= HEALTHY_RUN_MS ? 0 : consecutiveShortRuns + 1;
  if (consecutiveShortRuns > BACKOFF_MS.length) {
    console.error(`run-loop: giving up — ${consecutiveShortRuns} short runs in a row, the last exited ${code} after ${Math.round(ranMs / 1000)}s`);
    process.exit(1);
  }
  const wait = BACKOFF_MS[Math.min(consecutiveShortRuns, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[0];
  console.log(`run-loop: loop exited ${code} after ${Math.round(ranMs / 1000)}s; restarting in ${wait / 1000}s`);
  await sleep(wait);
}
