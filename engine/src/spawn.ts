import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseResultMessage, isTruncated, isOutage, type ResultMessage } from "./result.js";
import type { RunFailureReason } from "./outcome.js";

const KILL_GRACE_MS = 250;

export interface RunAgentOptions {
  /** Executable to spawn. Defaults to "claude". Tests inject node + a fixture script. */
  command?: string;
  /** Args placed before argv — lets tests run `node fixture.mjs <argv…>`. */
  commandPrefixArgs?: string[];
  argv: string[];
  cwd: string;
  timeoutMs: number;
  /** stdout+stderr are captured here — the durable log ("trust artifacts, never claims"). */
  logPath: string;
  env?: Record<string, string | undefined>;
}

export interface SpawnRunResult {
  spawnFailed: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** True when the run died on an API-side error with $0 spend — retry with backoff;
   *  never burn an attempt or count toward the failure halt. */
  outage: boolean;
  logPath: string;
  resultMessage: ResultMessage | null;
}

/**
 * Classify a spawn-level result into a terminal failure reason, or null if the
 * process-level run succeeded. Order matters: a timed-out run has exitCode null,
 * so timeout is checked before exit code.
 */
export function classifySpawn(res: SpawnRunResult): RunFailureReason | null {
  if (res.spawnFailed) return "spawn-failed";
  if (res.timedOut) return "timed-out";
  if (res.exitCode !== 0) return "nonzero-exit";
  if (res.resultMessage !== null && isTruncated(res.resultMessage)) return "budget-truncated";
  return null;
}

function killTree(pid: number, detached: boolean): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  const target = detached ? -pid : pid;
  try {
    process.kill(target, "SIGTERM");
  } catch {
    return; // already gone
  }
  setTimeout(() => {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // already gone — fine
    }
  }, KILL_GRACE_MS).unref();
}

/**
 * The hardened agent-invocation seam (written from scratch):
 * prompt over stdin ONLY, argv array, shell:false, process-group kill on timeout,
 * ANTHROPIC_API_KEY stripped from the child environment (subscription OAuth is the
 * only credential — an API key must never be a silent fallback).
 */
export async function runAgent(prompt: string, opts: RunAgentOptions): Promise<SpawnRunResult> {
  const command = opts.command ?? "claude";
  const args = [...(opts.commandPrefixArgs ?? []), ...opts.argv];
  const detached = process.platform !== "win32";

  const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
  delete env["ANTHROPIC_API_KEY"];
  // No background tasks in a headless ACT. `claude -p` ends the session when the turn ends,
  // so anything the agent backgrounded is killed with it. In one run the code-judge
  // backgrounded its evidence runs, answered "I'll write the verdict once they finish", and
  // exited. The tasks were killed and no verdict was written. With this set, the Bash tool has no
  // `run_in_background`, so a long command blocks the turn, which is the behaviour every
  // ACT here assumes. Set after `opts.env`, so a caller cannot turn it back on.
  env["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"] = "1";

  mkdirSync(dirname(opts.logPath), { recursive: true });

  return new Promise<SpawnRunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (partial: Pick<SpawnRunResult, "spawnFailed" | "exitCode" | "signal">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const log = stdout + (stderr.length > 0 ? `\n--- stderr ---\n${stderr}` : "");
      writeFileSync(opts.logPath, log);
      const resultMessage = parseResultMessage(stdout);
      resolve({
        ...partial,
        timedOut,
        outage: resultMessage !== null && isOutage(resultMessage),
        logPath: opts.logPath,
        resultMessage,
      });
    };

    let child;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env,
        shell: false,
        detached,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      finish({ spawnFailed: true, exitCode: null, signal: null });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid, detached);
    }, opts.timeoutMs);

    child.on("error", () => finish({ spawnFailed: true, exitCode: null, signal: null }));
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code, signal) =>
      finish({ spawnFailed: false, exitCode: code, signal: signal ?? null }),
    );

    // Prompt over stdin only. A fast-exiting child can EPIPE the write — ignore it;
    // the close handler settles the result either way.
    child.stdin.on("error", () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
