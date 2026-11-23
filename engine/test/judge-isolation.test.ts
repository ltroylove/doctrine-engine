import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runJudge, judgePaths, type JudgeContext } from "../src/judge.js";
import { assemblePlanJudgePrompt, runPlanJudge } from "../src/plan-judge.js";
import type { SpawnRunResult } from "../src/spawn.js";
import { parseWorkUnit, type WorkUnit } from "../src/work-unit.js";
import type { Intent } from "../src/intent.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-isolation-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const UNIT_MD = `---
id: wu-i
title: A unit
tier: reversible
status: ready
budget_usd: 5
evidence:
  - kind: command
    run: "true"
    expect: "exit 0"
---
Body.
`;

function unit(): WorkUnit {
  const p = parseWorkUnit(UNIT_MD);
  if (!p.ok) throw new Error("fixture");
  return p.unit;
}

function spawnResult(): SpawnRunResult {
  return {
    exitCode: 0, spawnFailed: false, signal: null, stdout: "", stderr: "",
    timedOut: false, outage: false, logPath: "", resultMessage: { type: "result", subtype: "success", total_cost_usd: 0.1 },
  } as unknown as SpawnRunResult;
}

/**
 * The judge and plan-judge run from a scratch directory outside every repository, so
 * Claude Code's gitStatus block has no repo to describe and cannot hand them the
 * implementer's or the planner's own commit subject. Two things that must hold for
 * that to be safe rather than merely quiet, both caught by review on doctrine#8.
 */
describe("judge isolation — a scratch cwd that is cleaned up and does not hide the repo", () => {
  it("the code-judge runs outside any repo, and leaves no scratch directory behind", async () => {
    const runDir = join(tmp, "run-a");
    const headDir = join(tmp, "head-a");
    const baseDir = join(tmp, "base-a");
    for (const d of [runDir, headDir, baseDir]) mkdirSync(d, { recursive: true });
    const { verdictPath, logPath } = judgePaths(runDir);
    writeFileSync(join(runDir, "diff.patch"), "");

    let seenCwd = "";

    const ctx: JudgeContext = {
      unit: unit(), baseDir, headDir, baseSha: "a", headSha: "b",
      diffPath: join(runDir, "diff.patch"), verdictPath, logPath,
      requiredGates: ["diff-read", "evidence-executed"], budgetUsd: 5,
      agentDefinitionPath: join(tmp, "law.md"),
      runAgent: async (_prompt, opts) => {
        seenCwd = opts.cwd;
        // The scratch dir exists WHILE the agent runs — it is a real cwd, not a fiction.
        expect(existsSync(opts.cwd)).toBe(true);
        writeFileSync(verdictPath, "not a verdict");
        return spawnResult();
      },
    };
    writeFileSync(join(tmp, "law.md"), "---\nname: j\n---\nlaw\n");

    await runJudge(ctx);

    // Not the head worktree, and not any repo: that is the whole point.
    expect(seenCwd).not.toBe(headDir);
    expect(seenCwd).not.toBe(baseDir);
    expect(seenCwd.includes("doctrine-judge-")).toBe(true);
    // ...and it is gone afterwards. A supervisor runs indefinitely; one leaked
    // directory per judged unit is unbounded.
    // Asserted on THIS run's path only. Scanning the shared temp dir for leftover
    // doctrine-judge-* entries reads as a leak whenever another suite is mid-judge in
    // the same run — the assertion was true and the test was still wrong.
    expect(existsSync(seenCwd)).toBe(false);
  });

  it("the plan-judge is TOLD the arena root, because it is no longer its working directory", () => {
    // Moving the cwd without moving the prompt would have made every relative Read,
    // Grep and Glob resolve inside an empty directory — so contracts.md and the source
    // tree would read as missing, and "missing" is not evidence of anything.
    const arenaDir = join(tmp, "arena-b");
    mkdirSync(join(arenaDir, "work"), { recursive: true });
    writeFileSync(join(arenaDir, "work", "wu-i.md"), UNIT_MD);
    writeFileSync(join(tmp, "plan-law.md"), "---\nname: pj\n---\nplan law\n");

    const intent: Intent = {
      id: "in-i", title: "t", status: "ready", budgetUsd: 20,
      tier: "reversible", evidence: [{ kind: "command", run: "true", expect: "exit 0" }],
      delivers: [], renders: [], dependsOn: [], body: "brief",
    };
    const prompt = assemblePlanJudgePrompt({
      intent, arenaDir, children: [unit()], unitFiles: [join("work", "wu-i.md")],
      verdictPath: join(tmp, "pv.json"), logPath: join(tmp, "pj.log"),
      budgetUsd: 5, agentDefinitionPath: join(tmp, "plan-law.md"),
    });

    expect(prompt).toContain(arenaDir);
    expect(prompt).not.toContain("source tree): your working directory");
    expect(prompt.toLowerCase()).toContain("not your working directory");
  });

  it("the plan-judge cleans up its scratch directory too", async () => {
    const arenaDir = join(tmp, "arena-c");
    mkdirSync(join(arenaDir, "work"), { recursive: true });
    writeFileSync(join(arenaDir, "work", "wu-i.md"), UNIT_MD);
    writeFileSync(join(tmp, "plan-law-c.md"), "---\nname: pj\n---\nplan law\n");

    let seenCwd = "";
    const intent: Intent = {
      id: "in-c", title: "t", status: "ready", budgetUsd: 20,
      tier: "reversible", evidence: [{ kind: "command", run: "true", expect: "exit 0" }],
      delivers: [], renders: [], dependsOn: [], body: "brief",
    };
    await runPlanJudge({
      intent, arenaDir, children: [unit()], unitFiles: [join("work", "wu-i.md")],
      verdictPath: join(tmp, "pv-c.json"), logPath: join(tmp, "pj-c.log"),
      budgetUsd: 5, agentDefinitionPath: join(tmp, "plan-law-c.md"),
      runAgent: async (_p, opts) => {
        seenCwd = opts.cwd;
        return spawnResult();
      },
    });

    expect(seenCwd.includes("doctrine-plan-judge-")).toBe(true);
    expect(seenCwd).not.toBe(arenaDir);
    expect(existsSync(seenCwd)).toBe(false);
  });
});
