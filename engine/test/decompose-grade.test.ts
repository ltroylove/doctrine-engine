import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { decomposeTimeoutMs, runDecompose, type DecomposeContext } from "../src/decompose.js";
import { runIntentGrade } from "../src/grade.js";
import { parseIntent, type Intent } from "../src/intent.js";
import type { RunAgentFn } from "../src/judge.js";
import type { SpawnRunResult } from "../src/spawn.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-dg-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const AGENT_DEF = fileURLToPath(new URL("../../.claude/agents/decomposer.md", import.meta.url));
const PLAN_JUDGE_DEF = fileURLToPath(new URL("../../.claude/agents/plan-judge.md", import.meta.url));

/** Answer the plan-judge leg of runDecompose; delegate everything else to `inner`. */
function withPlanJudge(inner: RunAgentFn, verdict: "pass" | "fail" = "pass"): RunAgentFn {
  return async (prompt, opts) => {
    if (!prompt.includes("# Your plan to judge")) return inner(prompt, opts);
    const verdictPath = /write the verdict JSON to EXACTLY: (.+)/.exec(prompt)![1]!.trim();
    const ids = /cover exactly these ids: ([^)]+)\)/.exec(prompt)![1]!.split(",").map((s) => s.trim());
    writeFileSync(
      verdictPath,
      JSON.stringify({
        intent: "in-csv",
        verdict,
        judged: true,
        units: ids.map((id, i) => verdict === "pass" || i > 0
          ? { id, ok: true, cite: "Add export.", problems: [] }
          : { id, ok: false, cite: "", problems: ["invented scope — no intent text supports this unit"] }),
        rival_check: "grepped src/ and context/contracts.md — no rivals",
      }),
    );
    return okSpawn();
  };
}

const INTENT_MD = `---
id: in-csv
title: CSV export
status: ready
budget_usd: 20
tier_default: reversible
acceptance:
  - kind: command
    run: "test -f EXPORT_DONE"
    expect: "marker exists after all children merge"
---
Add export.
`;

function intent(): Intent {
  const r = parseIntent(INTENT_MD);
  if (!r.ok) throw new Error("fixture");
  return r.intent;
}

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeArena(): string {
  const dir = mkdtempSync(join(tmp, "arena-"));
  gitIn(dir, ["init", "-b", "development"]);
  mkdirSync(join(dir, "work", "intents"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export const x = 1;\n");
  writeFileSync(join(dir, "work", "intents", "in-csv.md"), INTENT_MD);
  gitIn(dir, ["add", "-A"]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

const okSpawn = (): SpawnRunResult => ({
  spawnFailed: false, exitCode: 0, signal: null, timedOut: false, outage: false,
  logPath: "x", resultMessage: { type: "result", subtype: "success", total_cost_usd: 0.2 },
});

const GOOD_UNIT = (id: string, deps = "[]") => `---
id: ${id}
title: t
tier: reversible
status: draft
budget_usd: 5
intent: in-csv
depends_on: ${deps}
evidence:
  - kind: command
    run: "pnpm test"
    expect: "exit 0"
---
b
`;

let n = 0;
function ctx(arenaDir: string, runAgent: RunAgentFn, extra: Partial<DecomposeContext> = {}): DecomposeContext {
  return {
    intent: intent(),
    arenaDir,
    logPath: join(tmp, `dec-${n++}.log`),
    agentDefinitionPath: AGENT_DEF,
    planJudgeAgentPath: PLAN_JUDGE_DEF,
    budgetUsd: 3,
    // One other intent delivers C1.1, so a unit of this plan may legally wait on it.
    slices: [{ id: "in-other", delivers: ["C1.1"], renders: [] }],
    runAgent,
    ...extra,
  };
}

describe("runDecompose", () => {
  it("lint-promotes a valid plan: drafts -> ready, intent -> decomposed, one commit", async () => {
    const arena = makeArena();
    const fake: RunAgentFn = async (_p, opts) => {
      writeFileSync(join(opts.cwd, "work", "wu-a.md"), GOOD_UNIT("wu-a"));
      writeFileSync(join(opts.cwd, "work", "wu-b.md"), GOOD_UNIT("wu-b", "[C1.1]"));
      return okSpawn();
    };
    const out = await runDecompose(ctx(arena, withPlanJudge(fake)));
    expect(out.kind).toBe("decomposed");
    if (out.kind !== "decomposed") return;
    expect(out.unitIds.sort()).toEqual(["wu-a", "wu-b"]);
    expect(readFileSync(join(arena, "work", "wu-a.md"), "utf8")).toContain("status: ready");
    expect(readFileSync(join(arena, "work", "intents", "in-csv.md"), "utf8")).toContain("status: decomposed");
    // The plan is committed, and ONLY the plan. The engine's own ledgers live in
    // .doctrine/ and are appended every tick; sweeping them into a commit here is what
    // put a two-line ticks.jsonl snapshot on a unit branch and made the next checkout
    // of that branch refuse (on the first production unit).
    const staged = gitIn(arena, ["show", "--name-only", "--format=", "HEAD"]).split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    expect(staged).toContain("work/wu-a.md");
    expect(staged.some((f) => f.startsWith(".doctrine/"))).toBe(false);
    expect(gitIn(arena, ["status", "--porcelain", "--", "work", "context"])).toBe("");
    expect(gitIn(arena, ["log", "-1", "--format=%s"])).toContain("decompose in-csv");
  });

  it("the grade installs the arena's declared dependencies before measuring against them", () => {
    // Units are built and judged in worktrees, each of which gets the setup command run
    // in it. The arena root does not — so on a target being built from nothing, the
    // grade ran against the install from onboarding, against a package.json the landed
    // units had since rewritten. The harness intent failed its grade on "Cannot find
    // module 'vitest'" with all six units green and all nine acceptance commands
    // passing the moment the arena was installed.
    const arena = makeArena();
    const marker = join(arena, "setup-ran.txt");
    const gradeIntent = intent();
    gradeIntent.evidence = [{ kind: "command", run: "test -f setup-ran.txt", expect: "the setup command ran first" }];

    // Without setup the acceptance cannot pass: it depends on what setup creates.
    expect(runIntentGrade(arena, gradeIntent).kind).toBe("fail");
    expect(existsSync(marker)).toBe(false);

    // With it, the grade passes — which is only possible if setup ran BEFORE the
    // acceptance command, not after it. The command deliberately carries quoting and a
    // redirection: setup runs through a shell, so a manifest may use the same command
    // language as its evidence rather than a space-split subset (doctrine#10 review).
    const out = runIntentGrade(arena, gradeIntent, "echo 'a b' > setup-ran.txt");
    expect(out.kind).toBe("pass");
    expect(existsSync(marker)).toBe(true);
  });

  it("a decomposer that touches code is reverted wholesale", async () => {
    const arena = makeArena();
    const fake: RunAgentFn = async (_p, opts) => {
      writeFileSync(join(opts.cwd, "work", "wu-a.md"), GOOD_UNIT("wu-a"));
      writeFileSync(join(opts.cwd, "src", "app.ts"), "export const x = 999;\n"); // forbidden
      return okSpawn();
    };
    const out = await runDecompose(ctx(arena, fake));
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.problems.join()).toContain("src/app.ts");
    expect(readFileSync(join(arena, "src", "app.ts"), "utf8")).toContain("x = 1"); // reverted
    expect(existsSync(join(arena, "work", "wu-a.md"))).toBe(false); // reverted
  });

  it("...including a file that did not exist before, which is the half that was broken", async () => {
    // The test above passes and always did: it edits a TRACKED `src/app.ts`, and
    // `git checkout -- .` restores tracked files. An UNTRACKED one needs `git clean`, and
    // the clean was given a fixed `work context` list — so a decomposer creating a new
    // file outside its lane was detected, reported as "reverted wholesale", and left the
    // file on disk for the next tick to inherit.
    //
    // Both of this function's siblings had been fixed months earlier (`program.ts` even
    // carries a comment about the stray `src/app.ts` that taught it). This one had not:
    // the same one-path-not-its-sibling shape, hidden behind a test that covered the
    // working half. Filed as doctrine#67 from reading, not from a failure.
    const arena = makeArena();
    const fake: RunAgentFn = async (_p, opts) => {
      writeFileSync(join(opts.cwd, "work", "wu-a.md"), GOOD_UNIT("wu-a"));
      mkdirSync(join(opts.cwd, "scripts"), { recursive: true });
      writeFileSync(join(opts.cwd, "scripts", "sneaky.ts"), "export const x = 999;");
      return okSpawn();
    };
    const out = await runDecompose(ctx(arena, fake));
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.problems.join()).toContain("scripts/sneaky.ts");
    expect(existsSync(join(arena, "scripts", "sneaky.ts"))).toBe(false);
  });

  it("...and on the branches that revert BEFORE anything inspects the diff", async () => {
    // The first fix passed the touched paths in from the one branch that had already
    // computed them — and there are six cleanup branches. A timeout, a nonzero exit or an
    // engine-state tamper all revert before `changedFiles` is ever called, so an ACT could
    // write a stray file, then fail, and five of six paths would still leave it behind.
    //
    // That is the same one-path-not-its-sibling shape the fix was FOR, reappearing among
    // the call sites of the function being fixed. `revertAll` now derives the paths from
    // git itself, so there is no argument a caller can forget.
    const arena = makeArena();
    const fake: RunAgentFn = async (_p, opts) => {
      mkdirSync(join(opts.cwd, "scripts"), { recursive: true });
      writeFileSync(join(opts.cwd, "scripts", "stray.ts"), "export const x = 999;");
      // ...and then die, before any inspection of what was written.
      return { ...okSpawn(), exitCode: 1, resultMessage: undefined } as unknown as SpawnRunResult;
    };
    const out = await runDecompose(ctx(arena, fake));
    expect(out.kind).toBe("failed");
    expect(existsSync(join(arena, "scripts", "stray.ts"))).toBe(false);
  });

  it("a lint-failing plan is reverted with reasons", async () => {
    const arena = makeArena();
    const fake: RunAgentFn = async (_p, opts) => {
      writeFileSync(join(opts.cwd, "work", "wu-a.md"), GOOD_UNIT("wu-a", "[wu-ghost]"));
      return okSpawn();
    };
    const out = await runDecompose(ctx(arena, fake));
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.problems.join("\n")).toContain("wu-ghost");
    expect(existsSync(join(arena, "work", "wu-a.md"))).toBe(false);
  });

  it("the decompose timeout scales with the intent, so a big plan is not killed mid-flight", () => {
    // The flat 15 minutes fit the arena and killed a real target's walking-skeleton
    // intent 17 minutes in, on a 684KB transcript of real work. Worse than slow: a
    // killed run returns no result message, so the spend is real and the ledger records
    // $0 — invisible to the daily gate, and it would have repeated until the failure
    // halt, at 15 paid minutes an attempt. The program rung hit this first and went
    // from 15 to 30; 30 is that proven number, and 15 stays the floor.
    // Argument is the ACT's own budget, because that is what actually bounds the run.
    expect(decomposeTimeoutMs(3)).toBe(15 * 60_000);   // the arena's floor
    expect(decomposeTimeoutMs(5)).toBe(20 * 60_000);   // scales between
    // The ceiling case: $10 at the measured ~$0.36/min is ~28 minutes of work, so the
    // clock has to sit well clear of it or the timeout is again what stops the run.
    expect(decomposeTimeoutMs(10)).toBe(40 * 60_000);
    expect(decomposeTimeoutMs(99)).toBe(45 * 60_000);  // capped: a hang is still caught
  });

  it("an empty plan is an honest outcome, not a failure", async () => {
    const out = await runDecompose(ctx(makeArena(), async () => okSpawn()));
    expect(out.kind).toBe("empty");
  });

  it("revert spares the ledgers: a failed decompose must not wipe uncommitted metrics rows", async () => {
    const arena = makeArena();
    // A tracked ledger with an uncommitted append — the failure-halt's raw data.
    mkdirSync(join(arena, ".doctrine"), { recursive: true });
    writeFileSync(join(arena, ".doctrine", "metrics.jsonl"), '{"type":"decompose","outcome":"failed","spend_usd":3}\n');
    gitIn(arena, ["add", "-A"]);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "ledger"], { cwd: arena });
    appendFileSync(join(arena, ".doctrine", "metrics.jsonl"), '{"type":"decompose","outcome":"failed","spend_usd":4}\n');

    const fake: RunAgentFn = async (_p, opts) => {
      writeFileSync(join(opts.cwd, "work", "wu-a.md"), GOOD_UNIT("wu-a"));
      writeFileSync(join(opts.cwd, "src", "app.ts"), "export const x = 999;\n"); // forbidden -> revert
      return okSpawn();
    };
    const out = await runDecompose(ctx(arena, fake));
    expect(out.kind).toBe("failed");
    expect(readFileSync(join(arena, "src", "app.ts"), "utf8")).toContain("x = 1"); // code reverted
    // Both ledger rows survive the revert.
    expect(readFileSync(join(arena, ".doctrine", "metrics.jsonl"), "utf8")).toContain('"spend_usd":4');
  });

  it("a plan the plan-judge rejects is reverted wholesale — lint-clean is not enough", async () => {
    const arena = makeArena();
    const fake: RunAgentFn = async (_p, opts) => {
      writeFileSync(join(opts.cwd, "work", "wu-a.md"), GOOD_UNIT("wu-a"));
      return okSpawn();
    };
    const out = await runDecompose(ctx(arena, withPlanJudge(fake, "fail")));
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toBe("plan-judge rejected the plan");
    expect(out.problems.join("\n")).toContain("invented scope");
    expect(existsSync(join(arena, "work", "wu-a.md"))).toBe(false); // reverted
  });

  it("a missing plan-verdict fails the decompose loudly — no silent skip", async () => {
    const arena = makeArena();
    const fake: RunAgentFn = async (prompt, opts) => {
      if (prompt.includes("# Your plan to judge")) return okSpawn(); // writes NO verdict
      writeFileSync(join(opts.cwd, "work", "wu-a.md"), GOOD_UNIT("wu-a"));
      return okSpawn();
    };
    const out = await runDecompose(ctx(arena, fake));
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toContain("missing-plan-verdict");
    expect(existsSync(join(arena, "work", "wu-a.md"))).toBe(false);
  });

  it("gap input from a failed grade reaches the prompt", async () => {
    let prompt = "";
    const fake: RunAgentFn = async (p) => {
      prompt = p;
      return okSpawn();
    };
    await runDecompose(ctx(makeArena(), fake, { gradeFailureLog: "command: test -f EXPORT_DONE\nexit: 1" }));
    expect(prompt).toContain("Gap input");
    expect(prompt).toContain("EXPORT_DONE");
  });

  it("a prior plan-judge rejection reaches the prompt — the cycle converges instead of re-minting", async () => {
    let prompt = "";
    const fake: RunAgentFn = async (p) => {
      prompt = p;
      return okSpawn();
    };
    await runDecompose(ctx(makeArena(), fake, {
      priorRejection: "plan-judge rejected the plan: wu-bad: invented scope — no intent text supports it",
    }));
    expect(prompt).toContain("Prior plan REJECTED");
    expect(prompt).toContain("wu-bad: invented scope");
  });
});

describe("runIntentGrade — coverage settled by reality, no LLM", () => {
  it("fails while the acceptance marker is missing, passes once it exists", () => {
    const arena = makeArena();
    // Mark decomposed first (grade flips decomposed -> done).
    const ip = join(arena, "work", "intents", "in-csv.md");
    writeFileSync(ip, readFileSync(ip, "utf8").replace("status: ready", "status: decomposed"));

    const fail = runIntentGrade(arena, { ...intent(), status: "decomposed" });
    expect(fail.kind).toBe("fail");
    if (fail.kind !== "fail") return;
    expect(fail.failureLog).toContain("test -f EXPORT_DONE");

    writeFileSync(join(arena, "EXPORT_DONE"), "done\n");
    const pass = runIntentGrade(arena, { ...intent(), status: "decomposed" });
    expect(pass.kind).toBe("pass");
    expect(readFileSync(ip, "utf8")).toContain("status: done");
    expect(pass.kind === "pass" && pass.runs[0]!.exit_code).toBe(0);
  });
});
