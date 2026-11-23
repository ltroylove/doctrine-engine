import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { tick, type TickDeps } from "../src/dispatch.js";
import type { RunAgentFn } from "../src/judge.js";
import { landUnitViaPr, type RunGhFn } from "../src/merge.js";
import type { SpawnRunResult } from "../src/spawn.js";
import { parseWorkUnit, type WorkUnit } from "../src/work-unit.js";
import type { Verdict } from "../src/verdict.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-landpr-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const UNIT_MD = `---
id: wu-x
title: Bump the marker
tier: reversible
status: ready
budget_usd: 5
evidence:
  - kind: command
    run: "grep -q v2 app.txt"
    expect: "exit 0 on head"
---
Bump it.
`;

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function commit(cwd: string, msg: string): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg], { cwd });
}

/** Arena clone + bare origin, with a judged unit branch ready to land. */
function makeRemoteArena(prMode = false): { arena: string; bare: string; branch: string; headSha: string; unit: WorkUnit } {
  const bare = mkdtempSync(join(tmp, "origin-"));
  gitIn(bare, ["init", "-q", "--bare", "-b", "development"]);

  const arena = mkdtempSync(join(tmp, "arena-"));
  gitIn(arena, ["init", "-q", "-b", "development"]);
  mkdirSync(join(arena, ".doctrine"), { recursive: true });
  writeFileSync(
    join(arena, ".doctrine", "manifest.json"),
    JSON.stringify({ name: "t", base_branch: "development", doors: [], ...(prMode ? { landing: "pr" } : {}) }),
  );
  writeFileSync(join(arena, ".gitignore"), ".doctrine/lease/\n.doctrine/runs/\n.doctrine/canary-runs/\n");
  writeFileSync(join(arena, "app.txt"), "v1\n");
  mkdirSync(join(arena, "work", "intents"), { recursive: true });
  writeFileSync(join(arena, "work", "wu-x.md"), UNIT_MD);
  gitIn(arena, ["add", "-A"]);
  commit(arena, "seed");
  gitIn(arena, ["remote", "add", "origin", bare]);
  gitIn(arena, ["push", "-q", "-u", "origin", "development"]);

  gitIn(arena, ["checkout", "-q", "-b", "doctrine/wu-x-123"]);
  writeFileSync(join(arena, "app.txt"), "v2\n");
  gitIn(arena, ["add", "-A"]);
  commit(arena, "feat: v2");
  const headSha = gitIn(arena, ["rev-parse", "HEAD"]);
  gitIn(arena, ["checkout", "-q", "development"]);

  const parsed = parseWorkUnit(UNIT_MD);
  if (!parsed.ok) throw new Error("fixture");
  return { arena, bare, branch: "doctrine/wu-x-123", headSha, unit: parsed.unit };
}

/**
 * Fake `gh`: records calls; `pr merge` simulates GitHub's server-side merge by
 * merging the pushed branch into the base inside a scratch clone of the bare
 * origin and pushing the result — exactly what the arena then fast-forwards to.
 */
function fakeGh(bare: string, opts: { failOn?: "create" | "merge"; notMergeableTimes?: number } = {}): { gh: RunGhFn; calls: string[][] } {
  const calls: string[][] = [];
  let notMergeableLeft = opts.notMergeableTimes ?? 0;
  const gh: RunGhFn = (args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "create") {
      if (opts.failOn === "create") throw new Error("gh: pr create refused (fake)");
      return "https://github.example/pull/7";
    }
    if (args[0] === "pr" && args[1] === "merge") {
      if (notMergeableLeft > 0) {
        notMergeableLeft--;
        throw new Error("GraphQL: Pull Request is not mergeable (mergePullRequest)");
      }
      if (opts.failOn === "merge") throw new Error("gh: pr merge refused (fake)");
      const branch = args[2]!;
      const scratch = mkdtempSync(join(tmp, "gh-scratch-"));
      execFileSync("git", ["clone", "-q", "-b", "development", bare, scratch], { encoding: "utf8" });
      execFileSync(
        "git",
        ["-c", "user.name=gh", "-c", "user.email=gh@github", "merge", "--no-ff", "-q", "-m", `Merge pull request (${branch})`, `origin/${branch}`],
        { cwd: scratch, encoding: "utf8" },
      );
      gitIn(scratch, ["push", "-q", "origin", "development"]);
      return "";
    }
    return "";
  };
  return { gh, calls };
}

function verdict(unitId: string): Verdict {
  return {
    unit: unitId,
    verdict: "pass",
    judged: true,
    coherence: [{ criterion: "scope", ok: true, quote: "q" }],
    evidence: [
      { spec: "grep -q v2 app.txt", run: { command: "grep", exit_code: 0, output_sha256: "aa", log: "l" }, ok: true },
    ],
    gates_executed: ["diff-read", "evidence-executed"],
    base_sha: "a",
    head_sha: "b",
    spend_usd: 0.4,
  };
}

describe("landUnitViaPr", () => {
  it("pushes, opens the PR, machine-merges, and lands code + bookkeeping atomically on origin", () => {
    const { arena, bare, branch, headSha, unit } = makeRemoteArena();
    const { gh, calls } = fakeGh(bare);
    const result = landUnitViaPr({
      arenaDir: arena, baseBranch: "development", unit, branch, headSha,
      verdict: verdict(unit.id), spendUsd: 0.4, runGh: gh,
    });
    expect(result.landed).toBe(true);

    // Origin's development carries the code AND the bookkeeping — atomically.
    expect(gitIn(bare, ["show", "development:app.txt"]).trim()).toBe("v2");
    expect(gitIn(bare, ["show", "development:work/wu-x.md"])).toContain("status: merged");
    expect(gitIn(bare, ["show", "development:context/decisions.md"])).toContain("PR https://github.example/pull/7");

    // The arena is synced to the remote merge and clean; the branch is gone.
    expect(readFileSync(join(arena, "app.txt"), "utf8").trim()).toBe("v2");
    expect(readFileSync(join(arena, "work", "wu-x.md"), "utf8")).toContain("status: merged");
    expect(gitIn(arena, ["branch", "--list", "doctrine/*"])).toBe("");
    expect(gitIn(arena, ["status", "--porcelain"])).toBe("");
    expect(gitIn(arena, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("development");

    // gh saw the right shape: create into the base branch, then merge.
    const create = calls.find((c) => c[1] === "create")!;
    expect(create).toContain("--base");
    expect(create[create.indexOf("--base") + 1]).toBe("development");
    expect(create[create.indexOf("--head") + 1]).toBe(branch);
    expect(calls.some((c) => c[1] === "merge")).toBe(true);
  }, 60_000);

  it("parks on gh failure and restores the branch to the judged head (no bookkeeping in a resume's diff)", () => {
    const { arena, bare, branch, headSha, unit } = makeRemoteArena();
    const { gh } = fakeGh(bare, { failOn: "merge" });
    const result = landUnitViaPr({
      arenaDir: arena, baseBranch: "development", unit, branch, headSha,
      verdict: verdict(unit.id), spendUsd: 0.4, runGh: gh,
    });
    expect(result.landed).toBe(false);
    if (result.landed) return;
    expect(result.reason).toContain("PR landing failed");

    // Branch reset to the judged head; arena back on a clean base; unit untouched.
    expect(gitIn(arena, ["rev-parse", branch])).toBe(headSha);
    expect(gitIn(arena, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("development");
    expect(gitIn(arena, ["status", "--porcelain"])).toBe("");
    expect(readFileSync(join(arena, "work", "wu-x.md"), "utf8")).toContain("status: ready");
    // Origin's development never moved.
    expect(gitIn(bare, ["show", "development:app.txt"]).trim()).toBe("v1");
  }, 60_000);

  it("retries the merge through GitHub's async mergeability window, then lands", () => {
    const { arena, bare, branch, headSha, unit } = makeRemoteArena();
    const { gh, calls } = fakeGh(bare, { notMergeableTimes: 2 });
    const result = landUnitViaPr({
      arenaDir: arena, baseBranch: "development", unit, branch, headSha,
      verdict: verdict(unit.id), spendUsd: 0.4, runGh: gh, mergeRetryDelayMs: 1,
    });
    expect(result.landed).toBe(true);
    expect(calls.filter((c) => c[1] === "merge").length).toBe(3);
    expect(gitIn(bare, ["show", "development:app.txt"]).trim()).toBe("v2");
  }, 60_000);

  it("parks before pushing anything when pr create fails", () => {
    const { arena, bare, branch, headSha, unit } = makeRemoteArena();
    const { gh, calls } = fakeGh(bare, { failOn: "create" });
    const result = landUnitViaPr({
      arenaDir: arena, baseBranch: "development", unit, branch, headSha,
      verdict: verdict(unit.id), spendUsd: 0.4, runGh: gh,
    });
    expect(result.landed).toBe(false);
    expect(calls.some((c) => c[1] === "merge")).toBe(false);
    expect(gitIn(arena, ["rev-parse", branch])).toBe(headSha);
    expect(gitIn(bare, ["show", "development:app.txt"]).trim()).toBe("v1");
  }, 60_000);
});

describe("tick with landing: pr", () => {
  const AGENTS = {
    implementer: fileURLToPath(new URL("../../.claude/agents/implementer.md", import.meta.url)),
    judge: fileURLToPath(new URL("../../.claude/agents/code-judge.md", import.meta.url)),
    decomposer: fileURLToPath(new URL("../../.claude/agents/decomposer.md", import.meta.url)),
    planJudge: fileURLToPath(new URL("../../.claude/agents/plan-judge.md", import.meta.url)),
  };

  const okSpawn = (cost = 0.3): SpawnRunResult => ({
    spawnFailed: false, exitCode: 0, signal: null, timedOut: false, outage: false,
    logPath: "x", resultMessage: { type: "result", subtype: "success", total_cost_usd: cost },
  });

  function happyAgents(): RunAgentFn {
    return async (prompt, opts) => {
      if (prompt.includes("# Your unit")) {
        writeFileSync(join(opts.cwd, "app.txt"), "v2\n");
        gitIn(opts.cwd, ["add", "-A"]);
        commit(opts.cwd, "feat: v2");
        return okSpawn(0.5);
      }
      if (prompt.includes("# Your task")) {
        const verdictPath = /write the verdict JSON to EXACTLY: (.+)/.exec(prompt)![1]!.trim();
        const baseSha = /base_sha: (\S+)/.exec(prompt)![1]!;
        const headSha = /head_sha: (\S+)/.exec(prompt)![1]!;
        writeFileSync(
          verdictPath,
          JSON.stringify({
            unit: "wu-x", verdict: "pass", judged: true,
            coherence: [{ criterion: "scope", ok: true, quote: "app.txt only" }],
            evidence: [{ spec: "grep -q v2 app.txt", run: { command: "grep -q v2 app.txt", exit_code: 0, output_sha256: "aa", log: "evidence-0.log" }, ok: true }],
            gates_executed: ["diff-read", "evidence-executed"],
            base_sha: baseSha, head_sha: headSha, spend_usd: 0.3,
          }),
        );
        return okSpawn(0.3);
      }
      throw new Error("unexpected agent prompt");
    };
  }

  it("pre-spend probe: a dead gh credential makes the tick a free no-op — no implementer runs", async () => {
    const { arena, bare } = makeRemoteArena(true);
    gitIn(arena, ["branch", "-D", "doctrine/wu-x-123"]);
    let paidActRan = false;
    const failingAuthGh: RunGhFn = (args) => {
      if (args[0] === "auth") throw new Error("gh: not logged in (fake)");
      return fakeGh(bare).gh(args, arena);
    };
    const deps: TickDeps = {
      arenaDir: arena, agentDefs: AGENTS, runGh: failingAuthGh,
      runAgent: async () => { paidActRan = true; throw new Error("must not spend"); },
    };
    const result = await tick(deps);
    expect(result.decision).toBe("no-op-landing-probe");
    expect(result.detail).toContain("gh auth probe failed");
    expect(paidActRan).toBe(false);
  }, 60_000);

  it("routes landing through the PR path and lands on origin", async () => {
    const { arena, bare } = makeRemoteArena(true);
    // The tick cuts its own branch; drop the fixture one.
    gitIn(arena, ["branch", "-D", "doctrine/wu-x-123"]);
    const { gh, calls } = fakeGh(bare);
    const deps: TickDeps = { arenaDir: arena, agentDefs: AGENTS, runAgent: happyAgents(), runGh: gh };
    const result = await tick(deps);
    expect(result.decision).toBe("landed");
    expect(calls.some((c) => c[1] === "create")).toBe(true);
    expect(calls.some((c) => c[1] === "merge")).toBe(true);
    expect(gitIn(bare, ["show", "development:app.txt"]).trim()).toBe("v2");
    expect(gitIn(bare, ["show", "development:work/wu-x.md"])).toContain("status: merged");
    expect(readFileSync(join(arena, "work", "wu-x.md"), "utf8")).toContain("status: merged");
    // Next tick idles — state re-derived from the synced base.
    expect((await tick(deps)).decision).toBe("idle");
  }, 60_000);
});
