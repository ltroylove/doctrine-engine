import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parseIntent } from "../src/intent.js";
import type { RunAgentFn } from "../src/judge.js";
import { evaluatePlanCatch, runPlanCanary, type PlanCanaryExpect } from "../src/plan-canary.js";
import type { SpawnRunResult } from "../src/spawn.js";
import { parseWorkUnit } from "../src/work-unit.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-plancanary-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const CANARIES_DIR = fileURLToPath(new URL("../../plan-canaries", import.meta.url));
const PLAN_JUDGE_DEF = fileURLToPath(new URL("../../.claude/agents/plan-judge.md", import.meta.url));

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A miniature arena: git repo with manifest, contracts, decisions, a src file. */
function makeArena(): string {
  const dir = mkdtempSync(join(tmp, "arena-"));
  gitIn(dir, ["init", "-q", "-b", "development"]);
  mkdirSync(join(dir, ".doctrine"), { recursive: true });
  writeFileSync(join(dir, ".doctrine", "manifest.json"), JSON.stringify({ name: "t", base_branch: "development" }));
  mkdirSync(join(dir, "work", "intents"), { recursive: true });
  mkdirSync(join(dir, "context"), { recursive: true });
  writeFileSync(join(dir, "context", "contracts.md"), "# Contracts\n\n## toCsv\n- Owner: src/export.ts\n");
  writeFileSync(join(dir, "context", "decisions.md"), "# Decisions\n\n- category filter matches case-insensitively\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "export.ts"), "export function toCsv() {}\n");
  gitIn(dir, ["add", "-A"]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

const okSpawn = (): SpawnRunResult => ({
  spawnFailed: false, exitCode: 0, signal: null, timedOut: false, outage: false,
  logPath: "x", resultMessage: { type: "result", subtype: "success", total_cost_usd: 0.2 },
});

/** Fake plan-judge: marks the ids in `notOk` as failing, everything else ok. */
function fakeJudge(notOk: string[]): RunAgentFn {
  return async (prompt) => {
    const verdictPath = /write the verdict JSON to EXACTLY: (.+)/.exec(prompt)![1]!.trim();
    const ids = /cover exactly these ids: ([^)]+)\)/.exec(prompt)![1]!.split(",").map((s) => s.trim());
    const units = ids.map((id) => notOk.includes(id)
      ? { id, ok: false, cite: "", problems: ["seeded canary defect flagged"] }
      : { id, ok: true, cite: "quoted intent text", problems: [] });
    writeFileSync(verdictPath, JSON.stringify({
      intent: "x",
      verdict: units.every((u) => u.ok) ? "pass" : "fail",
      judged: true,
      units,
      rival_check: "grepped src and contracts — recorded",
    }));
    return okSpawn();
  };
}

/**
 * The real fixtures pin the commit of the real arena they were authored against; the
 * miniature arena here has no such commit, so the offline runner tests use an unpinned
 * copy (the pin itself is covered in canary.test.ts).
 */
function unpinnedCanaries(): string {
  const dir = mkdtempSync(join(tmp, "canaries-"));
  cpSync(CANARIES_DIR, dir, { recursive: true });
  for (const id of readdirSync(dir)) {
    const expectPath = join(dir, id, "expect.json");
    if (!existsSync(expectPath)) continue;
    const { base: _pin, ...rest } = JSON.parse(readFileSync(expectPath, "utf8")) as PlanCanaryExpect;
    writeFileSync(expectPath, JSON.stringify(rest));
  }
  return dir;
}

function deps(arena: string, runAgent: RunAgentFn) {
  return {
    arenaDir: arena,
    canariesDir: unpinnedCanaries(),
    runsDir: join(arena, ".doctrine", "plan-canary-runs"),
    agentDefinitionPath: PLAN_JUDGE_DEF,
    budgetUsd: 5,
    runAgent,
  };
}

describe("plan-canary fixtures", () => {
  it("every canary parses: valid intent, valid draft units, coherent expect.json", () => {
    const ids = readdirSync(CANARIES_DIR).filter((d) => existsSync(join(CANARIES_DIR, d, "expect.json")));
    expect(ids.length).toBeGreaterThanOrEqual(6);
    for (const id of ids) {
      const dir = join(CANARIES_DIR, id);
      const intent = parseIntent(readFileSync(join(dir, "intent.md"), "utf8"));
      expect(intent.ok, `${id}/intent.md`).toBe(true);
      const unitIds: string[] = [];
      for (const f of readdirSync(join(dir, "units")).filter((f) => f.endsWith(".md"))) {
        const u = parseWorkUnit(readFileSync(join(dir, "units", f), "utf8"));
        expect(u.ok, `${id}/units/${f}`).toBe(true);
        if (u.ok) {
          expect(u.unit.status, `${id}/units/${f} must be draft`).toBe("draft");
          unitIds.push(u.unit.id);
        }
      }
      const exp = JSON.parse(readFileSync(join(dir, "expect.json"), "utf8")) as PlanCanaryExpect;
      expect(["pass", "fail"]).toContain(exp.verdict);
      for (const ref of [...(exp.must_fail ?? []), ...(exp.must_pass ?? [])]) {
        expect(unitIds, `${id}: expect.json references ${ref}`).toContain(ref);
      }
      if (exp.verdict === "fail") expect((exp.must_fail ?? []).length).toBeGreaterThan(0);
      if (exp.base !== undefined) expect(exp.base, `${id}: base must be a full commit sha`).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("a pinned base that the arena lacks is an error, never a silent run at the branch head", async () => {
    const arena = makeArena();
    const canaries = mkdtempSync(join(tmp, "pinned-"));
    cpSync(join(CANARIES_DIR, "pc-05-clean-plan"), join(canaries, "pc-05-clean-plan"), { recursive: true });
    const expectPath = join(canaries, "pc-05-clean-plan", "expect.json");
    writeFileSync(expectPath, JSON.stringify({ ...JSON.parse(readFileSync(expectPath, "utf8")), base: "0".repeat(40) }));
    const run = await runPlanCanary("pc-05-clean-plan", { ...deps(arena, fakeJudge([])), canariesDir: canaries });
    expect(run.result).toBe("error");
    expect(run.detail).toContain("not a commit in the arena");
  });
});

describe("runPlanCanary", () => {
  it("caught: the judge flags exactly the seeded defect, faithful units unharmed", async () => {
    const arena = makeArena();
    const run = await runPlanCanary("pc-01-invented-scope", deps(arena, fakeJudge(["wu-pc01-encrypt"])));
    expect(run.result).toBe("caught");
    // The metric landed in the arena ledger.
    expect(readFileSync(join(arena, ".doctrine", "metrics.jsonl"), "utf8")).toContain("pc-01-invented-scope");
    // The worktree was cleaned up.
    expect(existsSync(join(arena, ".doctrine", "plan-canary-runs", "pc-01-invented-scope", "tree", "src"))).toBe(false);
  });

  it("a killed run's registered worktree does not block the next sweep", async () => {
    // A crash between `worktree add` and the finally block leaves the tree registered in
    // the arena. Nothing reclaims it — so the next weekly sweep must, or it dies at
    // "already exists" the way the 2026-09-02 code-canary sweep did.
    const arena = makeArena();
    const d = deps(arena, fakeJudge(["wu-pc01-encrypt"]));
    const tree = join(d.runsDir, "pc-01-invented-scope", "tree");
    mkdirSync(join(d.runsDir, "pc-01-invented-scope"), { recursive: true });
    gitIn(arena, ["worktree", "add", "--detach", tree, "development"]);
    expect(gitIn(arena, ["worktree", "list", "--porcelain"])).toContain("pc-01-invented-scope");

    const run = await runPlanCanary("pc-01-invented-scope", d);
    expect(run.result).toBe("caught");
  });

  it("a killed run's stale verdict is never read as this run's result", async () => {
    // The run directory is stable per canary, so a run killed after the judge wrote its
    // verdict leaves that file behind. runPlanJudge decides purely on the file existing —
    // so the next sweep's judge can exit clean, write nothing, and have the dead run's
    // verdict scored as this one's. That is a false catch inflating measured recall, the
    // one thing a calibration instrument may never do.
    const arena = makeArena();
    const silent: RunAgentFn = async () => okSpawn(); // exits clean, writes no verdict
    const d = deps(arena, silent);
    const runDir = join(d.runsDir, "pc-01-invented-scope");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "plan-verdict.json"), JSON.stringify({
      intent: "x",
      verdict: "fail",
      judged: true,
      units: [
        { id: "wu-pc01-encrypt", ok: false, cite: "", problems: ["verdict from a killed run"] },
        { id: "wu-pc01-categories", ok: true, cite: "quoted intent text", problems: [] },
      ],
      rival_check: "grepped src and contracts — recorded",
    }));

    const run = await runPlanCanary("pc-01-invented-scope", d);
    expect(run.result).toBe("error");
    expect(run.detail).toContain("missing-plan-verdict");
  });

  it("missed: a judge that passes a fabricated plan is a measured miss, not an error", async () => {
    const arena = makeArena();
    const run = await runPlanCanary("pc-01-invented-scope", deps(arena, fakeJudge([])));
    expect(run.result).toBe("missed");
    expect(run.detail).toContain('said "pass"');
  });

  it("missed: collateral damage — flagging the faithful unit alongside the defect", async () => {
    const arena = makeArena();
    const run = await runPlanCanary("pc-01-invented-scope", deps(arena, fakeJudge(["wu-pc01-encrypt", "wu-pc01-categories"])));
    expect(run.result).toBe("missed");
    expect(run.detail).toContain("collateral damage");
  });

  it("clean control: passing the faithful plan is caught; blocking it is a miss", async () => {
    const arena = makeArena();
    const pass = await runPlanCanary("pc-05-clean-plan", deps(arena, fakeJudge([])));
    expect(pass.result).toBe("caught");
    const block = await runPlanCanary("pc-05-clean-plan", deps(arena, fakeJudge(["wu-pc05-limit-core"])));
    expect(block.result).toBe("missed");
  });
});

describe("evaluatePlanCatch", () => {
  it("a plan-judge run failure is an error, never a catch", () => {
    const out = evaluatePlanCatch(
      { kind: "failed", reason: "missing-plan-verdict", outage: false, errors: ["no file"], spendUsd: 0 },
      { verdict: "fail", must_fail: ["wu-x"] },
    );
    expect(out.result).toBe("error");
  });
});
