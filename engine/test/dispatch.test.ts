import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { permanentlyBlocked, tick, unsatisfiableUnits, type TickDeps } from "../src/dispatch.js";
import { parseWorkUnit, type WorkUnit } from "../src/work-unit.js";
import type { RunAgentFn } from "../src/judge.js";
import type { SpawnRunResult } from "../src/spawn.js";
import { metricsPath } from "../src/ledger.js";
import { pausePath } from "../src/steering.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-tick-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const AGENTS = {
  implementer: fileURLToPath(new URL("../../.claude/agents/implementer.md", import.meta.url)),
  judge: fileURLToPath(new URL("../../.claude/agents/code-judge.md", import.meta.url)),
  decomposer: fileURLToPath(new URL("../../.claude/agents/decomposer.md", import.meta.url)),
  planJudge: fileURLToPath(new URL("../../.claude/agents/plan-judge.md", import.meta.url)),
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

function makeArena(withUnit = true): string {
  const dir = mkdtempSync(join(tmp, "arena-"));
  gitIn(dir, ["init", "-b", "development"]);
  mkdirSync(join(dir, ".doctrine"), { recursive: true });
  writeFileSync(join(dir, ".doctrine", "manifest.json"), JSON.stringify({ name: "t", base_branch: "development", doors: [] }));
  writeFileSync(join(dir, ".gitignore"), ".doctrine/lease/\n.doctrine/runs/\n.doctrine/canary-runs/\n");
  writeFileSync(join(dir, "app.txt"), "v1\n");
  mkdirSync(join(dir, "work", "intents"), { recursive: true });
  if (withUnit) writeFileSync(join(dir, "work", "wu-x.md"), UNIT);
  gitIn(dir, ["add", "-A"]);
  commit(dir, "seed");
  return dir;
}

const okSpawn = (cost = 0.3): SpawnRunResult => ({
  spawnFailed: false, exitCode: 0, signal: null, timedOut: false, outage: false,
  logPath: "x", resultMessage: { type: "result", subtype: "success", total_cost_usd: cost },
});

/** Fake agent that plays implementer AND judge, switching on prompt shape. */
function happyAgents(): RunAgentFn {
  return async (prompt, opts) => {
    if (prompt.includes("# Your unit")) {
      // implementer: do the work + commit
      writeFileSync(join(opts.cwd, "app.txt"), "v2\n");
      gitIn(opts.cwd, ["add", "-A"]);
      commit(opts.cwd, "feat: v2");
      return okSpawn(0.5);
    }
    if (prompt.includes("# Your task")) {
      // judge: write a passing verdict at the demanded path
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

function deps(arenaDir: string, runAgent: RunAgentFn): TickDeps {
  return { arenaDir, agentDefs: AGENTS, runAgent };
}

describe("permanentlyBlocked — what it still answers, and what it deliberately does not", () => {
  // The output is not advisory: the caller flips every id in it to `escalated` on disk.
  // So both halves are worth pinning — the legacy capability it still has, and the gap it
  // now has, which is stated in its own doc comment and is otherwise invisible.
  const u = (id: string, status: string, deps: string[]): WorkUnit => {
    const res = parseWorkUnit([
      "---", `id: ${id}`, "title: t", "tier: reversible", `status: ${status}`,
      "budget_usd: 5", "intent: in-x", `depends_on: [${deps.join(", ")}]`,
      "evidence:", "  - kind: command", '    run: "pnpm test"', '    expect: "exit 0"',
      "---", "b", "",
    ].join(String.fromCharCode(10)));
    if (!res.ok) throw new Error(res.errors.join("; "));
    return res.unit;
  };

  it("still strands a LEGACY chain, transitively, which is why it is not deleted yet", () => {
    // 2026-09-07: attention-core escalated, and attention-hours and attention-terms sat
    // ready for ever. The second hop is what made it invisible -- terms never mentions the
    // escalated unit at all.
    const blocked = permanentlyBlocked([
      u("wu-core", "escalated", []),
      u("wu-hours", "ready", ["wu-core"]),
      u("wu-terms", "ready", ["wu-hours"]),
      u("wu-free", "ready", []),
    ]);
    expect([...blocked].sort()).toEqual(["wu-hours", "wu-terms"]);
  });

  it("answers NOTHING for criterion dependencies, and fails safe rather than wrong", () => {
    // A criterion is never a key in the unit index and never in the escalated set, so the
    // walk returns empty. That is a missing capability, not a false answer -- which is the
    // property that lets this wait for the change that owns the grades instead of being
    // rewritten inside the one function that retires work permanently.
    const blocked = permanentlyBlocked([
      u("wu-core", "escalated", []),
      u("wu-hours", "ready", ["C1.1"]),
    ]);
    expect([...blocked]).toEqual([]);
  });
});

describe("tick — the full ladder, offline", () => {
  it("happy path: implement -> judge -> land; status flipped; ledgers written; WIP clean", async () => {
    const arena = makeArena();
    const result = await tick(deps(arena, happyAgents()));
    expect(result.decision).toBe("landed");
    expect(readFileSync(join(arena, "app.txt"), "utf8").trim()).toBe("v2");
    expect(readFileSync(join(arena, "work", "wu-x.md"), "utf8")).toContain("status: merged");
    expect(readFileSync(join(arena, "context", "decisions.md"), "utf8")).toContain("wu-x");
    expect(readFileSync(metricsPath(arena), "utf8")).toContain('"outcome":"merged"');
    expect(gitIn(arena, ["branch", "--list", "doctrine/*"])).toBe("");
    // Next tick is idle — nothing admissible remains.
    expect((await tick(deps(arena, happyAgents()))).decision).toBe("idle");
  });

  it("crash recovery: an in-flight branch from a killed tick is resumed (judged), not redone", async () => {
    const arena = makeArena();
    // Simulate a tick killed after implement: branch exists, nothing else happened.
    gitIn(arena, ["checkout", "-q", "-b", "doctrine/wu-x-999"]);
    writeFileSync(join(arena, "app.txt"), "v2\n");
    gitIn(arena, ["add", "-A"]);
    commit(arena, "feat: v2 (from crashed tick)");
    gitIn(arena, ["checkout", "-q", "development"]);

    let implementerCalled = false;
    const agents: RunAgentFn = async (prompt, opts) => {
      if (prompt.includes("# Your unit")) implementerCalled = true;
      return happyAgents()(prompt, opts);
    };
    const result = await tick(deps(arena, agents));
    expect(result.decision).toBe("landed");
    expect(implementerCalled).toBe(false); // resumed, not re-implemented
    expect(readFileSync(join(arena, "app.txt"), "utf8").trim()).toBe("v2");
  });

  it("paused: no-op, nothing invoked", async () => {
    const arena = makeArena();
    writeFileSync(pausePath(arena), "observer hold\n");
    const result = await tick(deps(arena, async () => { throw new Error("must not invoke"); }));
    expect(result.decision).toBe("no-op-paused");
  });

  it("veto: a vetoed unit is skipped; tick goes idle", async () => {
    const arena = makeArena();
    writeFileSync(join(arena, ".doctrine", "directives.md"), "---\nveto: [wu-x]\n---\n");
    const result = await tick(deps(arena, async () => { throw new Error("must not invoke"); }));
    expect(result.decision).toBe("idle");
  });

  it("outage: no unit metric, unit stays ready, decision no-op-outage", async () => {
    const arena = makeArena();
    const outageAgent: RunAgentFn = async () => ({
      ...okSpawn(0), exitCode: 1, outage: true,
      resultMessage: { type: "result", subtype: "success", is_error: true, api_error_status: 529, total_cost_usd: 0 },
    });
    const result = await tick(deps(arena, outageAgent));
    expect(result.decision).toBe("no-op-outage");
    expect(readFileSync(join(arena, "work", "wu-x.md"), "utf8")).toContain("status: ready");
    const { existsSync } = await import("node:fs");
    const metrics = existsSync(metricsPath(arena)) ? readFileSync(metricsPath(arena), "utf8") : "";
    expect(metrics).not.toContain('"type":"unit"');
  });

  it("judge outage: branch KEPT for resume, no unit metric, no-op-outage", async () => {
    const arena = makeArena();
    const agents: RunAgentFn = async (prompt, opts) => {
      if (prompt.includes("# Your unit")) {
        writeFileSync(join(opts.cwd, "app.txt"), "v2\n");
        gitIn(opts.cwd, ["add", "-A"]);
        commit(opts.cwd, "feat: v2");
        return okSpawn(0.5);
      }
      // judge hits a 529 outage
      return {
        ...okSpawn(0), exitCode: 1, outage: true,
        resultMessage: { type: "result", subtype: "success", is_error: true, api_error_status: 529, total_cost_usd: 0 },
      };
    };
    const result = await tick(deps(arena, agents));
    expect(result.decision).toBe("no-op-outage");
    // Branch preserved — the implemented work survives for a free re-judge.
    expect(gitIn(arena, ["branch", "--list", "doctrine/*"])).toContain("doctrine/wu-x-");
    const { existsSync } = await import("node:fs");
    const metrics = existsSync(metricsPath(arena)) ? readFileSync(metricsPath(arena), "utf8") : "";
    expect(metrics).not.toContain('"type":"unit"');
    // Next tick (judge healthy): rung 0 resumes the branch and lands it.
    const next = await tick(deps(arena, happyAgents()));
    expect(next.decision).toBe("landed");
    expect(readFileSync(join(arena, "app.txt"), "utf8").trim()).toBe("v2");
  });

  it("recognises an instrument failure written before the flag existed", async () => {
    // The detail below is copied verbatim from the row that escalated
    // u-2026-09-05-invoice-review on 2026-09-06 — a real arena, written before `instrument` was a
    // field. If the classifier only trusted the flag, the fix would not reach the incident that
    // caused it: one legacy engine error plus one genuine rejection still exhausts a budget of two.
    const arena = makeArena();
    const { appendUnitMetric } = await import("../src/ledger.js");
    appendUnitMetric(arena, {
      unit: "wu-x", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 20, attempts: 1, reworked: false,
      detail: "design-judge: design-judge malformed-verdict: verdict cites screens that were not rendered: base/.artifacts/screens/billing.png",
    });
    appendUnitMetric(arena, {
      unit: "wu-x", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 20, attempts: 2, reworked: true,
      detail: "design-judge: invoice-review.png (Total row) — figures-do-not-line-up: the columns disagree",
    });
    const res = await tick(deps(arena, happyAgents()));
    expect(res.decision).not.toBe("escalated");
    rmSync(arena, { recursive: true, force: true });
  });

  it("classifies a legacy engine reason it was never told about", async () => {
    // The classifier keys on the DOUBLED prefix the engine writes for any reason of its own, not on
    // a list of reason names — so a design-judge process that simply died is the instrument without
    // anyone having enumerated it here.
    const arena = makeArena();
    const { appendUnitMetric } = await import("../src/ledger.js");
    appendUnitMetric(arena, {
      unit: "wu-x", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 20, attempts: 1, reworked: false,
      detail: "design-judge: design-judge spawn-failed: the judge process exited before writing a verdict",
    });
    appendUnitMetric(arena, {
      unit: "wu-x", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 20, attempts: 2, reworked: true,
      detail: "design-judge: billing.png (header) — figures-do-not-line-up: the columns disagree",
    });
    const res = await tick(deps(arena, happyAgents()));
    expect(res.decision).not.toBe("escalated");
    rmSync(arena, { recursive: true, force: true });
  });

  it("still charges the unit for a head that rendered nothing", async () => {
    // `no-screens` is written with the same doubled prefix as every other engine reason, but it is
    // the unit's failure — its change broke the app or dropped the screen from the register. The
    // bare prefix covers legacy rows from before the head/base split too, which is the conservative
    // direction: one wasted attempt beats a unit that can rebuild a broken change forever.
    const arena = makeArena();
    const { appendUnitMetric } = await import("../src/ledger.js");
    for (const [i, reason] of [[1, "no-screens"], [2, "no-screens-head"]] as const) {
      appendUnitMetric(arena, {
        unit: "wu-x", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 20, attempts: i, reworked: true,
        detail: `design-judge: design-judge ${reason}: nothing rendered under .artifacts/screens`,
      });
    }
    const res = await tick(deps(arena, async () => { throw new Error("must not invoke"); }));
    expect(res.decision).toBe("escalated");
    rmSync(arena, { recursive: true, force: true });
  });

  it("does not mistake a judge's own prose for an engine error", async () => {
    // The classifier reads engine-written prefixes, not keywords. A verdict is free to call a
    // SCREEN malformed — that is the unit's problem, and it must still cost an attempt.
    const arena = makeArena();
    const { appendUnitMetric } = await import("../src/ledger.js");
    for (const i of [1, 2]) {
      appendUnitMetric(arena, {
        unit: "wu-x", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 20, attempts: i, reworked: true,
        detail: "design-judge: billing.png (header) — malformed-verdict is not what this says; the markup is malformed",
      });
    }
    const res = await tick(deps(arena, async () => { throw new Error("must not invoke"); }));
    expect(res.decision).toBe("escalated");
    rmSync(arena, { recursive: true, force: true });
  });

  it("an instrument failure does not spend the retry budget", async () => {
    // u-2026-09-05-invoice-review escalated on 2026-09-07 with exactly ONE real attempt. The other
    // was a design-judge malformed-verdict — "verdict cites screens that were not rendered" — which
    // is an engine error, tells the implementer nothing about its own work, and still counted as an
    // informed attempt. The unit was charged for our bug.
    const arena = makeArena();
    const { appendUnitMetric } = await import("../src/ledger.js");
    appendUnitMetric(arena, { unit: "wu-x", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 20, attempts: 1, reworked: false, detail: "design-judge: malformed-verdict: cites screens that were not rendered", instrument: true });
    appendUnitMetric(arena, { unit: "wu-x", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 20, attempts: 2, reworked: true, detail: "design-judge: figures-do-not-line-up" });
    // One real attempt against a budget of 2 — the unit must still get its second.
    const res = await tick(deps(arena, happyAgents()));
    expect(res.decision).not.toBe("escalated");
    rmSync(arena, { recursive: true, force: true });
  });

  it("does not feed an engine error to the next attempt as if it were a finding", async () => {
    const arena = makeArena();
    const { appendUnitMetric } = await import("../src/ledger.js");
    appendUnitMetric(arena, { unit: "wu-x", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 20, attempts: 1, reworked: false, detail: "design-judge: malformed-verdict: cites screens that were not rendered", instrument: true });
    let sawEngineError = false;
    const watch: RunAgentFn = async (prompt, opts) => {
      if (!prompt.includes("verdict") && prompt.includes("malformed-verdict")) sawEngineError = true;
      return happyAgents()(prompt, opts);
    };
    await tick(deps(arena, watch));
    expect(sawEngineError).toBe(false);
    rmSync(arena, { recursive: true, force: true });
  });

  it("but the floor still counts them, so a broken instrument cannot retry forever", async () => {
    // The anti-spin half. `count` includes instrument rows, so an instrument that fails every time
    // reaches the floor at twice the budget and escalates instead of burning the day.
    const arena = makeArena();
    writeFileSync(
      join(arena, ".doctrine", "manifest.json"),
      JSON.stringify({ name: "t", base_branch: "development", doors: [], budgets: { consecutiveFailuresHalt: 99 } }),
    );
    const { appendUnitMetric } = await import("../src/ledger.js");
    for (const i of [1, 2, 3, 4]) {
      appendUnitMetric(arena, { unit: "wu-x", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 5, attempts: i, reworked: true, detail: "design-judge: malformed-verdict", instrument: true });
    }
    const res = await tick(deps(arena, async () => { throw new Error("must not invoke"); }));
    expect(res.decision).toBe("escalated");
    rmSync(arena, { recursive: true, force: true });
  });

  it("attempts exhausted: unit escalated, loop moves on", async () => {
    const arena = makeArena();
    // Two failed attempts already on the ledger (attemptsPerUnit default = 2), each
    // having recorded WHY — which is what makes them two attempts rather than one twice.
    const { appendUnitMetric } = await import("../src/ledger.js");
    for (const i of [1, 2]) {
      appendUnitMetric(arena, { unit: "wu-x", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 0.1, attempts: i, reworked: true, detail: `code-judge fail: reason ${i}` });
    }
    const result = await tick(deps(arena, async () => { throw new Error("must not invoke"); }));
    expect(result.decision).toBe("escalated");
    expect(readFileSync(join(arena, "work", "wu-x.md"), "utf8")).toContain("status: escalated");
  });

  it("a failed attempt that recorded no reason does not spend the retry budget", async () => {
    const arena = makeArena();
    // The rows a target's first UI unit left: two failures, written before the
    // detail field existed, so neither told its successor anything. Under the old count
    // the unit was out of attempts having never once been retried against a problem.
    const { appendUnitMetric } = await import("../src/ledger.js");
    for (const i of [1, 2]) {
      appendUnitMetric(arena, { unit: "wu-x", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 0.1, attempts: i, reworked: true });
    }
    const result = await tick(deps(arena, happyAgents()));
    expect(result.decision).not.toBe("escalated");
    expect(readFileSync(join(arena, "work", "wu-x.md"), "utf8")).not.toContain("status: escalated");
  });

  it("but uninformative failures cannot spin forever — the floor escalates on its own terms", async () => {
    const arena = makeArena();
    // The loop-level failure halt would catch four consecutive failures first, so it is
    // lifted here to leave the PER-UNIT floor as the thing under test. The two are not
    // redundant: the loop halt counts failures across every unit and a success anywhere
    // resets it, so on an interleaved queue it can never bound one stuck unit.
    writeFileSync(
      join(arena, ".doctrine", "manifest.json"),
      JSON.stringify({ name: "t", base_branch: "development", doors: [], budgets: { consecutiveFailuresHalt: 99 } }),
    );
    // Twice the budget, none of them saying why. That is a defect in the loop rather
    // than in the unit, and the tick says so instead of paying for a fifth re-roll.
    const { appendUnitMetric } = await import("../src/ledger.js");
    for (const i of [1, 2, 3, 4]) {
      appendUnitMetric(arena, { unit: "wu-x", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 0.1, attempts: i, reworked: true });
    }
    const result = await tick(deps(arena, async () => { throw new Error("must not invoke"); }));
    expect(result.decision).toBe("escalated");
    const ticks = readFileSync(join(arena, ".doctrine", "ticks.jsonl"), "utf8");
    expect(ticks).toContain("the failures are not saying why");
  });

  it("a mixed ledger counts only the attempts that recorded a reason", async () => {
    const arena = makeArena();
    // Same reason as above: the loop halt is not what is being measured here.
    writeFileSync(
      join(arena, ".doctrine", "manifest.json"),
      JSON.stringify({ name: "t", base_branch: "development", doors: [], budgets: { consecutiveFailuresHalt: 99 } }),
    );
    const { appendUnitMetric } = await import("../src/ledger.js");
    // Three failures, one informative. Budget 2, floor 4: neither is reached.
    appendUnitMetric(arena, { unit: "wu-x", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 0.1, attempts: 1, reworked: true });
    appendUnitMetric(arena, { unit: "wu-x", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 0.1, attempts: 2, reworked: true, detail: "design-judge: the total figure is never drawn" });
    appendUnitMetric(arena, { unit: "wu-x", outcome: "failed", time_to_verified_done_s: 1, spend_usd: 0.1, attempts: 3, reworked: true, detail: "   " });
    const result = await tick(deps(arena, happyAgents()));
    expect(result.decision).not.toBe("escalated");
  });

  it("grades a finished intent BEFORE decomposing the next one", async () => {
    // The starvation this ordering fixes, observed on a target: an intent whose
    // units had all merged sat ungraded while the loop decomposed the next intent and built its
    // units, because every rung returns as soon as it acts and the grade was last. The loop began
    // building a second intent on a foundation whose acceptance nobody had run.
    const arena = makeArena(false);
    // One finished intent — decomposed, its only unit merged — and one ready intent behind it.
    writeFileSync(
      join(arena, "work", "intents", "in-done.md"),
      `---\nid: in-done\ntitle: t\nstatus: decomposed\nbudget_usd: 20\ntier_default: reversible\nacceptance:\n  - kind: command\n    run: "true"\n    expect: "ok"\n---\nbrief\n`,
    );
    writeFileSync(
      join(arena, "work", "wu-done.md"),
      `---\nid: wu-done\ntitle: t\nintent: in-done\ntier: reversible\nstatus: merged\nbudget_usd: 5\nevidence:\n  - kind: command\n    run: "true"\n    expect: "ok"\n---\nb\n`,
    );
    writeFileSync(
      join(arena, "work", "intents", "in-next.md"),
      `---\nid: in-next\ntitle: t\nstatus: ready\nbudget_usd: 20\ntier_default: reversible\nacceptance:\n  - kind: command\n    run: "true"\n    expect: "ok"\n---\nbrief\n`,
    );
    gitIn(arena, ["add", "-A"]);
    commit(arena, "one finished intent, one ready");

    // The planner must not be reached: the grade comes first, and it is engine-only.
    const res = await tick(deps(arena, async () => { throw new Error("no ACT may run before the grade"); }));
    expect(res.decision).toBe("intent-graded-pass");
    expect(res.unit).toBe("in-done");
    // And the ready intent is untouched, waiting its turn on the next tick.
    expect(readFileSync(join(arena, "work", "intents", "in-next.md"), "utf8")).toContain("status: ready");
  });

  it("grades a finished intent before building ANOTHER intent's ready unit", async () => {
    // The half the first fix missed, observed on the same target. Moving the grade ahead of
    // the decompose stopped the loop planning onto an ungraded foundation, and left it free to
    // BUILD onto one: the skeleton intent sat ungraded while the loop built the invoice units —
    // the very units that depend on the skeleton being right. "Finish work already started" is a
    // reason to defer a grade behind that intent's own units, not behind another intent's.
    const arena = makeArena(false);
    writeFileSync(
      join(arena, "work", "intents", "in-done.md"),
      `---\nid: in-done\ntitle: t\nstatus: decomposed\nbudget_usd: 20\ntier_default: reversible\nacceptance:\n  - kind: command\n    run: "true"\n    expect: "ok"\n---\nbrief\n`,
    );
    writeFileSync(
      join(arena, "work", "wu-done.md"),
      `---\nid: wu-done\ntitle: t\nintent: in-done\ntier: reversible\nstatus: merged\nbudget_usd: 5\nevidence:\n  - kind: command\n    run: "true"\n    expect: "ok"\n---\nb\n`,
    );
    // A ready unit belonging to a DIFFERENT, already-decomposed intent — exactly the invoice case.
    writeFileSync(
      join(arena, "work", "intents", "in-other.md"),
      `---\nid: in-other\ntitle: t\nstatus: decomposed\nbudget_usd: 20\ntier_default: reversible\nacceptance:\n  - kind: command\n    run: "true"\n    expect: "ok"\n---\nbrief\n`,
    );
    writeFileSync(
      join(arena, "work", "wu-other.md"),
      `---\nid: wu-other\ntitle: t\nintent: in-other\ntier: reversible\nstatus: ready\nbudget_usd: 5\nevidence:\n  - kind: command\n    run: "true"\n    expect: "ok"\n---\nb\n`,
    );
    gitIn(arena, ["add", "-A"]);
    commit(arena, "one finished intent, one ready unit of another");

    // No ACT may run: the grade is engine-only, and it must come first.
    const res = await tick(deps(arena, async () => { throw new Error("no ACT may run before the grade"); }));
    expect(res.decision).toBe("intent-graded-pass");
    expect(res.unit).toBe("in-done");
    // The other intent's unit is untouched, waiting its turn.
    expect(readFileSync(join(arena, "work", "wu-other.md"), "utf8")).toContain("status: ready");
  });

  it("a failed grade whose gap decompose is empty settles, instead of spinning on it", async () => {
    // The regression the reorder introduced. With the grade ahead of the ready-intent rung, an
    // intent whose acceptance fails and whose gap decomposer honestly has nothing to add would be
    // regraded every tick, relaunch the same PAID gap ACT every tick, and — because this rung
    // returns — keep every other intent unreachable until the daily budget halted the loop.
    const arena = makeArena(false);
    writeFileSync(
      // The check PRINTS what it is waiting on. A silent one gets no skip at all (see the
      // silent-failure test below); this fixture was `exit 1`, and it passed only because
      // that guard was dead.
      join(arena, "work", "intents", "in-fails.md"),
      `---\nid: in-fails\ntitle: t\nstatus: decomposed\nbudget_usd: 20\ntier_default: reversible\nacceptance:\n  - kind: command\n    run: "echo blocked on the matches log && exit 1"\n    expect: "never"\n---\nbrief\n`,
    );
    writeFileSync(
      join(arena, "work", "wu-fails.md"),
      `---\nid: wu-fails\ntitle: t\nintent: in-fails\ntier: reversible\nstatus: merged\nbudget_usd: 5\nevidence:\n  - kind: command\n    run: "true"\n    expect: "ok"\n---\nb\n`,
    );
    gitIn(arena, ["add", "-A"]);
    commit(arena, "an intent whose acceptance fails");

    // A gap decomposer that honestly writes no units.
    let gapRuns = 0;
    const emptyGap: RunAgentFn = async (_prompt, opts) => {
      gapRuns += 1;
      mkdirSync(join(opts.logPath, ".."), { recursive: true });
      writeFileSync(opts.logPath, "");
      return { exitCode: 0, spawnFailed: false, signal: null, stdout: "", stderr: "", timedOut: false, outage: false, logPath: opts.logPath, resultMessage: { total_cost_usd: 0.1 } } as unknown as SpawnRunResult;
    };

    const first = await tick(deps(arena, emptyGap));
    expect(first.decision).toBe("intent-graded-fail+gap-empty");
    expect(gapRuns).toBe(1);

    // The second tick must NOT pay for the same answer at the same commit.
    const second = await tick(deps(arena, emptyGap));
    expect(gapRuns).toBe(1);
    expect(second.decision).not.toBe("intent-graded-fail+gap-empty");

    // ...and not at a DIFFERENT commit either, while the acceptance fails identically.
    //
    // Settlement is keyed to HEAD, which clears the moment anything lands anywhere — and
    // for an intent blocked on a sibling slice that is every merge in the program. Measured
    // on a target before this was built: 16 `gap-empty` ticks, $31.33, twelve of them in
    // one day, each buying the same correct "nothing to add".
    //
    // The evidence is the right key. The decomposer's answer is a function of what the
    // acceptance printed, so identical output means a question already answered.
    writeFileSync(join(arena, "unrelated.txt"), "a merge somewhere else in the program");
    gitIn(arena, ["add", "-A"]);
    commit(arena, "product code moves, this intent's evidence does not");

    const third = await tick(deps(arena, emptyGap));
    expect(gapRuns, "the evidence did not move, so the answer cannot have").toBe(1);
    expect(third.decision).toBe("intent-graded-fail+gap-unchanged");

    // ...and not when a UNIT merges elsewhere, which is the case the commit above could not
    // exercise: it changed a file, never a unit's status. The key hashed every merged unit id
    // in the arena — an input the decomposer had already stopped being told — so on
    // a target the first unit to land after an unpause re-bought this exact
    // "nothing to add", on byte-identical failure output, for $1.28.
    writeFileSync(
      join(arena, "work", "wu-elsewhere.md"),
      `---\nid: wu-elsewhere\ntitle: t\nintent: in-other\ntier: reversible\nstatus: merged\nbudget_usd: 5\nevidence:\n  - kind: command\n    run: "true"\n    expect: "ok"\n---\nb\n`,
    );
    gitIn(arena, ["add", "-A"]);
    commit(arena, "a unit in another intent lands");

    const fourth = await tick(deps(arena, emptyGap));
    expect(gapRuns, "a merge elsewhere is not a change in what this planner is told").toBe(1);
    expect(fourth.decision).toBe("intent-graded-fail+gap-unchanged");
  });

  it("...but a gap IS re-asked once the acceptance fails DIFFERENTLY", async () => {
    // The other half, and the case this exists for: an intent blocked on a module that does
    // not exist fails with an import error naming it. The moment a sibling slice lands that
    // module the error changes — so the signature changes, and the decomposer is asked again
    // at precisely the tick where it has something new to say.
    const arena = makeArena(false);
    writeFileSync(
      join(arena, "work", "intents", "in-fails.md"),
      `---
id: in-fails
title: t
status: decomposed
budget_usd: 20
tier_default: reversible
acceptance:
  - kind: command
    run: "cat blocker.txt && exit 1"
    expect: "never"
---
brief
`,
    );
    writeFileSync(
      join(arena, "work", "wu-fails.md"),
      `---
id: wu-fails
title: t
intent: in-fails
tier: reversible
status: merged
budget_usd: 5
evidence:
  - kind: command
    run: "true"
    expect: "ok"
---
b
`,
    );
    gitIn(arena, ["add", "-A"]);
    commit(arena, "an intent blocked on a file that does not exist");

    let gapRuns = 0;
    const emptyGap: RunAgentFn = async (_prompt, opts) => {
      gapRuns += 1;
      mkdirSync(join(opts.logPath, ".."), { recursive: true });
      writeFileSync(opts.logPath, "");
      return { exitCode: 0, spawnFailed: false, signal: null, stdout: "", stderr: "", timedOut: false, outage: false, logPath: opts.logPath, resultMessage: { total_cost_usd: 0.1 } } as unknown as SpawnRunResult;
    };

    expect((await tick(deps(arena, emptyGap))).decision).toBe("intent-graded-fail+gap-empty");
    expect(gapRuns).toBe(1);

    // The blocker lands. The command still FAILS — `&& exit 1` keeps the exit code at 1
    // either way — but its output changes from "no such file" to the file's contents, which
    // is the whole point: what the decomposer can slice changed, and the exit code alone
    // would not have shown it.
    writeFileSync(join(arena, "blocker.txt"), "the sibling slice landed it");
    gitIn(arena, ["add", "-A"]);
    commit(arena, "the thing it was blocked on");

    await tick(deps(arena, emptyGap));
    expect(gapRuns, "the evidence moved, so it is worth asking again").toBe(2);
  });

  it("a failed gap decompose settles too, so other work is not blocked behind it", async () => {
    // The half of the settlement I missed. `empty` was handled; `failed` — a timeout, a malformed
    // plan, a plan-judge rejection — was not, and it is the more tempting one to retry because it
    // looks transient. With the grade ahead of every kind of new work, retrying it immediately
    // stops ready units, maintenance units and every other intent until the consecutive-failure
    // gate halts the loop three attempts later.
    const arena = makeArena(false);
    writeFileSync(
      join(arena, "work", "intents", "in-fails.md"),
      `---\nid: in-fails\ntitle: t\nstatus: decomposed\nbudget_usd: 20\ntier_default: reversible\nacceptance:\n  - kind: command\n    run: "exit 1"\n    expect: "never"\n---\nbrief\n`,
    );
    writeFileSync(
      join(arena, "work", "wu-fails.md"),
      `---\nid: wu-fails\ntitle: t\nintent: in-fails\ntier: reversible\nstatus: merged\nbudget_usd: 5\nevidence:\n  - kind: command\n    run: "true"\n    expect: "ok"\n---\nb\n`,
    );
    gitIn(arena, ["add", "-A"]);
    commit(arena, "an intent whose acceptance fails");

    // A gap decomposer that fails outright rather than writing an honest empty plan.
    let gapRuns = 0;
    const failingGap: RunAgentFn = async (_prompt, opts) => {
      gapRuns += 1;
      mkdirSync(join(opts.logPath, ".."), { recursive: true });
      writeFileSync(opts.logPath, "");
      return { exitCode: 1, spawnFailed: false, signal: null, stdout: "", stderr: "boom", timedOut: false, outage: false, logPath: opts.logPath, resultMessage: { total_cost_usd: 0.1 } } as unknown as SpawnRunResult;
    };

    const first = await tick(deps(arena, failingGap));
    expect(String(first.decision)).toContain("intent-graded-fail+gap-");
    expect(gapRuns).toBe(1);

    // Second tick: the intent is settled at this commit, so the paid ACT is not re-run and the
    // tick falls through instead of returning on the same failure.
    const second = await tick(deps(arena, failingGap));
    expect(gapRuns).toBe(1);
    expect(String(second.decision)).not.toContain("intent-graded-fail");
  });

  it("decompose rung: a ready intent with no units gets decomposed via the planner", async () => {
    const arena = makeArena(false);
    writeFileSync(
      join(arena, "work", "intents", "in-a.md"),
      `---\nid: in-a\ntitle: t\nstatus: ready\nbudget_usd: 20\ntier_default: reversible\nacceptance:\n  - kind: command\n    run: "true"\n    expect: "ok"\n---\nbrief\n`,
    );
    gitIn(arena, ["add", "-A"]);
    commit(arena, "intent");
    const planner: RunAgentFn = async (prompt, opts) => {
      if (prompt.includes("# Your plan to judge")) {
        const verdictPath = /write the verdict JSON to EXACTLY: (.+)/.exec(prompt)![1]!.trim();
        writeFileSync(verdictPath, JSON.stringify({
          intent: "in-a", verdict: "pass", judged: true,
          units: [{ id: "wu-new", ok: true, cite: "brief", problems: [] }],
          rival_check: "grepped repo and contracts — none",
        }));
        return okSpawn(0.1);
      }
      expect(prompt).toContain("# Your intent");
      // The decompose ACT runs under the containment deny profile (PR #98 review): it held
      // `Write` with nothing between it and the doors until then.
      expect(opts.argv).toContain("--settings");
      writeFileSync(
        join(opts.cwd, "work", "wu-new.md"),
        `---\nid: wu-new\ntitle: t\ntier: reversible\nstatus: draft\nbudget_usd: 5\nintent: in-a\nevidence:\n  - kind: command\n    run: "true"\n    expect: "ok"\n---\nb\n`,
      );
      return okSpawn(0.2);
    };
    const result = await tick(deps(arena, planner));
    expect(result.decision).toBe("decompose-decomposed");
    expect(readFileSync(join(arena, "work", "wu-new.md"), "utf8")).toContain("status: ready");
    expect(readFileSync(join(arena, "work", "intents", "in-a.md"), "utf8")).toContain("status: decomposed");
  });

  it("decompose retry carries the plan-judge's prior rejection from the tick ledger", async () => {
    const arena = makeArena(false);
    writeFileSync(
      join(arena, "work", "intents", "in-a.md"),
      `---\nid: in-a\ntitle: t\nstatus: ready\nbudget_usd: 20\ntier_default: reversible\nacceptance:\n  - kind: command\n    run: "true"\n    expect: "ok"\n---\nbrief\n`,
    );
    gitIn(arena, ["add", "-A"]);
    commit(arena, "intent");
    // The prior tick's rejection, as dispatch would have recorded it — with a
    // later lint failure in between, which must NOT mask the objections.
    const { appendTick } = await import("../src/ledger.js");
    appendTick(arena, {
      decision: "decompose-failed", unit: "in-a",
      detail: "plan-judge rejected the plan: wu-ghost: invented scope — no intent text supports it",
    });
    appendTick(arena, {
      decision: "decompose-failed", unit: "in-a",
      detail: "plan lint failed: work/wu-bad.md: budget_usd must be a positive number",
    });
    let decomposerPrompt = "";
    const planner: RunAgentFn = async (prompt, opts) => {
      if (prompt.includes("# Your plan to judge")) {
        const verdictPath = /write the verdict JSON to EXACTLY: (.+)/.exec(prompt)![1]!.trim();
        writeFileSync(verdictPath, JSON.stringify({
          intent: "in-a", verdict: "pass", judged: true,
          units: [{ id: "wu-new", ok: true, cite: "brief", problems: [] }],
          rival_check: "grepped — none",
        }));
        return okSpawn(0.1);
      }
      decomposerPrompt = prompt;
      writeFileSync(
        join(opts.cwd, "work", "wu-new.md"),
        `---\nid: wu-new\ntitle: t\ntier: reversible\nstatus: draft\nbudget_usd: 5\nintent: in-a\nevidence:\n  - kind: command\n    run: "true"\n    expect: "ok"\n---\nb\n`,
      );
      return okSpawn(0.2);
    };
    const result = await tick(deps(arena, planner));
    expect(result.decision).toBe("decompose-decomposed");
    expect(decomposerPrompt).toContain("Prior plan REJECTED");
    expect(decomposerPrompt).toContain("wu-ghost: invented scope");
  });

  it("intent-grade rung: all children merged -> engine grades -> intent done", async () => {
    const arena = makeArena(false);
    writeFileSync(
      join(arena, "work", "intents", "in-a.md"),
      `---\nid: in-a\ntitle: t\nstatus: decomposed\nbudget_usd: 20\ntier_default: reversible\nacceptance:\n  - kind: command\n    run: "true"\n    expect: "ok"\n---\nbrief\n`,
    );
    writeFileSync(
      join(arena, "work", "wu-done.md"),
      `---\nid: wu-done\ntitle: t\ntier: reversible\nstatus: merged\nbudget_usd: 5\nintent: in-a\nevidence:\n  - kind: command\n    run: "true"\n    expect: "ok"\n---\nb\n`,
    );
    gitIn(arena, ["add", "-A"]);
    commit(arena, "graded setup");
    const result = await tick(deps(arena, async () => { throw new Error("grade needs no LLM"); }));
    expect(result.decision).toBe("intent-graded-pass");
    expect(readFileSync(join(arena, "work", "intents", "in-a.md"), "utf8")).toContain("status: done");
  });

  it("a killed implementer that had committed keeps its work for the judge", async () => {
    // On 2026-09-07 the implementer for u-2026-09-05-invoice-review committed 1,993 lines
    // across 14 files and the 30-minute wall clock fired two minutes later. The cleanup
    // path deleted the branch, and the whole unit survived only as a dangling object.
    const arena = makeArena();
    const killedAfterCommitting: RunAgentFn = async (prompt, opts) => {
      if (prompt.includes("# Your unit")) {
        writeFileSync(join(opts.cwd, "app.txt"), "v2\n");
        gitIn(opts.cwd, ["add", "-A"]);
        commit(opts.cwd, "feat: v2 — committed, then the clock ran out");
        return {
          exitCode: 1, spawnFailed: false, signal: null, stdout: "", stderr: "killed",
          timedOut: true, outage: false, logPath: "x", resultMessage: undefined,
        } as unknown as SpawnRunResult;
      }
      return happyAgents()(prompt, opts);
    };
    const res = await tick(deps(arena, killedAfterCommitting));
    expect(res.decision).toBe("no-op-implement-interrupted");
    // The work still exists, on a branch shaped exactly like the one rung 0 resumes.
    expect(gitIn(arena, ["branch", "--list", "doctrine/wu-x-*"])).not.toBe("");
    // And no unit metric: the attempt is not over, so nothing may charge it yet.
    const { existsSync } = await import("node:fs");
    const metrics = existsSync(metricsPath(arena)) ? readFileSync(metricsPath(arena), "utf8") : "";
    expect(metrics).not.toContain('"type":"unit"');

    // The next tick resumes and judges it — without re-running the implementer.
    let implementerCalled = false;
    const watch: RunAgentFn = async (prompt, opts) => {
      if (prompt.includes("# Your unit")) implementerCalled = true;
      return happyAgents()(prompt, opts);
    };
    expect((await tick(deps(arena, watch))).decision).toBe("landed");
    expect(implementerCalled).toBe(false);
    expect(readFileSync(join(arena, "app.txt"), "utf8").trim()).toBe("v2");
    rmSync(arena, { recursive: true, force: true });
  });

  it("a killed implementer that had NOT yet committed still keeps its work", async () => {
    // The narrower window, and the likelier one: the wall clock fires between the last
    // edit and the commit. Before the salvage moved ahead of the spawn-failure return,
    // those edits sat in a worktree the caller then force-removed — so "the process died"
    // and "it built nothing" were the same outcome, and one of them is a finished unit.
    const arena = makeArena();
    const killedDirty: RunAgentFn = async (prompt, opts) => {
      if (prompt.includes("# Your unit")) {
        writeFileSync(join(opts.cwd, "app.txt"), "v2\n"); // edited, never committed
        return {
          exitCode: 1, spawnFailed: false, signal: null, stdout: "", stderr: "killed",
          timedOut: true, outage: false, logPath: "x", resultMessage: undefined,
        } as unknown as SpawnRunResult;
      }
      return happyAgents()(prompt, opts);
    };
    const res = await tick(deps(arena, killedDirty));
    expect(res.decision).toBe("no-op-implement-interrupted");
    expect(gitIn(arena, ["branch", "--list", "doctrine/wu-x-*"])).not.toBe("");

    // And the salvaged work is real: the next tick judges it and lands v2, without
    // re-running the implementer.
    let implementerCalled = false;
    const watch: RunAgentFn = async (prompt, opts) => {
      if (prompt.includes("# Your unit")) implementerCalled = true;
      return happyAgents()(prompt, opts);
    };
    expect((await tick(deps(arena, watch))).decision).toBe("landed");
    expect(implementerCalled).toBe(false);
    expect(readFileSync(join(arena, "app.txt"), "utf8").trim()).toBe("v2");
    rmSync(arena, { recursive: true, force: true });
  });

  it("a pre-commit hook cannot destroy the salvaged work", async () => {
    // A target with a pre-commit hook is ordinary, and the tree such a hook rejects is
    // exactly the interrupted one that most needs keeping. Before --no-verify, the hook's
    // non-zero exit threw out of the salvage, the tick never reached its preservation, and
    // the sweep collected the worktree.
    const arena = makeArena();
    const hooks = join(arena, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho 'refusing an incomplete tree' >&2\nexit 1\n");
    try { execFileSync("chmod", ["+x", join(hooks, "pre-commit")]); } catch { /* windows */ }

    const killedDirty: RunAgentFn = async (prompt, opts) => {
      if (prompt.includes("# Your unit")) {
        writeFileSync(join(opts.cwd, "app.txt"), "v2\n");
        return {
          exitCode: 1, spawnFailed: false, signal: null, stdout: "", stderr: "killed",
          timedOut: true, outage: false, logPath: "x", resultMessage: undefined,
        } as unknown as SpawnRunResult;
      }
      return happyAgents()(prompt, opts);
    };
    const res = await tick(deps(arena, killedDirty));
    expect(res.decision).toBe("no-op-implement-interrupted");
    // The salvage went through DESPITE the hook — not merely "the worktree was kept as a
    // fallback", which is the weaker outcome the catch also produces. Assert the strong
    // one: a branch carrying the commit, which the next tick can judge and land.
    expect(gitIn(arena, ["branch", "--list", "doctrine/wu-x-*"])).not.toBe("");
    // The hook goes before the second tick, because the engine's OWN landing commit is
    // subject to it too — a separate latent problem, and not what
    // this test is about.
    rmSync(join(hooks, "pre-commit"), { force: true });
    expect((await tick(deps(arena, happyAgents()))).decision).toBe("landed");
    expect(readFileSync(join(arena, "app.txt"), "utf8").trim()).toBe("v2");
    rmSync(arena, { recursive: true, force: true });
  });

  it("halts rather than let the next tick sweep the only copy of the work", async () => {
    // The residual case: the salvage commit fails even with --no-verify. The branch still
    // points at the unchanged base, so rung 0 has nothing to recover, and keeping the
    // worktree for this tick alone is no protection — the NEXT tick's sweep force-removes
    // every checkout under .doctrine/runs. A commit that fails with hooks bypassed already
    // means something systematic, so the loop stops instead of ticking into the deletion.
    const arena = makeArena();
    // Make the commit unmakeable in a way --no-verify cannot bypass: an index lock.
    const killedDirty: RunAgentFn = async (prompt, opts) => {
      if (prompt.includes("# Your unit")) {
        writeFileSync(join(opts.cwd, "app.txt"), "v2\n");
        // The worktree's index lock lives in the arena's .git for a linked worktree.
        const lock = join(arena, ".git", "worktrees", basename(opts.cwd), "index.lock");
        mkdirSync(dirname(lock), { recursive: true });
        writeFileSync(lock, "");
        return {
          exitCode: 1, spawnFailed: false, signal: null, stdout: "", stderr: "killed",
          timedOut: true, outage: false, logPath: "x", resultMessage: undefined,
        } as unknown as SpawnRunResult;
      }
      return happyAgents()(prompt, opts);
    };
    const res = await tick(deps(arena, killedDirty));
    expect(res.decision).toBe("self-halt");
    // The pause carries no `resume_at`, so no clock restarts this — only a person.
    const pause = readFileSync(pausePath(arena), "utf8");
    expect(pause).not.toContain("resume_at");

    // But the halt is the second line of defence, not the first. The work was moved out
    // of `.doctrine/runs`, which is the only place the sweep looks — so it survives even
    // if nothing stops the next tick. Prove that by clearing the pause and ticking again.
    rmSync(pausePath(arena), { force: true });
    await tick(deps(arena, happyAgents()));
    const preserved = join(arena, ".doctrine", "preserved");
    const kept = readdirSync(preserved);
    expect(kept.length).toBe(1);
    expect(readFileSync(join(preserved, kept[0]!, "app.txt"), "utf8").trim()).toBe("v2");
    rmSync(arena, { recursive: true, force: true });
  });

  it("a killed implementer that committed nothing is cleaned up and not charged", async () => {
    // The other half. An empty branch is the leftover the cleanup was written for, so it
    // still goes — but a process killed before it produced anything is the instrument, and
    // the row says so: nothing reached the retry, so nothing may spend its budget.
    const arena = makeArena();
    const killedEmpty: RunAgentFn = async (prompt) => {
      if (prompt.includes("# Your unit")) {
        return {
          exitCode: 1, spawnFailed: false, signal: null, stdout: "", stderr: "killed",
          timedOut: true, outage: false, logPath: "x", resultMessage: undefined,
        } as unknown as SpawnRunResult;
      }
      throw new Error("the judge must not run — there is nothing to judge");
    };
    const res = await tick(deps(arena, killedEmpty));
    expect(res.decision).toBe("implement-failed");
    expect(gitIn(arena, ["branch", "--list", "doctrine/wu-x-*"])).toBe("");
    const rows = readFileSync(metricsPath(arena), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
    const unitRow = rows.find((r) => r["type"] === "unit");
    expect(unitRow?.["instrument"]).toBe(true);
    rmSync(arena, { recursive: true, force: true });
  });

  it("an escalated child does not freeze its intent forever", async () => {
    // u-2026-09-07-attention-core escalated on a self-contradictory evidence spec and took
    // the whole attention-queue intent with it: the grade fired only when every child was
    // `merged`, nothing ever moves an escalated unit, so the grade could not run, so the
    // gap decomposer could not run, so no corrected unit could ever be minted.
    const arena = makeArena(false);
    writeFileSync(join(arena, "work", "intents", "in-x.md"), `---
id: in-x
title: An intent with one escalated child
status: decomposed
budget_usd: 10
tier_default: reversible
acceptance:
  - kind: command
    run: "grep -q nothing-doing app.txt"
    expect: "exit 0"
---
Body.
`);
    writeFileSync(join(arena, "work", "wu-dead.md"), `---
id: wu-dead
title: The unit whose spec could not be satisfied
intent: in-x
tier: reversible
status: escalated
budget_usd: 5
evidence:
  - kind: command
    run: "true"
    expect: "exit 0"
---
Body.
`);
    gitIn(arena, ["add", "-A"]);
    commit(arena, "an intent whose only child escalated");

    // The grade must actually RUN — asserting the predicate would prove nothing about it.
    // Its acceptance cannot pass here, so a grade that fires reaches the gap decomposer.
    let gapDecomposeRan = false;
    const watch: RunAgentFn = async (prompt, opts) => {
      if (prompt.includes("Gap input")) { gapDecomposeRan = true; return okSpawn(0.1); }
      return happyAgents()(prompt, opts);
    };
    await tick(deps(arena, watch));
    expect(gapDecomposeRan).toBe(true);
    rmSync(arena, { recursive: true, force: true });
  });

  it("and the gap decomposer is told WHICH spec was the defect, in the judge's words", async () => {
    // Routing it is the whole point. Without it the gap decomposer sees only that some
    // acceptance command failed, and re-mints a unit carrying the same defect — the same
    // failure the implementer had before `priorFailures`: a second attempt at the same
    // attempt rather than at the problem.
    const arena = makeArena(false);
    writeFileSync(join(arena, "work", "intents", "in-x.md"), `---
id: in-x
title: An intent with one escalated child
status: decomposed
budget_usd: 10
tier_default: reversible
acceptance:
  - kind: command
    run: "grep -q nothing-doing app.txt"
    expect: "exit 0"
---
Body.
`);
    writeFileSync(join(arena, "work", "wu-dead.md"), `---
id: wu-dead
title: The unit whose spec could not be satisfied
intent: in-x
tier: reversible
status: escalated
budget_usd: 5
evidence:
  - kind: command
    run: "true"
    expect: "exit 0"
---
Body.
`);
    writeFileSync(join(arena, "work", "wu-tired.md"), `---
id: wu-tired
title: A unit that simply ran out of attempts
intent: in-x
tier: reversible
status: escalated
budget_usd: 5
evidence:
  - kind: command
    run: "true"
    expect: "exit 0"
---
Body.
`);
    gitIn(arena, ["add", "-A"]);
    commit(arena, "an intent whose only child escalated");
    const { appendUnitMetric } = await import("../src/ledger.js");
    appendUnitMetric(arena, {
      unit: "wu-dead", outcome: "escalated", time_to_verified_done_s: 1, spend_usd: 1,
      attempts: 1, reworked: false,
      detail: "code-judge escalate: reason: evidence spec 0 contradicts itself and cannot be satisfied by any implementation",
    });
    // A unit escalated some OTHER way — attempts exhausted — must not be reported to the
    // planner as a defective spec. Its contract was never in question, and sending a paid
    // decomposer to rewrite it is worse than silence: confident and wrong.
    appendUnitMetric(arena, {
      unit: "wu-tired", outcome: "escalated", time_to_verified_done_s: 1, spend_usd: 1,
      attempts: 2, reworked: true, detail: "attempts exhausted (2 of 2 recorded a reason)",
    });

    let sawTheReason = false;
    let sawTheTiredUnit = false;
    const watch: RunAgentFn = async (prompt, opts) => {
      if (prompt.includes("Gap input")) {
        if (prompt.includes("contradicts itself and cannot be satisfied")) sawTheReason = true;
        if (prompt.includes("attempts exhausted")) sawTheTiredUnit = true;
        return okSpawn(0.1);
      }
      return happyAgents()(prompt, opts);
    };
    await tick(deps(arena, watch));
    expect(sawTheReason).toBe(true);
    expect(sawTheTiredUnit).toBe(false);
    rmSync(arena, { recursive: true, force: true });
  });

  it("a unit stranded behind an escalated dependency does not freeze the intent either", async () => {
    // The real shape of the 2026-09-07 stall, and the reason admitting `escalated` alone
    // fixed nothing. `isAdmissible` requires every dependency to be MERGED, and an escalated
    // unit never merges — so wu-hours (depends on the escalated wu-core) and wu-terms
    // (depends on wu-hours) sat `ready` forever: never built, never escalated, never
    // settled. `every(...)` stayed false and the intent stayed frozen.
    //
    // wu-terms is the one that made it invisible: it never mentions the escalated unit at
    // all, and is only stranded two hops away.
    const arena = makeArena(false);
    writeFileSync(join(arena, "work", "intents", "in-x.md"), `---
id: in-x
title: An intent with a stranded tail
status: decomposed
budget_usd: 10
tier_default: reversible
acceptance:
  - kind: command
    run: "grep -q nothing-doing app.txt"
    expect: "exit 0"
---
Body.
`);
    writeFileSync(join(arena, "work", "wu-core.md"), `---
id: wu-core
title: wu-core
intent: in-x
tier: reversible
status: escalated
budget_usd: 5
evidence:
  - kind: command
    run: "true"
    expect: "exit 0"
---
Body.
`);
    writeFileSync(join(arena, "work", "wu-hours.md"), `---
id: wu-hours
title: wu-hours
intent: in-x
tier: reversible
status: ready
budget_usd: 5
depends_on:
  - wu-core
evidence:
  - kind: command
    run: "true"
    expect: "exit 0"
---
Body.
`);
    writeFileSync(join(arena, "work", "wu-terms.md"), `---
id: wu-terms
title: wu-terms
intent: in-x
tier: reversible
status: ready
budget_usd: 5
depends_on:
  - wu-hours
evidence:
  - kind: command
    run: "true"
    expect: "exit 0"
---
Body.
`);
    gitIn(arena, ["add", "-A"]);
    commit(arena, "an intent with an escalated unit and a stranded tail");
    // Another intent, already settled at the commit the retirement is about to move off.
    writeFileSync(
      join(arena, ".doctrine", "intents-settled.json"),
      JSON.stringify({ "in-other": gitIn(arena, ["rev-parse", "HEAD"]) }),
    );

    let gapDecomposeRan = false;
    const watch: RunAgentFn = async (prompt, opts) => {
      if (prompt.includes("Gap input")) { gapDecomposeRan = true; return okSpawn(0.1); }
      return happyAgents()(prompt, opts);
    };
    await tick(deps(arena, watch));
    expect(gapDecomposeRan).toBe(true);
    // And they are RETIRED on disk, not merely ignored by the grade predicate. Left `ready`,
    // they still read as open work to every other reader — the program frontier counts
    // anything not merged and not escalated — which would suppress program-decompose and
    // idle the loop forever once this intent finishes.
    expect(readFileSync(join(arena, "work", "wu-hours.md"), "utf8")).toContain("status: escalated");
    expect(readFileSync(join(arena, "work", "wu-terms.md"), "utf8")).toContain("status: escalated");

    // Settlement is keyed on the commit it describes. Retiring COMMITS, so a key captured
    // before it names a HEAD that no longer exists — and the next tick would call the intent
    // unsettled and repeat the paid grade and gap-decompose against product code that never
    // moved. Prove it settled by running a second tick: nothing paid may happen again.
    const settled = readFileSync(join(arena, ".doctrine", "intents-settled.json"), "utf8");
    expect(settled).toContain(gitIn(arena, ["rev-parse", "HEAD"]));
    // And the retirement did not un-settle anything else. It rewrote work-unit status, not
    // product code, so an intent settled at the old commit still deserves its old answer —
    // otherwise one retirement re-opens every settled intent and the next tick pays a gap
    // decompose on each to be told again what it was already told.
    expect(JSON.parse(settled)["in-other"]).toBe(gitIn(arena, ["rev-parse", "HEAD"]));
    let ranAgain = false;
    await tick(deps(arena, async (prompt, opts) => {
      if (prompt.includes("Gap input")) { ranAgain = true; return okSpawn(0.1); }
      return happyAgents()(prompt, opts);
    }));
    expect(ranAgain).toBe(false);
    rmSync(arena, { recursive: true, force: true });
  });

  it("idle when there is nothing to do", async () => {
    const arena = makeArena(false);
    const result = await tick(deps(arena, async () => { throw new Error("must not invoke"); }));
    expect(result.decision).toBe("idle");
  });

  it("manifest budget overrides reach the gates (daily gate honors the target's ceiling)", async () => {
    const arena = makeArena();
    // Tighten the target's daily ceiling below already-recorded spend.
    writeFileSync(
      join(arena, ".doctrine", "manifest.json"),
      JSON.stringify({ name: "t", base_branch: "development", doors: [], budgets: { dailySpendUsd: 1 } }),
    );
    const { appendUnitMetric } = await import("../src/ledger.js");
    appendUnitMetric(arena, { unit: "wu-old", outcome: "merged", time_to_verified_done_s: 1, spend_usd: 2, attempts: 1, reworked: false });
    const result = await tick(deps(arena, async () => { throw new Error("must not invoke"); }));
    expect(result.decision).toBe("self-halt");
    expect(result.detail).toContain("daily spend gate");
  });
});

describe("unsatisfiableUnits — the criterion-era question, and the trap it must not walk into", () => {
  // The output is not advisory here either: the caller flips every id in it to `escalated`
  // on disk. A false positive permanently retires a unit nobody asked it to retire.
  const LF = String.fromCharCode(10);
  const u = (
    id: string,
    status: string,
    over: { delivers?: string[]; renders?: string[]; dependsOn?: string[] } = {},
  ): WorkUnit => {
    const res = parseWorkUnit([
      "---", `id: ${id}`, "title: t", "tier: reversible", `status: ${status}`,
      "budget_usd: 5", "parent: ep-x#1.1",
      `delivers: [${(over.delivers ?? []).join(", ")}]`,
      `renders: [${(over.renders ?? []).join(", ")}]`,
      `depends_on: [${(over.dependsOn ?? []).join(", ")}]`,
      "evidence:", "  - kind: command", '    run: "pnpm test"', '    expect: "exit 0"',
      "---", "b", "",
    ].join(LF));
    if (!res.ok) throw new Error(res.errors.join("; "));
    return res.unit;
  };

  it("strands a unit whose criterion every naming slice has escalated on", () => {
    const set = unsatisfiableUnits([
      u("wu-core", "escalated", { delivers: ["C1.1"] }),
      u("wu-hours", "ready", { delivers: ["C1.2"], dependsOn: ["C1.1"] }),
    ]);
    expect([...set]).toEqual(["wu-hours"]);
  });

  it("does NOT strand a unit whose criterion is merely unplanned", () => {
    // Epics are minted one at a time, so a criterion the epic layer has not reached yet is
    // not one that can never be reached. Being made to wait is not being retired, and only
    // one of those is reversible.
    const set = unsatisfiableUnits([u("wu-hours", "ready", { dependsOn: ["C9.9"] })]);
    expect([...set]).toEqual([]);
  });

  it("does NOT strand a unit while one slice that could deliver the criterion survives", () => {
    const set = unsatisfiableUnits([
      u("wu-core", "escalated", { delivers: ["C1.1"] }),
      u("wu-core-b", "ready", { delivers: ["C1.1"] }),
      u("wu-hours", "ready", { dependsOn: ["C1.1"] }),
    ]);
    expect([...set]).toEqual([]);
  });

  it("waits on RENDERS as well, because a dependent waits on the renderer (ADR-0004)", () => {
    const set = unsatisfiableUnits([
      u("wu-screen", "escalated", { renders: ["C4.1"] }),
      u("wu-report", "ready", { dependsOn: ["C4.1"] }),
    ]);
    expect([...set]).toEqual(["wu-report"]);
  });

  it("is transitive through what the stranded units themselves deliver", () => {
    const set = unsatisfiableUnits([
      u("wu-core", "escalated", { delivers: ["C1.1"] }),
      u("wu-hours", "ready", { delivers: ["C2.1"], dependsOn: ["C1.1"] }),
      u("wu-terms", "ready", { dependsOn: ["C2.1"] }),
    ]);
    expect([...set].sort()).toEqual(["wu-hours", "wu-terms"]);
  });

  it("IGNORES a dependency that is not a criterion id — malformed is not unsatisfiable", () => {
    // The trap. `u-2026-09-17-payroll-sync-step` names two unit ids that are already
    // MERGED: the work it asked for is done and only the notation is stale. A rule reading
    // "not a criterion anything delivers" as "can never clear" destroys a ready unit over
    // a migration artifact. Cutover rewrites that field; this rung says nothing about it.
    const set = unsatisfiableUnits([
      u("wu-done-a", "merged", { delivers: ["C1.1"] }),
      u("wu-payroll", "ready", { dependsOn: ["wu-done-a"] }),
    ]);
    expect([...set]).toEqual([]);
  });

  it("says nothing about units that already merged or escalated", () => {
    const set = unsatisfiableUnits([
      u("wu-core", "escalated", { delivers: ["C1.1"] }),
      u("wu-old", "merged", { dependsOn: ["C1.1"] }),
    ]);
    expect([...set]).toEqual([]);
  });
});

describe("the gap planner's question moves when its blocker becomes dependable (PR #96 review)", () => {
  const LF = String.fromCharCode(10);
  const intentDoc = (run: string): string => [
    "---", "id: in-blocked", "title: t", "status: decomposed", "budget_usd: 20",
    "tier_default: reversible", "delivers: [C2.7]",
    "acceptance:", "  - kind: command", `    run: "${run}"`, '    expect: "never"',
    "---", "brief", "",
  ].join(LF);
  const mergedChild = [
    "---", "id: wu-done", "title: t", "intent: in-blocked", "tier: reversible", "status: merged",
    "budget_usd: 5", "evidence:", "  - kind: command", '    run: "true"', '    expect: "ok"', "---", "b", "",
  ].join(LF);

  function blockedArena(run: string): string {
    const arena = makeArena(false);
    writeFileSync(join(arena, "work", "intents", "in-blocked.md"), intentDoc(run));
    writeFileSync(join(arena, "work", "wu-done.md"), mergedChild);
    gitIn(arena, ["add", "-A"]);
    commit(arena, "an intent blocked on a criterion nothing plans yet");
    return arena;
  }

  /** A gap planner that honestly writes nothing, and remembers what it was told. */
  function recordingEmptyGap(): { run: RunAgentFn; prompts: string[] } {
    const prompts: string[] = [];
    const run: RunAgentFn = async (prompt, opts) => {
      prompts.push(prompt);
      mkdirSync(join(opts.logPath, ".."), { recursive: true });
      writeFileSync(opts.logPath, "");
      return { exitCode: 0, spawnFailed: false, signal: null, stdout: "", stderr: "", timedOut: false, outage: false, logPath: opts.logPath, resultMessage: { total_cost_usd: 0.1 } } as unknown as SpawnRunResult;
    };
    return { run, prompts };
  }

  it("re-asks once a unit that delivers the blocker is scaffolded — the case seen live", async () => {
    // Every check fails on the intent's OWN missing file, so the failure output does not move
    // when its blocker lands elsewhere. What blocks it is C6.3, which new-shape UNITS will
    // deliver. Read through intents alone, C6.3 could never enter the planner's list, and no
    // signature could ever have re-asked it: stuck for good, with the blocker built.
    const arena = blockedArena("echo cannot find reimbursement_open.ts && exit 1");
    const gap = recordingEmptyGap();

    expect((await tick(deps(arena, gap.run))).decision).toBe("intent-graded-fail+gap-empty");
    expect(gap.prompts[0]).toContain("Criteria you may depend on: (none)");

    // An epic scaffolds the unit that will deliver C6.3.
    writeFileSync(join(arena, "work", "wu-matches.md"), [
      "---", "id: wu-matches", "title: the matches log", "tier: reversible", "status: scaffold",
      "budget_usd: 12", "parent: ep-ledger#1.1", "delivers: [C6.3]", "renders: []", "depends_on: []",
      "---", "## Intent", "", "Payments are matched by hand.", "",
    ].join(LF));
    gitIn(arena, ["add", "-A"]);
    commit(arena, "an epic scaffolds the unit that delivers C6.3");

    const second = await tick(deps(arena, gap.run));
    expect(gap.prompts.length, "the planner's question changed, so it is asked again").toBe(2);
    expect(second.decision).toBe("intent-graded-fail+gap-empty");
    expect(gap.prompts[1]).toContain("C6.3");
  });

  it("gives a SILENT failure no skip at all — that guard was dead", async () => {
    // `failureLog` always carries a `command:` header, so the old guard never saw an empty
    // one and every failure counted as informative. A check that prints nothing says the
    // same thing whether its blocker is missing or has just landed, so skipping on it would
    // hold an intent unplanned for ever the moment it became actionable.
    const arena = blockedArena("exit 1");
    const gap = recordingEmptyGap();

    await tick(deps(arena, gap.run));
    expect(gap.prompts.length).toBe(1);

    writeFileSync(join(arena, "elsewhere.txt"), "product code moves");
    gitIn(arena, ["add", "-A"]);
    commit(arena, "something lands");

    await tick(deps(arena, gap.run));
    expect(gap.prompts.length, "silent evidence cannot be trusted to have not moved").toBe(2);
  });
});

describe("the legacy decompose rung resolves dependencies through dependableSlices", () => {
  it("accepts a gap plan whose unit waits on a criterion only a UNIT delivers", async () => {
    // Being TOLD C6.3 is dependable is worth nothing if the lint then refuses the unit that
    // uses it. With `slices: intents`, lintPlan read "depends on C6.3, which no intent
    // delivers or renders" and reverted the plan — paid for and thrown away.
    const LF = String.fromCharCode(10);
    const arena = makeArena(false);
    writeFileSync(join(arena, "work", "intents", "in-blocked.md"), [
      "---", "id: in-blocked", "title: t", "status: decomposed", "budget_usd: 20", "tier_default: reversible",
      "delivers: [C2.7]", "acceptance:", "  - kind: command", '    run: "echo cannot find reimbursement_open.ts && exit 1"',
      '    expect: "never"', "---", "brief", "",
    ].join(LF));
    writeFileSync(join(arena, "work", "wu-done.md"), [
      "---", "id: wu-done", "title: t", "intent: in-blocked", "tier: reversible", "status: merged", "budget_usd: 5",
      "evidence:", "  - kind: command", '    run: "true"', '    expect: "ok"', "---", "b", "",
    ].join(LF));
    writeFileSync(join(arena, "work", "wu-matches.md"), [
      "---", "id: wu-matches", "title: the matches log", "tier: reversible", "status: scaffold", "budget_usd: 12",
      "parent: ep-ledger#1.1", "delivers: [C6.3]", "renders: []", "depends_on: []", "---", "## Intent", "", "Why.", "",
    ].join(LF));
    gitIn(arena, ["add", "-A"]);
    commit(arena, "blocked on C6.3, which a scaffolded unit will deliver");

    const planner: RunAgentFn = async (prompt, opts) => {
      if (prompt.includes("# Your plan to judge")) {
        const verdictPath = /write the verdict JSON to EXACTLY: (.+)/.exec(prompt)![1]!.trim();
        writeFileSync(verdictPath, JSON.stringify({
          intent: "in-blocked", verdict: "pass", judged: true,
          units: [{ id: "wu-reimb", ok: true, cite: "brief", problems: [] }],
          rival_check: "grepped repo and contracts — none",
        }));
        return okSpawn(0.1);
      }
      expect(prompt).toContain("C6.3");
      writeFileSync(join(opts.cwd, "work", "wu-reimb.md"), [
        "---", "id: wu-reimb", "title: the producer", "tier: reversible", "status: draft", "budget_usd: 5",
        "intent: in-blocked", "depends_on: [C6.3]",
        "evidence:", "  - kind: command", '    run: "true"', '    expect: "ok"', "---", "b", "",
      ].join(LF));
      return okSpawn(0.2);
    };
    const r = await tick(deps(arena, planner));
    expect(r.decision, r.detail ?? "").toBe("intent-graded-fail+gap-decomposed");
    expect(readFileSync(join(arena, "work", "wu-reimb.md"), "utf8")).toContain("status: ready");
  });
});

describe("an escalated-only blocker enters the planner's list when a replacement is scaffolded", () => {
  it("re-asks — the criterion was not on offer until something live would build it", async () => {
    // Review's round-two case on #96. Hashing criterion IDs alone, an escalated unit and its
    // scaffolded replacement name the same C9.1 and the key does not move, so the intent stays
    // settled with a viable source now in the tree. With escalated units out of the dependable
    // set, C9.1 is simply not offered until the replacement exists — then it is, and the key moves.
    const LF = String.fromCharCode(10);
    const arena = makeArena(false);
    writeFileSync(join(arena, "work", "intents", "in-blocked.md"), [
      "---", "id: in-blocked", "title: t", "status: decomposed", "budget_usd: 20", "tier_default: reversible",
      "delivers: [C2.7]", "acceptance:", "  - kind: command", '    run: "echo cannot find its own file && exit 1"',
      '    expect: "never"', "---", "brief", "",
    ].join(LF));
    writeFileSync(join(arena, "work", "wu-done.md"), [
      "---", "id: wu-done", "title: t", "intent: in-blocked", "tier: reversible", "status: merged", "budget_usd: 5",
      "evidence:", "  - kind: command", '    run: "true"', '    expect: "ok"', "---", "b", "",
    ].join(LF));
    const unit = (id: string, status: string, withEvidence: boolean): string => [
      "---", `id: ${id}`, "title: t", "tier: reversible", `status: ${status}`, "budget_usd: 5",
      "parent: ep-x#1.1", "delivers: [C9.1]", "renders: []", "depends_on: []",
      ...(withEvidence ? ["evidence:", "  - kind: command", '    run: "true"', '    expect: "ok"'] : []),
      "---", "## Intent", "", "Why.", "",
    ].join(LF);
    writeFileSync(join(arena, "work", "wu-first.md"), unit("wu-first", "escalated", true));
    gitIn(arena, ["add", "-A"]);
    commit(arena, "the only unit for C9.1 escalated");

    const prompts: string[] = [];
    const gap: RunAgentFn = async (prompt, opts) => {
      prompts.push(prompt);
      mkdirSync(join(opts.logPath, ".."), { recursive: true });
      writeFileSync(opts.logPath, "");
      return { exitCode: 0, spawnFailed: false, signal: null, stdout: "", stderr: "", timedOut: false, outage: false, logPath: opts.logPath, resultMessage: { total_cost_usd: 0.1 } } as unknown as SpawnRunResult;
    };

    expect((await tick(deps(arena, gap))).decision).toBe("intent-graded-fail+gap-empty");
    expect(prompts[0], "nothing live builds C9.1, so it is not on offer").not.toContain("C9.1");

    writeFileSync(join(arena, "work", "wu-replacement.md"), unit("wu-replacement", "scaffold", false));
    gitIn(arena, ["add", "-A"]);
    commit(arena, "the ratchet scaffolds a replacement for C9.1");

    await tick(deps(arena, gap));
    expect(prompts.length, "a live source now exists, so the question changed").toBe(2);
    expect(prompts[1]).toContain("C9.1");
  });
});
