import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { tick, type TickDeps } from "../src/dispatch.js";
import type { RunAgentFn } from "../src/judge.js";
import type { SpawnRunResult } from "../src/spawn.js";

/**
 * The implementation rung's correction pass, end to end and offline.
 *
 * **Why this file exists separately.** `dispatch.test.ts` covers the rung as it was, and
 * every one of its cases configures no `unitFixer` — so they all take the fallback and
 * pass unchanged, which is correct and proves nothing about the new path. Four hundred
 * and twenty green tests is the shape of a change that has never executed.
 *
 * What is under test is one claim: **a judge finding no longer destroys the branch.** The
 * diff the judge read is the most expensive artifact this loop produces — $271 of $1,123
 * on one target went to work deleted on a failing verdict — and it is now corrected in
 * place, by a pass that gets the complete list of what is wrong with it.
 */

const tmp = mkdtempSync(join(tmpdir(), "doctrine-unit-fix-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const AGENTS = {
  implementer: fileURLToPath(new URL("../../.claude/agents/implementer.md", import.meta.url)),
  judge: fileURLToPath(new URL("../../.claude/agents/code-judge.md", import.meta.url)),
  unitFixer: fileURLToPath(new URL("../../.claude/agents/unit-fixer.md", import.meta.url)),
};

const UNIT = `---
id: wu-x
title: Bump marker to v2
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

function makeArena(gates?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmp, "arena-"));
  gitIn(dir, ["init", "-b", "development"]);
  mkdirSync(join(dir, ".doctrine"), { recursive: true });
  writeFileSync(join(dir, ".doctrine", "manifest.json"), JSON.stringify({
    name: "t", base_branch: "development", doors: [],
    ...(gates !== undefined ? { gates } : {}),
  }));
  writeFileSync(join(dir, ".gitignore"), ".doctrine/lease/\n.doctrine/runs/\n.doctrine/canary-runs/\n");
  writeFileSync(join(dir, "app.txt"), "v1\n");
  mkdirSync(join(dir, "work", "intents"), { recursive: true });
  writeFileSync(join(dir, "work", "wu-x.md"), UNIT);
  gitIn(dir, ["add", "-A"]);
  commit(dir, "seed");
  return dir;
}

const okSpawn = (cost = 0.3): SpawnRunResult => ({
  spawnFailed: false, exitCode: 0, signal: null, timedOut: false, outage: false,
  logPath: "x", resultMessage: { type: "result", subtype: "success", total_cost_usd: cost },
});

/** Prompts the correction pass was handed, for asserting what it was told. */
let fixPrompts: string[] = [];
beforeEach(() => { fixPrompts = []; });

interface Script {
  /** What the implementer writes into app.txt. Default "v2" — which satisfies the evidence. */
  implement?: string;
  /** The judge's verdict. Default: a pass. */
  verdict?: (baseSha: string, headSha: string) => unknown;
  /** What the correction pass does in its worktree. Omitted = it changes nothing. */
  fix?: (cwd: string) => void;
}

function agents(script: Script = {}): RunAgentFn {
  return async (prompt, opts) => {
    if (prompt.includes("# Your unit")) {
      writeFileSync(join(opts.cwd, "app.txt"), `${script.implement ?? "v2"}\n`);
      gitIn(opts.cwd, ["add", "-A"]);
      commit(opts.cwd, "feat: implemented");
      return okSpawn(0.5);
    }
    if (prompt.includes("write the verdict JSON to EXACTLY:")) {
      const verdictPath = /write the verdict JSON to EXACTLY: (.+)/.exec(prompt)![1]!.trim();
      const baseSha = /base_sha: (\S+)/.exec(prompt)![1]!;
      const headSha = /head_sha: (\S+)/.exec(prompt)![1]!;
      const pass = {
        unit: "wu-x", verdict: "pass", judged: true,
        coherence: [{ criterion: "scope", ok: true, quote: "app.txt only" }],
        evidence: [{ spec: "grep -q v2 app.txt", run: { command: "grep -q v2 app.txt", exit_code: 0, output_sha256: "aa", log: "evidence-0.log" }, ok: true }],
        gates_executed: ["diff-read", "evidence-executed"],
        base_sha: baseSha, head_sha: headSha, spend_usd: 0.3,
      };
      writeFileSync(verdictPath, JSON.stringify(script.verdict ? script.verdict(baseSha, headSha) : pass));
      return okSpawn(0.3);
    }
    if (prompt.includes("# The unit") && prompt.includes("What the judge found")) {
      fixPrompts.push(prompt);
      script.fix?.(opts.cwd);
      return okSpawn(0.2);
    }
    throw new Error(`unexpected agent prompt: ${prompt.slice(0, 120)}`);
  };
}

const FAILING_VERDICT = (baseSha: string, headSha: string): unknown => ({
  unit: "wu-x", verdict: "fail", judged: true,
  coherence: [{ criterion: "the marker reads v2", ok: false }],
  evidence: [{ spec: "grep -q v2 app.txt", run: { command: "grep -q v2 app.txt", exit_code: 1, output_sha256: "bb", log: "evidence-0.log" }, ok: false }],
  gates_executed: ["diff-read", "evidence-executed"],
  base_sha: baseSha, head_sha: headSha, spend_usd: 0.3,
});

function deps(arenaDir: string, runAgent: RunAgentFn, withFixer = true): TickDeps {
  const defs: Record<string, string> = { implementer: AGENTS.implementer, judge: AGENTS.judge };
  if (withFixer) defs["unitFixer"] = AGENTS.unitFixer;
  return { arenaDir, agentDefs: defs, runAgent } as unknown as TickDeps;
}

describe("a judge finding is corrected on the branch, not rebuilt from nothing", () => {
  it("the branch SURVIVES a failing verdict and the fix lands", async () => {
    // The whole change, in one case. Before this, a failing verdict called `reapBranch`
    // — `git branch -D` — and the next tick built the unit again from base.
    const arena = makeArena();
    const out = await tick(deps(arena, agents({
      implement: "WRONG",
      verdict: FAILING_VERDICT,
      fix: (cwd) => {
        writeFileSync(join(cwd, "app.txt"), "v2\n");
        gitIn(cwd, ["add", "-A"]);
        commit(cwd, "fix: the marker now reads v2");
      },
    })));

    expect(out.decision).toBe("landed");
    expect(readFileSync(join(arena, "app.txt"), "utf8").trim()).toBe("v2");
    expect(readFileSync(join(arena, "work", "wu-x.md"), "utf8")).toContain("status: merged");
  });

  it("the fixer is handed the judge's findings, in words it can act on", async () => {
    const arena = makeArena();
    await tick(deps(arena, agents({
      implement: "WRONG",
      verdict: FAILING_VERDICT,
      fix: (cwd) => {
        writeFileSync(join(cwd, "app.txt"), "v2\n");
        gitIn(cwd, ["add", "-A"]);
        commit(cwd, "fix: v2");
      },
    })));

    expect(fixPrompts).toHaveLength(1);
    const p = fixPrompts[0]!;
    // The coherence criterion, in the judge's words.
    expect(p).toContain("the marker reads v2");
    // The evidence spec, what the unit expected of it, and that it is the complete list.
    expect(p).toContain("grep -q v2 app.txt");
    expect(p).toContain("exit 0 on head");
    expect(p).toContain("this is the complete list");
    // And the standing rule that makes a correction pass safe.
    expect(p).toContain("still binding after your fix");
  });

  it("the judge is asked ONCE — the cost of a unit is bounded", async () => {
    // The property the change is for. A re-judge after the fix would be the unbounded
    // loop, at roughly nine dollars a turn with a fresh chance to find something new.
    // What speaks for the corrected tree is the FREE re-check.
    const arena = makeArena();
    let judgeSpawns = 0;
    const inner = agents({
      implement: "WRONG",
      verdict: FAILING_VERDICT,
      fix: (cwd) => {
        writeFileSync(join(cwd, "app.txt"), "v2\n");
        gitIn(cwd, ["add", "-A"]);
        commit(cwd, "fix: v2");
      },
    });
    const out = await tick(deps(arena, async (prompt, opts) => {
      if (prompt.includes("write the verdict JSON to EXACTLY:")) judgeSpawns += 1;
      return inner(prompt, opts);
    }));

    expect(out.decision).toBe("landed");
    expect(judgeSpawns).toBe(1);
    expect(fixPrompts).toHaveLength(1);
  });

  it("a correction that does NOT satisfy the evidence is refused by the free re-check", async () => {
    // The asymmetry that makes one judge pass safe. The paid judge is not asked again;
    // the unit's own evidence is deterministic and free, so it is re-run on the corrected
    // tree and it is what decides. Here the fixer changed something and the marker still
    // does not read v2.
    const arena = makeArena();
    const out = await tick(deps(arena, agents({
      implement: "WRONG",
      verdict: FAILING_VERDICT,
      fix: (cwd) => {
        writeFileSync(join(cwd, "app.txt"), "STILL WRONG\n");
        gitIn(cwd, ["add", "-A"]);
        commit(cwd, "fix: not really");
      },
    })));

    expect(out.decision).toBe("checks-failed");
    // It did not land, and the working tree is untouched.
    expect(readFileSync(join(arena, "app.txt"), "utf8").trim()).toBe("v1");
  });

  it("a failing GATE is a finding too, and the gates are actually run", async () => {
    // `manifest.gates` had been documentary since onboarding: the UI admissibility check
    // read its KEYS to decide whether a design gate existed and nothing ever ran the
    // command. A declared gate nobody runs is a comment.
    const arena = makeArena({ marker: "grep -q APPROVED app.txt" });
    await tick(deps(arena, agents({
      implement: "v2",
      fix: (cwd) => {
        writeFileSync(join(cwd, "app.txt"), "v2 APPROVED\n");
        gitIn(cwd, ["add", "-A"]);
        commit(cwd, "fix: approved");
      },
    })));

    expect(fixPrompts).toHaveLength(1);
    expect(fixPrompts[0]!).toContain("gate `marker` failed");
    expect(fixPrompts[0]!).toContain("grep -q APPROVED app.txt");
  });

  it("a green unit costs no correction pass at all", async () => {
    // Two spawns, not three. The common case must not become the expensive one.
    const arena = makeArena();
    const out = await tick(deps(arena, agents()));
    expect(out.decision).toBe("landed");
    expect(fixPrompts).toHaveLength(0);
  });

  it("what the fixer could not fix becomes INTAKE, on the base branch", async () => {
    // The operator's rule: if something cannot be fixed, it becomes a ticket. The fixer
    // declares it with a `Deferred-to-intake:` trailer and the engine records it where
    // intake reads — the same artifact the review rung writes, because "a finding nobody
    // can fix here" is one thing whoever found it.
    //
    // On the BASE branch deliberately: the unit still has landing and external review in
    // front of it, and a record that dies with the branch is a finding closed everywhere.
    const arena = makeArena();
    await tick(deps(arena, agents({
      implement: "WRONG",
      verdict: FAILING_VERDICT,
      fix: (cwd) => {
        writeFileSync(join(cwd, "app.txt"), "v2\n");
        gitIn(cwd, ["add", "-A"]);
        commit(cwd, "fix: v2\n\nDeferred-to-intake: the criterion also implies a version bump, which is not this unit's scope");
      },
    })));

    const path = join(arena, "context", "review-findings", "wu-x-deferred.md");
    expect(existsSync(path), "a deferred finding must never be silently dropped").toBe(true);
    expect(readFileSync(path, "utf8")).toContain("not this unit's scope");
    expect(readFileSync(path, "utf8")).toContain("maintenance unit for intake");
  });

  it("a correction pass that changed NOTHING and declared nothing may not land", async () => {
    // The case the free checks cannot see, and the worst one available here.
    //
    // The findings are COHERENCE — the gates and evidence were already green before the
    // fixer ran and are still green after it. So the post-check goes green, every finding
    // is recorded as "corrected", and a diff the judge refused lands. Nothing verifies a
    // semantic finding — that is exactly why a judge was needed for it — so the pass's own
    // declaration is the only evidence there is, and silence is not evidence.
    //
    // The narrowing and intent rungs have had this guard since the day they got their
    // correction passes. This one was written without it.
    const arena = makeArena();
    const out = await tick(deps(arena, agents({
      implement: "v2",
      verdict: (baseSha, headSha) => ({
        unit: "wu-x", verdict: "fail", judged: true,
        // Not ok, with the EVIDENCE passing — so every free check is green either way.
        coherence: [{ criterion: "the diff also rewrites an unrelated helper", ok: false }],
        evidence: [{ spec: "grep -q v2 app.txt", run: { command: "grep -q v2 app.txt", exit_code: 0, output_sha256: "aa", log: "e.log" }, ok: true }],
        gates_executed: ["diff-read", "evidence-executed"],
        base_sha: baseSha, head_sha: headSha, spend_usd: 0.3,
      }),
      // The fixer commits nothing and says nothing.
    })));

    expect(out.decision).toBe("unit-fix-empty");
    expect(readFileSync(join(arena, "work", "wu-x.md"), "utf8")).not.toContain("status: merged");
  });

  it("...but a no-change pass that DECLARES what it left lands, and the ticket is filed", async () => {
    // The honest version of the same result: the fixer judged the finding wrong or out of
    // scope, said so, and the engine files it as intake. That is a decision with a record,
    // which is the whole difference.
    const arena = makeArena();
    const out = await tick(deps(arena, agents({
      implement: "v2",
      verdict: (baseSha, headSha) => ({
        unit: "wu-x", verdict: "fail", judged: true,
        coherence: [{ criterion: "the diff also rewrites an unrelated helper", ok: false }],
        evidence: [{ spec: "grep -q v2 app.txt", run: { command: "grep -q v2 app.txt", exit_code: 0, output_sha256: "aa", log: "e.log" }, ok: true }],
        gates_executed: ["diff-read", "evidence-executed"],
        base_sha: baseSha, head_sha: headSha, spend_usd: 0.3,
      }),
      fix: (cwd) => {
        // An empty commit: the branch moves, and the message carries the declaration.
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty",
          "-m", ["no code change", "", "Deferred-to-intake: the helper predates this unit and is not its scope"].join(String.fromCharCode(10))], { cwd });
      },
    })));

    expect(out.decision).toBe("landed");
    const path = join(arena, "context", "review-findings", "wu-x-deferred.md");
    expect(readFileSync(path, "utf8")).toContain("predates this unit");
  });

  it("`escalate` still stops the unit — no edit to a diff can fix its spec", async () => {
    // The one verdict a correction pass cannot answer: it says the UNIT SPEC is the
    // defect — evidence no implementation could satisfy, criteria that contradict each
    // other — and the fault is one rung up.
    const arena = makeArena();
    const out = await tick(deps(arena, agents({
      verdict: (baseSha, headSha) => ({
        unit: "wu-x", verdict: "escalate", judged: true,
        // It has to name something that did not pass: `validateVerdict` refuses an
        // escalate whose every entry passes, because that is a `pass` wearing a
        // different word and it would park a unit permanently on nothing.
        coherence: [{ criterion: "scope", ok: true, quote: "app.txt only" }],
        evidence: [{ spec: "grep -q v2 app.txt", run: { command: "grep -q v2 app.txt", exit_code: 1, output_sha256: "aa", log: "e.log" }, ok: false }],
        gates_executed: ["diff-read", "evidence-executed"],
        base_sha: baseSha, head_sha: headSha, spend_usd: 0.3,
        // All three fields, because `validateVerdict` requires them: `reason` and
        // `detail` carry the argument, and `escape_hatches_closed` is where a judge shows
        // it considered the readings that would make the unit buildable after all.
        escalation: {
          reason: "the evidence spec cannot be satisfied",
          detail: "spec 0 holds two conjuncts no implementation satisfies at once",
          escape_hatches_closed: "both alternative readings of the criterion were tried and both are closed",
        },
      }),
    })));

    expect(out.decision).toBe("verdict-escalate");
    expect(fixPrompts).toHaveLength(0);
    expect(readFileSync(join(arena, "work", "wu-x.md"), "utf8")).toContain("status: escalated");
  });

  it("a refusal that names nothing fails the RUN, and no fixer is paid", async () => {
    // Not a finding: there is nothing in the diff for a correction pass to change, so a
    // fixer handed it would change something arbitrary, the free re-check would see the
    // evidence go green, and the original defect would land. The narrowing and intent
    // rungs refuse exactly this, in the same words.
    const arena = makeArena();
    const out = await tick(deps(arena, agents({
      verdict: (baseSha, headSha) => ({
        unit: "wu-x", verdict: "fail", judged: true,
        coherence: [{ criterion: "scope", ok: true, quote: "app.txt only" }],
        evidence: [{ spec: "grep -q v2 app.txt", run: { command: "grep -q v2 app.txt", exit_code: 0, output_sha256: "aa", log: "e.log" }, ok: true }],
        gates_executed: ["diff-read", "evidence-executed"],
        base_sha: baseSha, head_sha: headSha, spend_usd: 0.3,
      }),
    })));

    expect(out.decision).toBe("judge-failed");
    expect(fixPrompts).toHaveLength(0);
  });

  it("with no unit-fixer configured the rung behaves exactly as it used to", async () => {
    // The fallback that let 420 existing tests pass unchanged. It must stay reachable and
    // must NOT quietly land a diff with known findings.
    const arena = makeArena();
    const out = await tick(deps(arena, agents({ implement: "WRONG", verdict: FAILING_VERDICT }), false));
    expect(out.decision).toBe("verdict-fail");
    expect(fixPrompts).toHaveLength(0);
  });
});
