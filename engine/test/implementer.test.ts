import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { assembleImplementerPrompt, runImplementer, type ImplementContext } from "../src/implementer.js";
import type { RunAgentFn } from "../src/judge.js";
import type { SpawnRunResult } from "../src/spawn.js";
import { parseWorkUnit, type WorkUnit } from "../src/work-unit.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-impl-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const AGENT_DEF = fileURLToPath(new URL("../../.claude/agents/implementer.md", import.meta.url));

function makeArena(): string {
  const dir = mkdtempSync(join(tmp, "arena-"));
  const g = (args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  g(["init", "-b", "development"]);
  writeFileSync(join(dir, "app.txt"), "v1\n");
  g(["add", "-A"]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

function unit(): WorkUnit {
  const res = parseWorkUnit(`---
id: wu-x
title: Change app.txt to v2
tier: reversible
status: ready
budget_usd: 5
evidence:
  - kind: command
    run: "grep -q v2 app.txt"
    expect: "exit 0 on head"
---
Bump the marker. MARKER-IMPL-BODY.
`);
  if (!res.ok) throw new Error("fixture must parse");
  return res.unit;
}

function okSpawn(cost = 0.4): SpawnRunResult {
  return {
    spawnFailed: false,
    exitCode: 0,
    signal: null,
    timedOut: false,
    outage: false,
    logPath: "x",
    resultMessage: { type: "result", subtype: "success", total_cost_usd: cost },
  };
}

let n = 0;
function ctx(arenaDir: string, runAgent: RunAgentFn): ImplementContext {
  const runDir = join(tmp, `run-${n++}`);
  mkdirSync(runDir, { recursive: true });
  return {
    unit: unit(),
    arenaDir,
    baseBranch: "development",
    worktreeDir: join(runDir, "wt"),
    logPath: join(runDir, "impl.log"),
    agentDefinitionPath: AGENT_DEF,
    runAgent,
  };
}

const gitIn = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("assembleImplementerPrompt", () => {
  it("carries the law, the unit, and the evidence specs", () => {
    const c = ctx(makeArena(), async () => okSpawn());
    // Prompt assembly needs no worktree; call directly.
    const prompt = assembleImplementerPrompt(c);
    expect(prompt).toContain("Red first");
    expect(prompt).toContain("MARKER-IMPL-BODY");
    expect(prompt).toContain("grep -q v2 app.txt");
  });
});

describe("runImplementer — trusts the branch head, not the agent", () => {
  it("implemented: agent edits + commits; head moved", async () => {
    const arena = makeArena();
    const fake: RunAgentFn = async (_prompt, opts) => {
      writeFileSync(join(opts.cwd, "app.txt"), "v2\n");
      gitIn(opts.cwd, ["add", "-A"]);
      execFileSync("git", ["-c", "user.name=i", "-c", "user.email=i@i", "commit", "-q", "-m", "feat: v2"], {
        cwd: opts.cwd,
      });
      return okSpawn();
    };
    const outcome = await runImplementer(ctx(arena, fake));
    expect(outcome.kind).toBe("implemented");
    if (outcome.kind !== "implemented") return;
    expect(outcome.headSha).not.toBe(outcome.baseSha);
    expect(outcome.branch).toContain("doctrine/wu-x-");
    expect(outcome.spendUsd).toBeCloseTo(0.4);
  });

  it("salvage: uncommitted agent work is committed by the ENGINE, not lost", async () => {
    const arena = makeArena();
    const fake: RunAgentFn = async (_prompt, opts) => {
      writeFileSync(join(opts.cwd, "app.txt"), "v2\n"); // edited, never committed
      return okSpawn();
    };
    const outcome = await runImplementer(ctx(arena, fake));
    expect(outcome.kind).toBe("implemented");
    if (outcome.kind !== "implemented") return;
    const lastMsg = gitIn(outcome.worktreeDir, ["log", "-1", "--format=%s"]);
    expect(lastMsg).toContain("salvage");
  });

  it("no-commit: an agent that does nothing is an honest failure", async () => {
    const outcome = await runImplementer(ctx(makeArena(), async () => okSpawn()));
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toBe("no-commit");
  });

  it("spawn-level failures pass through with the outage modifier", async () => {
    const fake: RunAgentFn = async () => ({
      ...okSpawn(0),
      exitCode: 1,
      outage: true,
      resultMessage: { type: "result", subtype: "success", is_error: true, api_error_status: 529, total_cost_usd: 0 },
    });
    const outcome = await runImplementer(ctx(makeArena(), fake));
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toBe("nonzero-exit");
    expect(outcome.outage).toBe(true);
  });
});

describe("a retry is a second attempt at the problem, not the same attempt twice", () => {
  // Observed on a target's first UI unit: two runs at ~$17 each against one spec.
  // Five design findings were fixed, five new ones appeared, and the two structural ones
  // survived both times — because nothing carried the first verdict into the second run.
  // The decompose rung has fed its prior rejection back since 2026-08-24 and the program
  // rung since #18; the rung that writes the code fed back nothing.
  const base = {
    unit: {
      id: "wu-x", title: "t", tier: "reversible", status: "ready", budgetUsd: 5,
      intent: "in-x", dependsOn: [], body: "b",
      evidence: [{ kind: "command", run: "pnpm test", expect: "exit 0" }],
    },
    arenaDir: ".", baseBranch: "development", worktreeDir: ".",
    logPath: "l", agentDefinitionPath: AGENT_DEF,
  } as never;

  it("puts every prior verdict in the prompt, newest last", () => {
    const prompt = assembleImplementerPrompt({
      ...(base as object),
      priorFailures: [
        "design-judge: lines.png (the Amount column): token-used-against-its-meaning",
        "design-judge: lines-narrow.png (the stacked rows): label-lost-at-breakpoint",
      ],
    } as never);
    expect(prompt).toContain("Earlier attempts at this unit were rejected");
    expect(prompt).toContain("token-used-against-its-meaning");
    expect(prompt).toContain("label-lost-at-breakpoint");
    // Order matters: the newest verdict is the one describing the code that just failed.
    expect(prompt.indexOf("token-used-against-its-meaning"))
      .toBeLessThan(prompt.indexOf("label-lost-at-breakpoint"));
  });

  it("tells the retry the fixes did not survive, because they did not", () => {
    // Each attempt cuts a fresh worktree from the same base, so a finding phrased as
    // "you already fixed this" would be a lie and the wrong instruction.
    const prompt = assembleImplementerPrompt({
      ...(base as object),
      priorFailures: ["design-judge: something"],
    } as never);
    // Whitespace-normalised: the prompt wraps, and a test that pins line breaks pins
    // the wrong thing.
    expect(prompt.replace(/\s+/g, " ")).toContain("none of the fixes survive");
  });

  it("says nothing at all when there is no prior attempt", () => {
    const first = assembleImplementerPrompt(base);
    expect(first).not.toContain("Earlier attempts");
    // And an empty or whitespace-only list is the same as none — a retry handed
    // "failed attempt" with no content is worse off than one handed nothing, because
    // it looks like information.
    const empty = assembleImplementerPrompt({ ...(base as object), priorFailures: ["", "  "] } as never);
    expect(empty).not.toContain("Earlier attempts");
  });
});
