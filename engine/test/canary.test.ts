import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { commitExists, evaluateCatch, prepareSacrifice, runCanary } from "../src/canary.js";
import type { JudgeOutcome } from "../src/judge.js";
import type { Verdict } from "../src/verdict.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-canary-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function verdict(overrides: Partial<Verdict>): JudgeOutcome {
  return {
    kind: "judged",
    logPath: "x",
    verdict: {
      unit: "wu-x",
      verdict: "fail",
      judged: true,
      coherence: [{ criterion: "no-test-weakening", ok: false }],
      evidence: [
        {
          spec: "pnpm test",
          run: { command: "pnpm test", exit_code: 1, output_sha256: "aa", log: "l" },
          ok: false,
        },
      ],
      gates_executed: ["diff-read", "evidence-executed"],
      base_sha: "a",
      head_sha: "b",
      spend_usd: 0.1,
      ...overrides,
    },
  };
}

describe("evaluateCatch", () => {
  it("caught when verdict matches and the demanded flag failed", () => {
    expect(evaluateCatch(verdict({}), { verdict: "fail", must_flag: "evidence[0]" }).result).toBe("caught");
    expect(
      evaluateCatch(verdict({}), { verdict: "fail", must_flag: "coherence:no-test-weakening" }).result,
    ).toBe("caught");
  });

  it("missed when the judge passes the seeded defect — the number that matters", () => {
    const pass = verdict({
      verdict: "pass",
      coherence: [{ criterion: "scope", ok: true, quote: "q" }],
      evidence: [
        { spec: "pnpm test", run: { command: "pnpm test", exit_code: 0, output_sha256: "aa", log: "l" }, ok: true },
      ],
    });
    expect(evaluateCatch(pass, { verdict: "fail", must_flag: "evidence[0]" }).result).toBe("missed");
  });

  it("missed when it fails for the wrong reason (demanded flag not raised)", () => {
    const wrongReason = verdict({
      coherence: [{ criterion: "no-test-weakening", ok: true, quote: "q" }],
    });
    expect(
      evaluateCatch(wrongReason, { verdict: "fail", must_flag: "coherence:no-test-weakening" }).result,
    ).toBe("missed");
  });

  it("any-of flags: one match suffices", () => {
    expect(
      evaluateCatch(verdict({}), { verdict: "fail", must_flag: ["coherence:scope", "evidence[0]"] }).result,
    ).toBe("caught");
  });

  it("a judge-run failure is an error, not a catch", () => {
    const failed: JudgeOutcome = { kind: "failed", reason: "missing-verdict", outage: false, errors: ["no artifact"], logPath: "x" };
    expect(evaluateCatch(failed, { verdict: "fail" }).result).toBe("error");
  });
});

describe("prepareSacrifice (real git, offline)", () => {
  it("builds base+head worktrees with the patch committed and a diff artifact", () => {
    // Mini arena: a repo with one file on branch development.
    const arena = join(tmp, "mini-arena");
    mkdirSync(arena, { recursive: true });
    const g = (args: string[], cwd = arena): string =>
      execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    g(["init", "-b", "development"]);
    writeFileSync(join(arena, "a.txt"), "left\n");
    g(["add", "-A"]);
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"],
      { cwd: arena },
    );

    // A canary patch flipping the file's content, generated from a real edit.
    const patchPath = join(tmp, "flip.patch");
    writeFileSync(join(arena, "a.txt"), "right\n");
    const diff = execFileSync("git", ["diff"], { cwd: arena, encoding: "utf8" });
    writeFileSync(patchPath, diff);
    g(["checkout", "--", "a.txt"]);

    const runDir = join(tmp, "run-1");
    const s = prepareSacrifice(arena, patchPath, runDir, "development");
    try {
      expect(readFileSync(join(s.headDir, "a.txt"), "utf8").trim()).toBe("right");
      expect(readFileSync(join(s.baseDir, "a.txt"), "utf8").trim()).toBe("left");
      expect(s.headSha).not.toBe(s.baseSha);
      const diffText = readFileSync(s.diffPath, "utf8");
      expect(diffText).toContain("-left");
      expect(diffText).toContain("+right");
    } finally {
      s.cleanup();
    }
  });

  it("a pinned base sha wins over the branch head — canaries are fixtures of a specific tree", () => {
    const arena = join(tmp, "pinned-arena");
    mkdirSync(arena, { recursive: true });
    const g = (args: string[], cwd = arena): string =>
      execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    const commit = (msg: string): string => {
      g(["add", "-A"]);
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg], { cwd: arena });
      return g(["rev-parse", "HEAD"]);
    };
    g(["init", "-b", "development"]);
    writeFileSync(join(arena, "a.txt"), "left\n");
    const seedSha = commit("seed");

    // Patch authored against the seed...
    const patchPath = join(tmp, "flip-pinned.patch");
    writeFileSync(join(arena, "a.txt"), "right\n");
    writeFileSync(patchPath, execFileSync("git", ["diff"], { cwd: arena, encoding: "utf8" }));
    g(["checkout", "--", "a.txt"]);

    // ...then the arena moves on, and the patch no longer applies at the branch head.
    writeFileSync(join(arena, "a.txt"), "moved on\n");
    const headSha = commit("arena evolves");
    expect(headSha).not.toBe(seedSha);
    const runHead = join(tmp, "run-head");
    expect(() => prepareSacrifice(arena, patchPath, runHead, "development")).toThrow();
    // The failed build left nothing registered — and the same runDir is reusable.
    expect(g(["worktree", "list", "--porcelain"])).not.toContain("run-head");
    const reused = prepareSacrifice(arena, patchPath, runHead, seedSha);
    reused.cleanup();

    expect(commitExists(arena, seedSha)).toBe(true);
    expect(commitExists(arena, "not-a-ref")).toBe(false);

    const s = prepareSacrifice(arena, patchPath, join(tmp, "run-pinned"), seedSha);
    try {
      expect(s.baseSha).toBe(seedSha);
      expect(readFileSync(join(s.baseDir, "a.txt"), "utf8").trim()).toBe("left");
      expect(readFileSync(join(s.headDir, "a.txt"), "utf8").trim()).toBe("right");
    } finally {
      s.cleanup();
    }
  });
});

describe("runCanary setup", () => {
  /** A one-canary arena plus a fixture that patches its single file. */
  function miniArena(setup: string | undefined): { arena: string; canaries: string } {
    const arena = mkdtempSync(join(tmp, "setup-arena-"));
    const g = (args: string[], cwd = arena): string =>
      execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    g(["init", "-b", "development"]);
    mkdirSync(join(arena, ".doctrine"), { recursive: true });
    writeFileSync(
      join(arena, ".doctrine", "manifest.json"),
      JSON.stringify({ name: "t", base_branch: "development", ...(setup === undefined ? {} : { setup }) }),
    );
    writeFileSync(join(arena, "a.txt"), "left\n");
    g(["add", "-A"]);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"], { cwd: arena });

    const canaries = mkdtempSync(join(tmp, "setup-canaries-"));
    const dir = join(canaries, "cn-mini");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(arena, "a.txt"), "right\n");
    writeFileSync(join(dir, "patch.diff"), execFileSync("git", ["diff"], { cwd: arena, encoding: "utf8" }));
    g(["checkout", "--", "a.txt"]);
    writeFileSync(join(dir, "unit.md"), [
      "---", "id: wu-mini", "title: mini", "tier: reversible", "status: ready", "budget_usd: 3",
      "evidence:", "  - kind: command", '    run: "pnpm test"', '    expect: "exit 0 on head"',
      "---", "Flip a.txt. Nothing else changes.", "",
    ].join("\n"));
    writeFileSync(join(dir, "expect.json"), JSON.stringify({ verdict: "fail", must_flag: "evidence[0]" }));
    return { arena, canaries };
  }

  it("a failing setup command is that canary's error, not a thrown sweep", async () => {
    // Setup is read from the arena's working tree, never the canary's pinned commit (the
    // pin has no setup field — see the comment in canary.ts). So a setup command the pinned
    // tree cannot run is a live risk, and it must land the way an unresolvable pin does:
    // one canary reported as `error`, the sweep walking on, no judge spend burned.
    const { arena, canaries } = miniArena("this-command-does-not-exist --nope");
    let judged = false;
    const run = await runCanary("cn-mini", {
      arenaDir: arena,
      canariesDir: canaries,
      runsDir: join(arena, ".doctrine", "canary-runs"),
      agentDefinitionPath: "unused",
      budgetUsd: 1,
      judge: async () => { judged = true; throw new Error("judge must not run"); },
    });
    expect(run.result).toBe("error");
    expect(run.detail).toContain("setup");
    expect(judged).toBe(false);
    // Nothing left registered for the next sweep to trip over.
    expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: arena, encoding: "utf8" }))
      .not.toContain("cn-mini");
  });
});
