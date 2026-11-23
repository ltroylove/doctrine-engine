import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve a bash that actually runs. On Windows, PATH order can put the WSL
 * relay (System32\bash.exe) ahead of Git Bash; with no distro installed every
 * command dies with execvpe(/bin/bash) — the grade rung would silently fail
 * forever. Prefer Git Bash explicitly; a plain "bash" is only a fallback.
 */
export function resolveBash(): string {
  if (process.platform !== "win32") return "bash";
  if (process.env["DOCTRINE_BASH"] !== undefined && existsSync(process.env["DOCTRINE_BASH"])) {
    return process.env["DOCTRINE_BASH"];
  }
  for (const candidate of [
    join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "bash";
}

export const BASH = resolveBash();

/**
 * Run a manifest's `setup` command in each directory, through a shell.
 *
 * It used to be `execFileSync(setup.split(" ")[0], setup.split(" ").slice(1))` with
 * `shell: true` on Windows only — copied into three places. Splitting a command string
 * on spaces is not parsing it: quoted arguments, escaped spaces, redirections and
 * pipelines all break, and they broke *silently on non-Windows only*, because there
 * the shell that would have re-assembled them was switched off. A manifest whose setup
 * is `npm ci --prefer-offline` survives that; one with a quoted argument does not, and
 * the failure is a mangled argv rather than an error.
 *
 * The same bash that runs evidence and acceptance runs setup, so a target author writes
 * one kind of command throughout rather than a restricted dialect for this one field.
 *
 * Throws on failure with the command and its output. Setup failing is an environment
 * fault, never a verdict on the work — every caller must be free to treat it as such.
 */
/**
 * Run a command in one directory and hand back its exit code instead of throwing.
 *
 * `runSetup` folds the code into an Error message, which is right for setup — an
 * environment fault is never a verdict — but the design probe has to READ the code:
 * the target uses a documented one to say "nothing is registered yet", and every other
 * code means the capture broke. A number in prose is not a signal.
 */
export function runForStatus(command: string, cwd: string): number {
  const res = spawnSync(BASH, ["-c", command], { cwd, encoding: "utf8", stdio: "pipe" });
  return res.status ?? 1;
}

export function runSetup(setup: string | undefined, dirs: readonly string[]): void {
  if (setup === undefined || setup.trim().length === 0) return;
  for (const cwd of dirs) {
    const res = spawnSync(BASH, ["-c", setup], { cwd, encoding: "utf8", stdio: "pipe" });
    if (res.status !== 0) {
      const detail = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().slice(-500);
      throw new Error(`setup "${setup}" failed in ${cwd} (exit ${res.status ?? "signal " + String(res.signal)})\n${detail}`);
    }
  }
}
