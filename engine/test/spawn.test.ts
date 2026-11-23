import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { classifySpawn, runAgent, type RunAgentOptions } from "../src/spawn.js";

const fixtures = fileURLToPath(new URL("./fake-claude/", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "doctrine-spawn-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let logN = 0;
function opts(fixture: string, extra?: Partial<RunAgentOptions>): RunAgentOptions {
  return {
    command: process.execPath,
    commandPrefixArgs: [join(fixtures, fixture)],
    argv: [],
    cwd: tmp,
    timeoutMs: 10_000,
    logPath: join(tmp, `run-${logN++}.log`),
    ...extra,
  };
}

describe("runAgent (offline, fake-claude fixtures)", () => {
  it("delivers the prompt over stdin and strips ANTHROPIC_API_KEY from the child env", async () => {
    const prompt = "verify this diff please";
    const res = await runAgent(
      prompt,
      opts("emit-result.mjs", { env: { ANTHROPIC_API_KEY: "sneaky-key" } }),
    );
    expect(res.spawnFailed).toBe(false);
    expect(res.timedOut).toBe(false);
    expect(res.exitCode).toBe(0);
    expect(res.resultMessage).not.toBeNull();
    const observed = JSON.parse(res.resultMessage!.result!) as {
      promptLen: number;
      hasApiKey: boolean;
    };
    expect(observed.promptLen).toBe(prompt.length);
    expect(observed.hasApiKey).toBe(false);
    expect(classifySpawn(res)).toBeNull();
  });

  it("turns background tasks off in the child, whatever the caller passes", async () => {
    // claude -p ends the session when the turn ends, so a backgrounded command dies with it.
    // A judge that backgrounded its evidence runs once exited with no verdict.
    // The caller's env must not be able to turn it back on.
    const res = await runAgent(
      "x",
      opts("emit-result.mjs", { env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0" } }),
    );
    const observed = JSON.parse(res.resultMessage!.result!) as { backgroundTasks: string | null };
    expect(observed.backgroundTasks).toBe("1");
  });

  it("writes the durable log artifact", async () => {
    const res = await runAgent("p", opts("emit-result.mjs"));
    const log = readFileSync(res.logPath, "utf8");
    expect(log).toContain('"type":"result"');
    expect(log).toContain("this line is not json at all");
  });

  it("classifies a nonzero exit", async () => {
    const res = await runAgent("p", opts("exit-nonzero.mjs"));
    expect(res.exitCode).toBe(2);
    expect(classifySpawn(res)).toBe("nonzero-exit");
  });

  it("treats budget truncation as failure even on exit 0", async () => {
    const res = await runAgent("p", opts("emit-truncated.mjs"));
    expect(res.exitCode).toBe(0);
    expect(res.resultMessage?.subtype).toBe("error_max_budget_usd");
    expect(classifySpawn(res)).toBe("budget-truncated");
  });

  it("marks a $0 API-error run as an outage (never burns an attempt downstream)", async () => {
    const res = await runAgent("p", opts("emit-outage.mjs"));
    expect(res.exitCode).toBe(1);
    expect(res.outage).toBe(true);
    expect(classifySpawn(res)).toBe("nonzero-exit"); // still a failed run — outage is a modifier
  });

  it("classifies a spawn failure (no such executable)", async () => {
    const res = await runAgent("p", {
      command: "definitely-not-a-real-binary-9b1c",
      argv: [],
      cwd: tmp,
      timeoutMs: 2_000,
      logPath: join(tmp, "spawn-fail.log"),
    });
    expect(res.spawnFailed).toBe(true);
    expect(classifySpawn(res)).toBe("spawn-failed");
  });

  it("kills the whole process tree on timeout — grandchild included", async () => {
    const res = await runAgent("p", opts("hang-with-child.mjs", { timeoutMs: 1_000 }));
    expect(res.timedOut).toBe(true);
    expect(classifySpawn(res)).toBe("timed-out");

    // The fixture emitted its grandchild's pid before hanging; probe that it is gone.
    const line = readFileSync(res.logPath, "utf8")
      .split(/\r?\n/)
      .find((l) => l.includes("grandchildPid"));
    expect(line).toBeDefined();
    const { grandchildPid } = JSON.parse(line!) as { grandchildPid: number };
    // Give the tree-kill a moment to complete, then expect the probe to throw ESRCH.
    await new Promise((r) => setTimeout(r, 700));
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  }, 15_000);
});
