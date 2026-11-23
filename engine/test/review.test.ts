import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeDenySettings } from "../src/containment.js";
import { tick, type TickDeps } from "../src/dispatch.js";
import { appendTick } from "../src/ledger.js";
import type { RunGhFn } from "../src/merge.js";
import { deferredFrom } from "../src/review-fix.js";
import { metricsPath, spendSince } from "../src/ledger.js";
import {
  fetchThreads,
  findOpenPr,
  REVIEW_FIX_DENY,
  reviewWindowElapsed,
  unresolved,
} from "../src/review.js";
import type { SpawnRunResult } from "../src/spawn.js";
import { parseWorkUnit } from "../src/work-unit.js";
import type { Verdict } from "../src/verdict.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-review-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function commit(cwd: string, msg: string): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg], { cwd });
}

const UNIT_MD = `---
id: wu-r
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

// --- the pure half: parsing gh, the window, self-filtering ------------------

const THREAD_JSON = (nodes: unknown): string => JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });

describe("review — harvesting is parsing, not judgement", () => {
  it("finds the open PR for a branch and reads its clock", () => {
    const gh: RunGhFn = () => JSON.stringify([{ number: 12, url: "https://gh/pr/12", createdAt: "2026-09-04T10:00:00Z" }]);
    const pr = findOpenPr(gh, "doctrine/wu-r-1", ".");
    expect(pr.looked).toBe(true);
    if (!pr.looked || pr.value === null) throw new Error("expected a PR");
    expect(pr.value.number).toBe(12);
    expect(pr.value.createdAtMs).toBe(Date.parse("2026-09-04T10:00:00Z"));
  });

  it("distinguishes 'there is no PR' from 'the lookup failed'", () => {
    // These two must never collapse: a failed `gh` read as "no PR" makes the review
    // rung conclude the unit merged, delete the branch, and call it settled.
    const none = findOpenPr(() => "[]", "b", ".");
    expect(none).toEqual({ looked: true, value: null });

    const broken = findOpenPr(() => { throw new Error("gh: could not connect"); }, "b", ".");
    expect(broken.looked).toBe(false);

    const garbage = findOpenPr(() => "<html>502</html>", "b", ".");
    expect(garbage.looked).toBe(false);
  });

  it("the window is measured from the PR's open time", () => {
    const pr = { number: 1, url: "u", createdAtMs: 1_000_000 };
    expect(reviewWindowElapsed(pr, 1_000_000 + 299_000, 300_000)).toBe(false);
    expect(reviewWindowElapsed(pr, 1_000_000 + 300_000, 300_000)).toBe(true);
  });

  it("reads threads, and never reads the loop's own replies back as findings", () => {
    const gh: RunGhFn = () => THREAD_JSON([
      { id: "T1", isResolved: false, comments: { nodes: [{ databaseId: 1, path: "src/a.ts", line: 4, author: { login: "codex" }, body: "off by one" }] } },
      { id: "T2", isResolved: true, comments: { nodes: [{ databaseId: 2, path: "src/b.ts", line: null, author: { login: "codex" }, body: "already handled" }] } },
      { id: "T3", isResolved: false, comments: { nodes: [{ databaseId: 3, path: "src/c.ts", line: 9, author: { login: "doctrine-bot" }, body: "our own reply" }] } },
    ]);
    const threads = fetchThreads(gh, { owner: "o", repo: "r" }, 12, ".", "doctrine-bot");
    if (!threads.looked) throw new Error("expected a lookup");
    expect(threads.value.map((t) => t.threadId)).toEqual(["T1", "T2"]);
    expect(unresolved(threads.value).map((t) => t.threadId)).toEqual(["T1"]);
  });

  it("a failed thread query is a failure, not 'no findings'", () => {
    // "No findings" plus an elapsed window merges the PR. A broken query must never
    // be able to say that.
    expect(fetchThreads(() => "not json", { owner: "o", repo: "r" }, 1, ".").looked).toBe(false);
    expect(fetchThreads(() => { throw new Error("graphql 502"); }, { owner: "o", repo: "r" }, 1, ".").looked).toBe(false);
    // An authoritative empty answer still reads as empty.
    expect(fetchThreads(() => THREAD_JSON([]), { owner: "o", repo: "r" }, 1, ".")).toEqual({ looked: true, value: [] });
  });
});

describe("review-fix containment — a finding is a defect, never a re-plan", () => {
  it("the review-fix ACT cannot edit the unit, the intent, the contracts or the program docs", () => {
    const arena = mkdtempSync(join(tmp, "deny-"));
    const path = writeDenySettings(arena, { doors: ["data/**"] }, { extraDeny: REVIEW_FIX_DENY, fileName: "claude-deny-review-fix.json" });
    const deny = (JSON.parse(readFileSync(path, "utf8")) as { permissions: { deny: string[] } }).permissions.deny;
    // The failure being designed out: PR comments rewriting the plan, then a build
    // against the rewrite, with the unit under review never finished.
    expect(deny).toContain("Edit(work/)");
    expect(deny).toContain("Write(work/)");
    expect(deny).toContain("Edit(context/contracts.md)");
    expect(deny).toContain("Edit(docs/program/)");
    // ...and through the shell, which is where the first version left the door open:
    // this ACT has Bash, so `sed -i work/<unit>.md` walked around tool-only denies.
    expect(deny).toContain("Bash(* work/*)");
    expect(deny).toContain("Bash(*/work/*)");
    expect(deny).toContain("Bash(* context/contracts.md*)");
    expect(deny).toContain("Bash(* docs/program/*)");
    // The boundary keeps ordinary words out: "framework/" and "network/" both contain
    // the substring "work/" and must not be denied (the doctrine#5 lesson).
    expect(deny).not.toContain("Bash(*work/*)");
    // ...on top of the floor and the target's doors, which it never replaces.
    expect(deny).toContain("Bash(*git push*)");
    expect(deny).toContain("Edit(data/**)");
    expect(path.endsWith("claude-deny-review-fix.json")).toBe(true);
  });

  it("the general settings file is unchanged by the review-fix extras", () => {
    const arena = mkdtempSync(join(tmp, "deny2-"));
    const path = writeDenySettings(arena, { doors: [] });
    const deny = (JSON.parse(readFileSync(path, "utf8")) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).not.toContain("Edit(work/)");
    expect(deny.some((d) => d.includes("work/"))).toBe(false);
  });

  it("the engine's own guardrails are shell-proof, not just tool-proof", () => {
    // The manifest IS the target's containment. Denying only Edit and Write left it
    // one `sed -i` away from an agent, in every profile, since the floor was written.
    const arena = mkdtempSync(join(tmp, "deny3-"));
    const path = writeDenySettings(arena, { doors: [] });
    const deny = (JSON.parse(readFileSync(path, "utf8")) as { permissions: { deny: string[] } }).permissions.deny;
    for (const f of ["manifest.json", "claude-deny-settings.json", "claude-deny-review-fix.json", "directives.md", "pause", "ticks.jsonl", "metrics.jsonl"]) {
      expect(deny).toContain(`Edit(**/.doctrine/${f})`);
      expect(deny).toContain(`Write(**/.doctrine/${f})`);
      expect(deny).toContain(`Bash(*.doctrine/${f}*)`);
    }
    // Verdicts still land: .doctrine/runs is where the judge writes.
    expect(deny.some((d) => d.includes(".doctrine/runs"))).toBe(false);
  });
});

// --- the loop half: a tick that opens a PR and stops -------------------------

function makeArena(review: Record<string, unknown> | undefined): { arena: string; bare: string } {
  const bare = mkdtempSync(join(tmp, "origin-"));
  gitIn(bare, ["init", "-q", "--bare", "-b", "development"]);
  const arena = mkdtempSync(join(tmp, "arena-"));
  gitIn(arena, ["init", "-q", "-b", "development"]);
  mkdirSync(join(arena, ".doctrine"), { recursive: true });
  writeFileSync(
    join(arena, ".doctrine", "manifest.json"),
    JSON.stringify({ name: "t", base_branch: "development", doors: [], landing: "pr", ...(review !== undefined ? { review } : {}) }),
  );
  writeFileSync(join(arena, ".gitignore"), ".doctrine/lease/\n.doctrine/runs/\n.doctrine/canary-runs/\n");
  writeFileSync(join(arena, "app.txt"), "v1\n");
  mkdirSync(join(arena, "work", "intents"), { recursive: true });
  writeFileSync(join(arena, "work", "wu-r.md"), UNIT_MD);
  gitIn(arena, ["add", "-A"]);
  commit(arena, "seed");
  gitIn(arena, ["remote", "add", "origin", bare]);
  gitIn(arena, ["push", "-q", "-u", "origin", "development"]);
  return { arena, bare };
}

function okSpawn(logPath: string): SpawnRunResult {
  return {
    exitCode: 0, spawnFailed: false, signal: null, stdout: "", stderr: "",
    timedOut: false, outage: false, logPath,
    resultMessage: { total_cost_usd: 0.1 },
  } as unknown as SpawnRunResult;
}

function verdictFor(unitId: string): Verdict {
  return {
    unit: unitId, verdict: "pass", judged: true,
    coherence: [{ criterion: "scope", ok: true, quote: "q" }],
    evidence: [{ spec: "grep -q v2 app.txt", run: { command: "grep", exit_code: 0, output_sha256: "aa", log: "l" }, ok: true }],
    gates_executed: ["diff-read", "evidence-executed"],
    base_sha: "a", head_sha: "b", spend_usd: 0.4,
  };
}

/** An implementer that writes the change, and a judge that passes it. */
function agentPair(unitId: string): TickDeps["runAgent"] {
  return async (prompt: string, opts: { cwd: string; logPath: string }): Promise<SpawnRunResult> => {
    if (prompt.includes("verdict")) {
      const m = /verdict(?:Path)?[^\n]*?([A-Za-z]:[^\s"]+verdict\.json)/.exec(prompt);
      const path = m?.[1];
      if (path !== undefined) writeFileSync(path, JSON.stringify(verdictFor(unitId)));
    } else {
      writeFileSync(join(opts.cwd, "app.txt"), "v2\n");
      execFileSync("git", ["add", "-A"], { cwd: opts.cwd });
      execFileSync("git", ["-c", "user.name=i", "-c", "user.email=i@i", "commit", "-q", "-m", "feat: v2"], { cwd: opts.cwd });
    }
    writeFileSync(opts.logPath, "");
    return { exitCode: 0, spawnFailed: false, signal: null, stdout: "", stderr: "", timedOut: false, outage: false, logPath: opts.logPath, resultMessage: { total_cost_usd: 0.1 } } as unknown as SpawnRunResult;
  };
}

describe("the review rung — PR opens, the unit waits, nothing merges early", () => {
  it("with a review window the tick opens the PR and STOPS: status in-review, base untouched", async () => {
    const { arena, bare } = makeArena({ window_s: 300, max_rounds: 2 });
    const calls: string[][] = [];
    const gh: RunGhFn = (args) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "create") return "https://gh/pr/9";
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([{ number: 9, url: "https://gh/pr/9", createdAt: new Date().toISOString() }]);
      }
      if (args[0] === "repo" && args[1] === "view") return "o/r";
      if (args[0] === "api" && args[1] === "graphql") return THREAD_JSON([]);
      if (args[0] === "auth") return "ok";
      return "";
    };
    const deps: TickDeps = {
      arenaDir: arena,
      agentDefs: {
        implementer: join(arena, "impl.md"), judge: join(arena, "judge.md"),
        decomposer: join(arena, "dec.md"), planJudge: join(arena, "pj.md"),
      },
      runAgent: agentPair("wu-r"),
      runGh: gh,
    };
    for (const f of ["impl.md", "judge.md", "dec.md", "pj.md"]) writeFileSync(join(arena, f), "---\nname: x\n---\nlaw\n");

    const res = await tick(deps);
    expect(res.decision).toBe("pr-opened");

    // The unit says in-review, on its branch, and NOTHING merged.
    const branch = gitIn(arena, ["branch", "--list", "doctrine/wu-r-*"]).replace(/^\*?\s*/, "");
    expect(branch.length).toBeGreaterThan(0);
    const unitOnBranch = gitIn(arena, ["show", `${branch}:work/wu-r.md`]);
    expect(parseWorkUnit(unitOnBranch).ok && parseWorkUnit(unitOnBranch).ok).toBe(true);
    expect(unitOnBranch).toContain("status: in-review");
    expect(calls.some((c) => c[0] === "pr" && c[1] === "merge")).toBe(false);
    expect(gitIn(arena, ["show", "development:app.txt"])).toBe("v1");

    // The base checkout still says `ready` — that is exactly why the review rung reads
    // the unit off the BRANCH. A base-only read would never see this unit waiting,
    // and rung 0 would treat its branch as crashed work and open a second PR.
    expect(readFileSync(join(arena, "work", "wu-r.md"), "utf8")).toContain("status: ready");

    // Next tick: the unit is recognised as in-review, and the window has not elapsed,
    // so nothing merges and no second PR is created.
    calls.length = 0;
    const second = await tick(deps);
    expect(second.decision).toBe("no-op-review-window");
    expect(calls.some((c) => c[0] === "pr" && c[1] === "create")).toBe(false);
    expect(calls.some((c) => c[0] === "pr" && c[1] === "merge")).toBe(false);

    rmSync(bare, { recursive: true, force: true });
  }, 90_000);

  it("a unit that settled while nobody was landing it still reaches the ledger", async () => {
    // The recovery branch: the PR is gone from `pr list` because a tick died between the
    // remote merge and the local sync, or because a person merged it. The unit is marked
    // merged and the tick returns — and it used to return without writing a metric at
    // all, so the unit was absent from metrics.jsonl and its whole `pr-opened` spend was
    // invisible to the daily gate, permanently. #32 closed that on the path the loop
    // normally takes and left it open on the two it takes when something went sideways.
    const { arena, bare } = makeArena({ window_s: 300, max_rounds: 2 });
    let prOpen = true;
    const gh: RunGhFn = (args) => {
      if (args[0] === "pr" && args[1] === "create") return "https://gh/pr/9";
      if (args[0] === "pr" && args[1] === "list") {
        return prOpen ? JSON.stringify([{ number: 9, url: "https://gh/pr/9", createdAt: new Date().toISOString() }]) : "[]";
      }
      if (args[0] === "repo" && args[1] === "view") return "o/r";
      if (args[0] === "api" && args[1] === "graphql") return THREAD_JSON([]);
      if (args[0] === "auth") return "ok";
      return "";
    };
    const deps: TickDeps = {
      arenaDir: arena,
      agentDefs: {
        implementer: join(arena, "impl.md"), judge: join(arena, "judge.md"),
        decomposer: join(arena, "dec.md"), planJudge: join(arena, "pj.md"),
      },
      runAgent: agentPair("wu-r"),
      runGh: gh,
    };
    for (const f of ["impl.md", "judge.md", "dec.md", "pj.md"]) writeFileSync(join(arena, f), "---\nname: x\n---\nlaw\n");

    expect((await tick(deps)).decision).toBe("pr-opened");
    // The money is on the tick and nowhere else at this point — that is the whole shape
    // of the bug: metrics.jsonl is what the daily gate reads.
    const metricsBefore = existsSync(metricsPath(arena)) ? readFileSync(metricsPath(arena), "utf8") : "";
    expect(metricsBefore).not.toContain('"unit":"wu-r"');

    // Someone merged it: the branch's commits really are on the base now. That is what
    // makes this a settled MERGE rather than a PR that merely vanished.
    const branch = gitIn(arena, ["branch", "--list", "doctrine/wu-r-*"]).replace(/^\*?\s*/, "").trim();
    gitIn(arena, ["push", "-q", "origin", `${branch}:development`]);
    prOpen = false;
    expect((await tick(deps)).decision).toBe("review-settled-merged");

    const rows = readFileSync(metricsPath(arena), "utf8").trim().split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r["unit"] === "wu-r");
    expect(rows).toHaveLength(1);
    expect(rows[0]!["outcome"]).toBe("merged");
    // implementer 0.1 + judge 0.4, billed once, on the row the gate actually reads.
    expect(rows[0]!["spend_usd"]).toBeCloseTo(0.5, 5);
    expect(spendSince(arena, "1970-01-01T00:00:00.000Z")).toBeCloseTo(0.5, 5);

    rmSync(bare, { recursive: true, force: true });
  }, 90_000);

  it("a PR that vanished without merging is parked, never recorded as landed", async () => {
    // "No open PR" and "merged" are the same view from `findOpenPr`. Recording the
    // second when it is the first writes a landed row for code that is not on the base —
    // corrupting the ledger the daily gate reads, and stepping the spend cutoff past a
    // round that never landed.
    const { arena, bare } = makeArena({ window_s: 300, max_rounds: 2 });
    let prOpen = true;
    const gh: RunGhFn = (args) => {
      if (args[0] === "pr" && args[1] === "create") return "https://gh/pr/9";
      if (args[0] === "pr" && args[1] === "list") {
        return prOpen ? JSON.stringify([{ number: 9, url: "https://gh/pr/9", createdAt: new Date().toISOString() }]) : "[]";
      }
      if (args[0] === "repo" && args[1] === "view") return "o/r";
      if (args[0] === "api" && args[1] === "graphql") return THREAD_JSON([]);
      if (args[0] === "auth") return "ok";
      return "";
    };
    const deps: TickDeps = {
      arenaDir: arena,
      agentDefs: {
        implementer: join(arena, "impl.md"), judge: join(arena, "judge.md"),
        decomposer: join(arena, "dec.md"), planJudge: join(arena, "pj.md"),
      },
      runAgent: agentPair("wu-r"),
      runGh: gh,
    };
    for (const f of ["impl.md", "judge.md", "dec.md", "pj.md"]) writeFileSync(join(arena, f), "---\nname: x\n---\nlaw\n");

    expect((await tick(deps)).decision).toBe("pr-opened");
    // The PR closes with nothing merged — the base never moves.
    prOpen = false;
    const res = await tick(deps);
    expect(res.decision).toBe("parked");
    expect(res.detail).toContain("never landed");

    // The unit is the observer's problem, and NOT recorded as landed.
    expect(readFileSync(join(arena, "work", "wu-r.md"), "utf8")).toContain("status: escalated");
    const rows = readFileSync(metricsPath(arena), "utf8").trim().split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r["unit"] === "wu-r");
    expect(rows).toHaveLength(1);
    expect(rows[0]!["outcome"]).toBe("escalated");
    // Still billed: the money went whether or not the work landed, and an escalated
    // unit is nobody's retry, so this is its only chance to reach the gate.
    expect(rows[0]!["spend_usd"]).toBeCloseTo(0.5, 5);
    expect(gitIn(arena, ["show", "development:app.txt"])).toBe("v1");

    rmSync(bare, { recursive: true, force: true });
  }, 90_000);

  it("a deferral is written to the BASE branch, where no reap can reach it", async () => {
    // Recording it on the unit branch was one reap away from losing it all over again:
    // the amended branch still has to survive re-judgement, judgeAndLand reaps it on a
    // failing verdict, and the GitHub threads are resolved by then — so the record would
    // go with the branch and the finding would be closed everywhere (doctrine#28 review).
    const { arena, bare } = makeArena({ window_s: 0, max_rounds: 2 });
    const gh: RunGhFn = (args) => {
      if (args[0] === "pr" && args[1] === "create") return "https://gh/pr/9";
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([{ number: 9, url: "https://gh/pr/9", createdAt: new Date(0).toISOString() }]);
      }
      if (args[0] === "repo" && args[1] === "view") return "o/r";
      if (args[0] === "api" && args[1] === "graphql") {
        return THREAD_JSON([{
          id: "T1", isResolved: false,
          comments: { nodes: [{ databaseId: 1, path: "src/db/migrate.ts", line: 21, author: { login: "codex" }, body: "migrations are not copied into dist/" }] },
        }]);
      }
      if (args[0] === "auth") return "ok";
      return "";
    };
    for (const f of ["impl.md", "judge.md", "dec.md", "pj.md", "fixer.md"]) {
      writeFileSync(join(arena, f), "---\nname: x\n---\nlaw\n");
    }
    const agentDefs = {
      implementer: join(arena, "impl.md"), judge: join(arena, "judge.md"),
      decomposer: join(arena, "dec.md"), planJudge: join(arena, "pj.md"),
      reviewFixer: join(arena, "fixer.md"),
    };

    expect((await tick({ arenaDir: arena, agentDefs, runAgent: agentPair("wu-r"), runGh: gh })).decision).toBe("pr-opened");

    // A mixed pass: it fixes something AND declares a deferral, which is the common
    // shape and the one the whole-run outcome type could not express.
    const mixedFixer: TickDeps["runAgent"] = async (prompt, opts) => {
      writeFileSync(opts.logPath, "");
      if (prompt.includes("verdict")) {
        const m = /verdict(?:Path)?[^\n]*?([A-Za-z]:[^\s"]+verdict\.json)/.exec(prompt);
        if (m?.[1] !== undefined) writeFileSync(m[1], JSON.stringify(verdictFor("wu-r")));
        return okSpawn(opts.logPath);
      }
      writeFileSync(join(opts.cwd, "app.txt"), "v3\n");
      execFileSync("git", ["add", "-A"], { cwd: opts.cwd });
      execFileSync("git", [
        "-c", "user.name=f", "-c", "user.email=f@f", "commit", "-q", "-m",
        "fix: the real defect\n\nDeferred-to-intake: migrations are not copied into dist/, belongs with the build script",
      ], { cwd: opts.cwd });
      return okSpawn(opts.logPath);
    };
    await tick({ arenaDir: arena, agentDefs, runAgent: mixedFixer, runGh: gh });

    // On the base branch, committed — not merely present in a worktree, and not on the
    // unit branch where a reap would take it.
    const onBase = gitIn(arena, ["show", "development:context/review-findings/wu-r-deferred.md"]);
    expect(onBase).toContain("migrations are not copied into dist/");
    expect(onBase).toContain("maintenance unit");

    rmSync(bare, { recursive: true, force: true });
  }, 90_000);

  it("a failed review-fix leaves the branch where the judge left it", async () => {
    // Narrowing the review-fix guardrail to `preFixSha..headSha` made a contaminated
    // baseline dangerous, and a failed attempt is how one appears: a fixer that commits
    // a forbidden `work/` edit and THEN times out leaves that tip in place, the next
    // tick reads it as `preFixSha`, and the planning edit now sits before the window the
    // guardrail looks at. A later successful attempt lands it, unexamined, because the
    // branch-wide pass no longer carries the review-fix rules (doctrine#26 review).
    const { arena, bare } = makeArena({ window_s: 0, max_rounds: 2 });
    const gh: RunGhFn = (args) => {
      if (args[0] === "pr" && args[1] === "create") return "https://gh/pr/9";
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([{ number: 9, url: "https://gh/pr/9", createdAt: new Date(0).toISOString() }]);
      }
      if (args[0] === "repo" && args[1] === "view") return "o/r";
      if (args[0] === "api" && args[1] === "graphql") {
        return THREAD_JSON([{
          id: "T1", isResolved: false,
          comments: { nodes: [{ databaseId: 1, path: "src/core/ids.ts", line: 41, author: { login: "codex" }, body: "guard each intermediate accumulation" }] },
        }]);
      }
      if (args[0] === "auth") return "ok";
      return "";
    };
    for (const f of ["impl.md", "judge.md", "dec.md", "pj.md", "fixer.md"]) {
      writeFileSync(join(arena, f), "---\nname: x\n---\nlaw\n");
    }
    const agentDefs = {
      implementer: join(arena, "impl.md"), judge: join(arena, "judge.md"),
      decomposer: join(arena, "dec.md"), planJudge: join(arena, "pj.md"),
      reviewFixer: join(arena, "fixer.md"),
    };

    // Tick 1: build it, judge it, open the PR.
    expect((await tick({ arenaDir: arena, agentDefs, runAgent: agentPair("wu-r"), runGh: gh })).decision).toBe("pr-opened");
    const branch = gitIn(arena, ["branch", "--list", "doctrine/wu-r-*"]).replace(/^\*?\s*/, "");
    const judgedHead = gitIn(arena, ["rev-parse", branch]);

    // Tick 2: a fixer that commits a forbidden planning edit and then fails.
    const badFixer: TickDeps["runAgent"] = async (prompt, opts) => {
      writeFileSync(opts.logPath, "");
      if (prompt.includes("verdict")) return okSpawn(opts.logPath);
      writeFileSync(join(opts.cwd, "work", "wu-r.md"), "---\nid: wu-r\n---\nrewritten by the fixer\n");
      execFileSync("git", ["add", "-A"], { cwd: opts.cwd });
      execFileSync("git", ["-c", "user.name=f", "-c", "user.email=f@f", "commit", "-q", "-m", "fix: also re-plan the unit"], { cwd: opts.cwd });
      // ...and then dies, exactly as a timeout or a budget truncation would.
      return { exitCode: 1, spawnFailed: false, signal: null, stdout: "", stderr: "killed", timedOut: true, outage: false, logPath: opts.logPath, resultMessage: undefined } as unknown as SpawnRunResult;
    };
    const res = await tick({ arenaDir: arena, agentDefs, runAgent: badFixer, runGh: gh });
    expect(res.decision).toBe("review-fix-failed");

    // The forbidden commit is gone and the tip is the judged head again, so the NEXT
    // attempt's baseline is the one the judge approved.
    expect(gitIn(arena, ["rev-parse", branch])).toBe(judgedHead);
    expect(gitIn(arena, ["log", "--oneline", branch])).not.toContain("re-plan the unit");
    expect(gitIn(arena, ["show", `${branch}:work/wu-r.md`])).not.toContain("rewritten by the fixer");

    rmSync(bare, { recursive: true, force: true });
  }, 90_000);

  it("a failed gh lookup never reads as 'merged' — the tick retries instead", async () => {
    const { arena, bare } = makeArena({ window_s: 0, max_rounds: 2 });
    let failLookups = false;
    const gh: RunGhFn = (args) => {
      if (args[0] === "pr" && args[1] === "create") return "https://gh/pr/9";
      if (args[0] === "pr" && args[1] === "list") {
        if (failLookups) throw new Error("gh: could not connect to github.com");
        return JSON.stringify([{ number: 9, url: "https://gh/pr/9", createdAt: new Date(0).toISOString() }]);
      }
      if (args[0] === "repo" && args[1] === "view") return "o/r";
      if (args[0] === "api" && args[1] === "graphql") return THREAD_JSON([]);
      return "";
    };
    const deps: TickDeps = {
      arenaDir: arena,
      agentDefs: {
        implementer: join(arena, "impl.md"), judge: join(arena, "judge.md"),
        decomposer: join(arena, "dec.md"), planJudge: join(arena, "pj.md"),
      },
      runAgent: agentPair("wu-r"),
      runGh: gh,
    };
    for (const f of ["impl.md", "judge.md", "dec.md", "pj.md"]) writeFileSync(join(arena, f), "---\nname: x\n---\nlaw\n");

    expect((await tick(deps)).decision).toBe("pr-opened");
    const branchBefore = gitIn(arena, ["branch", "--list", "doctrine/wu-r-*"]).replace(/^\*?\s*/, "");

    failLookups = true;
    const res = await tick(deps);
    expect(res.decision).toBe("no-op-review-lookup-failed");
    // The branch survives: the unit was NOT declared settled on a failed read.
    expect(gitIn(arena, ["branch", "--list", "doctrine/wu-r-*"]).replace(/^\*?\s*/, "")).toBe(branchBefore);
    rmSync(bare, { recursive: true, force: true });
  }, 90_000);
});

describe("a deferral has to survive the thread being resolved", () => {
  it("reads Deferred-to-intake trailers out of the answer, mixed outcome included", () => {
    // A shape seen on a real PR: two findings fixed, one argued as belonging to a unit
    // that does not exist yet. The argument was right and it was filed by nobody —
    // `recordUnaddressed` fires only on threads still OPEN at round exhaustion, and the
    // fixer had answered and resolved all three.
    const message = [
      "db: close the guard's string-literal bypass and create the parent directory",
      "",
      "1. open.ts:64 — comments hiding executable statements. Fixed.",
      "2. open.ts:172 — parent directory. Fixed.",
      "3. migrate.ts:21 — migrations under dist/. Correct, but not this unit.",
      "",
      "Deferred-to-intake: migrations are not copied into dist/, so npm start dies in readdirSync — belongs with the build script",
      "Co-Authored-By: someone <x@y>",
    ].join("\n");
    expect(deferredFrom(message)).toEqual([
      "migrations are not copied into dist/, so npm start dies in readdirSync — belongs with the build script",
    ]);
  });

  it("takes several, de-duplicates, and is not fooled by prose that merely mentions it", () => {
    const message = [
      "Deferred-to-intake: the build step",
      "I considered writing Deferred-to-intake: something here but that is mid-sentence.",
      "  Deferred-to-intake:   the build step  ",
      "Deferred-to-intake: the other thing",
    ].join("\n");
    // Only line-initial trailers count, and the repeat collapses.
    expect(deferredFrom(message)).toEqual(["the build step", "the other thing"]);
  });

  it("finds none when the fixer declared none", () => {
    expect(deferredFrom("db: fix the thing\n\nAll three findings were defects here.")).toEqual([]);
    expect(deferredFrom("")).toEqual([]);
  });
});

describe("the judge is not shown the engine's own bookkeeping", () => {
  it("keeps decisions.md and the unit file out of the diff a RE-judge grades", async () => {
    // Observed on a target. openUnitPr flips the unit to `in-review` and appends to
    // context/decisions.md — "Judged pass at <sha> ($8.66); PR ... open for review" — committing
    // both on the unit's own branch. On the RE-judge after a review fix those lines sit in
    // base..head, and the code judge correctly failed the unit on `coherence: contamination` for a
    // change it did not author. $16, and nondeterministic: two earlier units carried the same lines
    // and were not flagged, which is worse than a reliable failure because it reads as a flaky judge.
    //
    // The first judge cannot show this — the bookkeeping does not exist yet — so the cycle has to
    // run all the way to the second one.
    const { arena, bare } = makeArena({ window_s: 0, max_rounds: 2 });
    const gh: RunGhFn = (args) => {
      if (args[0] === "pr" && args[1] === "create") return "https://gh/pr/9";
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([{ number: 9, url: "https://gh/pr/9", createdAt: new Date(0).toISOString() }]);
      }
      if (args[0] === "repo" && args[1] === "view") return "o/r";
      if (args[0] === "api" && args[1] === "graphql") {
        return THREAD_JSON([{
          id: "T1", isResolved: false,
          comments: { nodes: [{ databaseId: 1, path: "app.txt", line: 1, author: { login: "codex" }, body: "make it v3" }] },
        }]);
      }
      if (args[0] === "auth") return "ok";
      return "";
    };
    for (const f of ["impl.md", "judge.md", "dec.md", "pj.md", "fixer.md"]) {
      writeFileSync(join(arena, f), "---\nname: x\n---\nlaw\n");
    }
    const agentDefs = {
      implementer: join(arena, "impl.md"), judge: join(arena, "judge.md"),
      decomposer: join(arena, "dec.md"), planJudge: join(arena, "pj.md"),
      reviewFixer: join(arena, "fixer.md"),
    };

    // Tick 1: build, judge, open the PR — the engine writes its bookkeeping here.
    expect((await tick({ arenaDir: arena, agentDefs, runAgent: agentPair("wu-r"), runGh: gh })).decision).toBe("pr-opened");
    const before = readdirSync(join(arena, ".doctrine", "runs")).length;

    // Tick 2: window elapsed with one finding — fixer runs, then the RE-judge.
    const fixer: TickDeps["runAgent"] = async (prompt, opts) => {
      if (prompt.includes("verdict")) return agentPair("wu-r")!(prompt, opts);
      writeFileSync(join(opts.cwd, "app.txt"), "v3\n");
      execFileSync("git", ["add", "-A"], { cwd: opts.cwd });
      execFileSync("git", ["-c", "user.name=f", "-c", "user.email=f@f", "commit", "-q", "-m", "fix: v3"], { cwd: opts.cwd });
      writeFileSync(opts.logPath, "");
      return { exitCode: 0, spawnFailed: false, signal: null, stdout: "", stderr: "", timedOut: false, outage: false, logPath: opts.logPath, resultMessage: { total_cost_usd: 0.1 } } as unknown as SpawnRunResult;
    };
    await tick({ arenaDir: arena, agentDefs, runAgent: fixer, runGh: gh });

    // The newest run dir is the re-judge's. Its diff is what the judge was handed.
    const dirs = readdirSync(join(arena, ".doctrine", "runs")).filter((d: string) => d.startsWith("wu-r")).sort();
    expect(dirs.length).toBeGreaterThan(before - 1);
    const patch = readFileSync(join(arena, ".doctrine", "runs", dirs[dirs.length - 1]!, "diff.patch"), "utf8");

    // The engine's own commits are absent…
    expect(patch).not.toContain("context/decisions.md");
    expect(patch).not.toContain("work/wu-r.md");
    // …and the unit's work is still there.
    expect(patch).toContain("app.txt");

    rmSync(bare, { recursive: true, force: true });
  }, 90_000);
});

describe("an outage during a re-judge must not become a merge", () => {
  // The one thing the loop must never do is merge code no judge ruled on, and this is the
  // path that did it. After a code-changing review fix, `judgeAndLand` runs; an API outage
  // there keeps the branch and returns with no verdict written. The unit file on that
  // branch still says `in-review`, and the fixer has already resolved every thread — so
  // the next tick finds nothing unresolved, sees the window elapsed, and merges an
  // amendment nothing verified.
  //
  // Found by review on the promotion PR (doctrine#55), fixed in #59 — and landed without
  // these, which is the gap they close.

  function reviewedArena(): { arena: string; gh: RunGhFn; deps: TickDeps } {
    const { arena } = makeArena({ window_s: 0, max_rounds: 2 });
    const gh: RunGhFn = (args) => {
      if (args[0] === "pr" && args[1] === "create") return "https://gh/pr/9";
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([{ number: 9, url: "https://gh/pr/9", createdAt: new Date(0).toISOString() }]);
      }
      if (args[0] === "repo" && args[1] === "view") return "o/r";
      if (args[0] === "api" && args[1] === "graphql") return THREAD_JSON([]);
      if (args[0] === "auth") return "ok";
      return "";
    };
    for (const f of ["impl.md", "judge.md", "dec.md", "pj.md"]) writeFileSync(join(arena, f), "---\nname: x\n---\nlaw\n");
    const deps: TickDeps = {
      arenaDir: arena,
      agentDefs: {
        implementer: join(arena, "impl.md"), judge: join(arena, "judge.md"),
        decomposer: join(arena, "dec.md"), planJudge: join(arena, "pj.md"),
      },
      runAgent: agentPair("wu-r"),
      runGh: gh,
    };
    return { arena, gh, deps };
  }

  it("judges the amendment instead of merging it", async () => {
    const { arena, deps } = reviewedArena();
    // Open the PR the normal way, so the branch and its `in-review` status are real.
    expect((await tick(deps)).decision).toBe("pr-opened");

    // A code-changing review fix, and then nothing: no `pr-opened` follows it, which is
    // exactly what an outage during the re-judge leaves behind.
    appendTick(arena, {
      decision: "review-fixed", unit: "wu-r", spend_usd: 2,
      detail: "1 finding(s) addressed at abc12345",
      // The BRANCH tip before the fixer ran, which is what production records. Using
      // development's HEAD makes the guardrail measure the unit's whole diff — including
      // the `work/**` status flip that `openUnitPr` commits — and call it a breach.
      pre_fix_sha: gitIn(arena, ["rev-parse", gitIn(arena, ["branch", "--list", "doctrine/wu-r-*"]).replace(/^[*+]?\s*/, "")]),
    });

    // Asserting the ABSENCE of a merge is not enough: a regression that spots the owed
    // amendment and then returns a permanent no-op, outage or park would satisfy it, and
    // the loop would stall on every reviewed unit instead of merging unjudged ones. So
    // assert what the fix promises — the judge ran and republished the branch.
    const res = await tick(deps);
    expect(res.decision).toBe("pr-opened");
    expect(gitIn(arena, ["show", "development:app.txt"])).toBe("v1");
  });

  it("but merges normally when a judge DID rule — the gate is the amendment, not review", async () => {
    const { arena, deps } = reviewedArena();
    expect((await tick(deps)).decision).toBe("pr-opened");

    // `pr-opened` AFTER the fix is the engine's own record that a judge ruled favourably
    // and republished the branch. Nothing is owed, so the ordinary merge stands and the
    // gate cannot be accused of stalling every reviewed unit.
    appendTick(arena, {
      decision: "review-fixed", unit: "wu-r", spend_usd: 2,
      detail: "1 finding(s) addressed at abc12345",
      // The BRANCH tip before the fixer ran, which is what production records. Using
      // development's HEAD makes the guardrail measure the unit's whole diff — including
      // the `work/**` status flip that `openUnitPr` commits — and call it a breach.
      pre_fix_sha: gitIn(arena, ["rev-parse", gitIn(arena, ["branch", "--list", "doctrine/wu-r-*"]).replace(/^[*+]?\s*/, "")]),
    });
    appendTick(arena, { decision: "pr-opened", unit: "wu-r", detail: "https://gh/pr/9" });

    const res = await tick(deps);
    expect(["landed", "review-settled-merged"]).toContain(res.decision);
  });

  it("a review fix that changed NOTHING owes no judge — there is nothing new to rule on", async () => {
    const { arena, deps } = reviewedArena();
    expect((await tick(deps)).decision).toBe("pr-opened");

    // The no-change path answers a finding in prose and opens no PR. Treating it as an
    // unjudged amendment would stall every argued refusal forever.
    appendTick(arena, {
      decision: "review-fixed", unit: "wu-r", spend_usd: 2,
      detail: "answered without a code change",
    });

    const res = await tick(deps);
    expect(["landed", "review-settled-merged"]).toContain(res.decision);
  });
});

