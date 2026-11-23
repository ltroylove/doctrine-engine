import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { assembleJudgePrompt, runJudge, judgePaths, type JudgeContext, type RunAgentFn } from "../src/judge.js";
import type { SpawnRunResult } from "../src/spawn.js";
import { parseWorkUnit, type WorkUnit } from "../src/work-unit.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-judge-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// The real agent definition is part of the contract under test.
const AGENT_DEF = fileURLToPath(new URL("../../.claude/agents/code-judge.md", import.meta.url));

function unit(): WorkUnit {
  const res = parseWorkUnit(`---
id: wu-x
title: Fix rounding
tier: reversible
status: ready
budget_usd: 5
evidence:
  - kind: test
    run: "pnpm vitest run test/x.test.ts"
    expect: "fails on base, passes on head"
---
Round to one decimal in the summary card. MARKER-UNIT-BODY.
`);
  if (!res.ok) throw new Error("fixture must parse");
  return res.unit;
}

let n = 0;
function ctx(runAgent: RunAgentFn): JudgeContext {
  const runDir = join(tmp, `run-${n++}`);
  mkdirSync(runDir, { recursive: true });
  const { verdictPath, logPath } = judgePaths(runDir);
  return {
    unit: unit(),
    baseDir: join(tmp, "base"),
    headDir: join(tmp, "head"),
    baseSha: "aaa111",
    headSha: "bbb222",
    diffPath: join(runDir, "diff.patch"),
    verdictPath,
    logPath,
    requiredGates: ["diff-read", "evidence-executed"],
    budgetUsd: 3,
    agentDefinitionPath: AGENT_DEF,
    registryChecks: ["DP-01: status-inflation — check claimed vs actual state moves"],
    runAgent,
  };
}

function okSpawn(): SpawnRunResult {
  return {
    spawnFailed: false,
    exitCode: 0,
    signal: null,
    timedOut: false,
    outage: false,
    logPath: "x",
    resultMessage: { type: "result", subtype: "success", total_cost_usd: 0.3 },
  };
}

function goodVerdictFor(c: JudgeContext): Record<string, unknown> {
  return {
    unit: c.unit.id,
    verdict: "pass",
    judged: true,
    coherence: [{ criterion: "scope", ok: true, quote: "only summary-card files touched" }],
    evidence: [
      {
        spec: c.unit.evidence[0]!.run,
        run: { command: c.unit.evidence[0]!.run, exit_code: 0, output_sha256: "ff00", log: "evidence-0.log" },
        ok: true,
      },
    ],
    gates_executed: ["diff-read", "evidence-executed"],
    base_sha: c.baseSha,
    head_sha: c.headSha,
    spend_usd: 0.3,
  };
}

describe("assembleJudgePrompt — isolation by construction", () => {
  it("contains the law, the unit contract, evidence specs, paths, and gates — and only that", () => {
    const c = ctx(async () => okSpawn());
    const prompt = assembleJudgePrompt(c);
    expect(prompt).toContain("isolation law");
    expect(prompt).toContain("MARKER-UNIT-BODY");
    expect(prompt).toContain("pnpm vitest run test/x.test.ts");
    expect(prompt).toContain(c.verdictPath);
    expect(prompt).toContain("DP-01");
    expect(prompt).toContain("- diff-read");
    expect(prompt).toContain("never git history");
  });
});

describe("runJudge — trusts artifacts, never claims", () => {
  it("accepts only a validated verdict artifact", async () => {
    let received: { prompt: string; argv: string[] } | null = null;
    const fake: RunAgentFn = async (prompt, opts) => {
      received = { prompt, argv: opts.argv };
      // The fake judge writes a proper verdict — as the real one must.
      writeFileSync(theCtx.verdictPath, JSON.stringify(goodVerdictFor(theCtx)));
      return okSpawn();
    };
    const theCtx = ctx(fake);
    const outcome = await runJudge(theCtx);
    expect(outcome.kind).toBe("judged");
    if (outcome.kind !== "judged") return;
    expect(outcome.verdict.verdict).toBe("pass");
    // Budget cap and restricted tool surface travel on argv.
    expect(received!.argv).toContain("--max-budget-usd");
    expect(received!.argv[received!.argv.indexOf("--max-budget-usd") + 1]).toBe("3");
    expect(received!.argv[received!.argv.indexOf("--allowedTools") + 1]).toBe("Bash,Read,Grep,Glob,Write");
  });

  it("a judge that writes no verdict fails the tick: missing-verdict", async () => {
    const theCtx = ctx(async () => okSpawn());
    const outcome = await runJudge(theCtx);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toBe("missing-verdict");
  });

  it("a judge that writes judged:false fails the tick: malformed-verdict", async () => {
    const fake: RunAgentFn = async () => {
      const v = goodVerdictFor(theCtx);
      v["judged"] = false;
      writeFileSync(theCtx.verdictPath, JSON.stringify(v));
      return okSpawn();
    };
    const theCtx = ctx(fake);
    const outcome = await runJudge(theCtx);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toBe("malformed-verdict");
    expect(outcome.errors.join("\n")).toContain("judged must be exactly true");
  });

  it("spawn-level failure wins over a present verdict file (nonzero exit)", async () => {
    const fake: RunAgentFn = async () => {
      writeFileSync(theCtx.verdictPath, JSON.stringify(goodVerdictFor(theCtx)));
      return { ...okSpawn(), exitCode: 2 };
    };
    const theCtx = ctx(fake);
    const outcome = await runJudge(theCtx);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toBe("nonzero-exit");
  });

  it("budget truncation is failure even with a verdict present", async () => {
    const fake: RunAgentFn = async () => {
      writeFileSync(theCtx.verdictPath, JSON.stringify(goodVerdictFor(theCtx)));
      return {
        ...okSpawn(),
        resultMessage: { type: "result", subtype: "error_max_budget_usd" },
      };
    };
    const theCtx = ctx(fake);
    const outcome = await runJudge(theCtx);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toBe("budget-truncated");
  });
});
