import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ghFailureText, landUnit, type LandContext } from "../src/merge.js";
import { parseWorkUnit, type WorkUnit } from "../src/work-unit.js";
import type { Verdict } from "../src/verdict.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-merge-"));
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

function makeArenaWithBranch(): { arena: string; branch: string; headSha: string; unit: WorkUnit } {
  const arena = mkdtempSync(join(tmp, "arena-"));
  gitIn(arena, ["init", "-b", "development"]);
  writeFileSync(join(arena, "app.txt"), "v1\n");
  mkdirSync(join(arena, "work"), { recursive: true });
  writeFileSync(join(arena, "work", "wu-x.md"), UNIT_MD);
  gitIn(arena, ["add", "-A"]);
  commit(arena, "seed");

  gitIn(arena, ["checkout", "-q", "-b", "doctrine/wu-x-123"]);
  writeFileSync(join(arena, "app.txt"), "v2\n");
  gitIn(arena, ["add", "-A"]);
  commit(arena, "feat: v2");
  const headSha = gitIn(arena, ["rev-parse", "HEAD"]);
  gitIn(arena, ["checkout", "-q", "development"]);

  const parsed = parseWorkUnit(UNIT_MD);
  if (!parsed.ok) throw new Error("fixture");
  return { arena, branch: "doctrine/wu-x-123", headSha, unit: parsed.unit };
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

function land(overrides: Partial<LandContext> = {}): { arena: string; result: ReturnType<typeof landUnit> } {
  const { arena, branch, headSha, unit } = makeArenaWithBranch();
  const result = landUnit({
    arenaDir: arena,
    baseBranch: "development",
    unit,
    branch,
    headSha,
    verdict: verdict(unit.id),
    spendUsd: 0.4,
    ...overrides,
  });
  return { arena, result };
}

describe("landUnit", () => {
  it("ff-merges, flips status in the landing commit, appends the decision, deletes the branch", () => {
    const { arena, result } = land();
    expect(result.landed).toBe(true);
    expect(readFileSync(join(arena, "app.txt"), "utf8").trim()).toBe("v2");
    expect(readFileSync(join(arena, "work", "wu-x.md"), "utf8")).toContain("status: merged");
    const decisions = readFileSync(join(arena, "context", "decisions.md"), "utf8");
    expect(decisions).toContain("wu-x");
    expect(decisions).toContain("judge: pass");
    expect(gitIn(arena, ["branch", "--list", "doctrine/*"])).toBe("");
    // Bookkeeping travels IN the landing commit, not as drift.
    expect(gitIn(arena, ["status", "--porcelain"])).toBe("");
    // Machine-marked name, but a resolvable email (clone/global config, never the
    // unverifiable placeholder when an identity exists) — Vercel blocks otherwise.
    expect(gitIn(arena, ["log", "-1", "--format=%an"])).toBe("doctrine-engine");
    expect(gitIn(arena, ["log", "-1", "--format=%ae"]).length).toBeGreaterThan(0);
  });

  it("writes a defect record when earlier attempts failed", () => {
    const { arena } = land({ priorFailures: ["attempt 1: evidence[0] failed — test never went red"] });
    const dir = join(arena, "context", "defects");
    expect(existsSync(dir)).toBe(true);
    const files = readFileSync(join(arena, "context", "decisions.md"), "utf8");
    expect(files).toContain("wu-x");
  });

  it("falls back to a merge commit when base moved, and parks on conflict", () => {
    // Base moved compatibly (different file) -> merge commit path.
    const { arena, branch, headSha, unit } = makeArenaWithBranch();
    writeFileSync(join(arena, "other.txt"), "unrelated\n");
    gitIn(arena, ["add", "-A"]);
    commit(arena, "unrelated");
    const ok = landUnit({
      arenaDir: arena, baseBranch: "development", unit, branch, headSha,
      verdict: verdict(unit.id), spendUsd: 0.1,
    });
    expect(ok.landed).toBe(true);

    // Conflicting base move -> clean abort, parked.
    const second = makeArenaWithBranch();
    writeFileSync(join(second.arena, "app.txt"), "v1-conflicting\n");
    gitIn(second.arena, ["add", "-A"]);
    commit(second.arena, "conflicting");
    const parked = landUnit({
      arenaDir: second.arena, baseBranch: "development", unit: second.unit,
      branch: second.branch, headSha: second.headSha,
      verdict: verdict(second.unit.id), spendUsd: 0.1,
    });
    expect(parked.landed).toBe(false);
    if (parked.landed) return;
    expect(parked.reason).toContain("conflict");
    // Development is left clean — no half-merge.
    expect(gitIn(second.arena, ["status", "--porcelain"])).toBe("");
  });
});

describe("a park has to say why", () => {
  it("carries gh's own words, not just the command line that produced them", () => {
    // A real park once read, in its entirety:
    //   "merging the reviewed PR failed (Command failed: gh pr merge <branch> --merge)"
    // which names the command and says nothing about the cause. The diagnosis was in
    // stderr, and it was discarded — so when an observer went to find out what had
    // happened, the only party that knew had already been thrown away.
    const e = Object.assign(new Error("Command failed: gh pr merge doctrine/wu-x --merge"), {
      stderr: "GraphQL: Pull request is not mergeable: the base branch was modified\n",
      stdout: "",
    });
    const text = ghFailureText(e);
    expect(text).toContain("Command failed: gh pr merge");
    expect(text).toContain("base branch was modified");
    // One line, because it lands in a tick record an observer reads in a terminal.
    expect(text).not.toContain("\n");
  });

  it("survives an error object with no streams at all", () => {
    expect(ghFailureText(new Error("boom"))).toBe("boom");
    expect(ghFailureText("just a string")).toBe("just a string");
  });
});
