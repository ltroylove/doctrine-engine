import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Steering is entirely through the repo (design.md): a pause file halts, a
 * directives file carries the observer's exceptions. Silence means proceed.
 */

export interface Steering {
  paused: boolean;
  pauseReason: string | null;
  /** Unit/intent ids the observer has vetoed — never picked while listed. */
  veto: string[];
  /** Unit ids to prefer ahead of normal dependency order. */
  priority: string[];
  intakeMode: "auto" | "manual";
}

export function pausePath(arenaDir: string): string {
  return join(arenaDir, ".doctrine", "pause");
}

/**
 * A pause may carry `resume_at: <ISO>` on its own line. Past that instant it is no
 * longer a pause: the loop clears it and carries on.
 *
 * The daily spend gate said "pausing until tomorrow or observer resume" and wrote a
 * file that never cleared, so tomorrow never came — a budget that resets every day
 * halted the loop until a person deleted a file. That is the difference between a
 * reason to stop and a reason to wait, and only the first should need a human.
 *
 * A pause written by the observer, or by a systematic failure, carries no `resume_at`
 * and never expires. Those are reasons to stop.
 */
export function pauseResumeAt(text: string): Date | null {
  const m = /^\s*resume_at:\s*(\S+)\s*$/m.exec(text);
  if (m === null) return null;
  const t = Date.parse(m[1]!);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * Remove an expired timed pause — but ONLY if the file is still the one that expired.
 *
 * The pause file is an external steering interface: the observer may replace it at any
 * instant, including between the read that decided it had expired and the unlink that
 * acts on that decision. Unlinking blindly there deletes a permanent observer hold
 * written moments earlier and lets the tick proceed into paid work. That is the single
 * worst outcome available in this file, because the observer pause is the human veto.
 *
 * So the compare is the point: re-read, and if the bytes are not the ones that expired,
 * leave it alone. Whatever replaced it is newer and means something.
 *
 * Returns whether the pause is now gone.
 */
export function clearExpiredPause(arenaDir: string, expected: string): boolean {
  try {
    if (readFileSync(pausePath(arenaDir), "utf8") !== expected) return false;
    rmSync(pausePath(arenaDir), { force: true });
    return true;
  } catch {
    return !existsSync(pausePath(arenaDir));
  }
}

export function readSteering(arenaDir: string, nowMs: number = Date.now()): Steering {
  let paused = existsSync(pausePath(arenaDir));
  const rawPause = paused ? readFileSync(pausePath(arenaDir), "utf8") : "";
  let pauseReason = paused ? rawPause.trim() || null : null;

  if (paused && pauseReason !== null) {
    const resumeAt = pauseResumeAt(pauseReason);
    if (resumeAt !== null && nowMs >= resumeAt.getTime() && clearExpiredPause(arenaDir, rawPause)) {
      paused = false;
      pauseReason = null;
    }
  }

  const directivesPath = join(arenaDir, ".doctrine", "directives.md");
  let veto: string[] = [];
  let priority: string[] = [];
  let intakeMode: "auto" | "manual" = "auto";

  if (existsSync(directivesPath)) {
    const text = readFileSync(directivesPath, "utf8");
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (m) {
      try {
        const fm = parseYaml(m[1]!) as Record<string, unknown> | null;
        if (fm !== null && typeof fm === "object") {
          if (Array.isArray(fm["veto"])) veto = fm["veto"].filter((v): v is string => typeof v === "string");
          if (Array.isArray(fm["priority"])) priority = fm["priority"].filter((v): v is string => typeof v === "string");
          if (fm["intake_mode"] === "manual") intakeMode = "manual";
        }
      } catch {
        // Unparseable directives must not be silently ignored as "no directives" —
        // fail safe: treat as paused so the observer notices.
        return { paused: true, pauseReason: "directives.md frontmatter is unparseable", veto, priority, intakeMode };
      }
    }
  }
  return { paused, pauseReason, veto, priority, intakeMode };
}
