import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * WIP=1 lease: atomic mkdir acquire. A SIGKILLed tick cannot run a release trap,
 * so AGE is the only honest staleness signal —
 * a lease older than LEASE_STALE_S is broken and re-acquired.
 */

export const LEASE_STALE_S = 3600;

export interface Lease {
  acquired: boolean;
  release: () => void;
}

export function leaseDir(arenaDir: string): string {
  return join(arenaDir, ".doctrine", "lease");
}

export function acquireLease(arenaDir: string, nowMs: number = Date.now()): Lease {
  const dir = leaseDir(arenaDir);
  mkdirSync(join(arenaDir, ".doctrine"), { recursive: true });

  const tryAcquire = (): boolean => {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "owner"), `pid=${process.pid} at=${new Date(nowMs).toISOString()}\n`);
      return true;
    } catch {
      return false;
    }
  };

  if (tryAcquire()) return { acquired: true, release: () => release(arenaDir) };

  // Held — break only if stale.
  try {
    const ageS = (nowMs - statSync(dir).mtimeMs) / 1000;
    if (ageS > LEASE_STALE_S) {
      rmSync(dir, { recursive: true, force: true });
      if (tryAcquire()) return { acquired: true, release: () => release(arenaDir) };
    }
  } catch {
    // raced with a release — one clean retry
    if (tryAcquire()) return { acquired: true, release: () => release(arenaDir) };
  }
  return { acquired: false, release: () => {} };
}

export function release(arenaDir: string): void {
  rmSync(leaseDir(arenaDir), { recursive: true, force: true });
}
