import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { tick, type TickDeps } from "../src/dispatch.js";
import { levelPassed } from "../src/grade.js";
import { GAP_OUT_DIR } from "../src/scaffold-gap.js";
import type { RunAgentFn } from "../src/judge.js";
import type { SpawnRunResult } from "../src/spawn.js";

const LF = String.fromCharCode(10);
const tmp = mkdtempSync(join(tmpdir(), "doctrine-3rung-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const AGENTS = {
  implementer: fileURLToPath(new URL("../../.claude/agents/implementer.md", import.meta.url)),
  judge: fileURLToPath(new URL("../../.claude/agents/code-judge.md", import.meta.url)),
  decomposer: fileURLToPath(new URL("../../.claude/agents/decomposer.md", import.meta.url)),
  planJudge: fileURLToPath(new URL("../../.claude/agents/plan-judge.md", import.meta.url)),
};

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

const PRD = [
  "# PRD", "", "### C1. Ledger", "",
  "- **machine** `C1.1` The ledger imports.",
  "- **machine** `C1.2` The ledger closes.", "",
].join(LF);

interface FeatureSpec { number: string; delivers: string[]; acceptance: string | null; renders?: string[] }

function epicDoc(id: string, delivers: string[], features: FeatureSpec[], evidence: string | null): string {
  const fm = [
    "---", `id: ${id}`, "level: epic", `title: ${id}`, "status: active",
    `delivers: [${delivers.join(", ")}]`,
    ...(evidence !== null
      ? ["evidence:", "  - kind: command", `    run: "${evidence}"`, '    expect: "exit 0"']
      : []),
    "---",
  ];
  const body: string[] = ["The slice.", ""];
  for (const f of features) {
    body.push(`### Feature ${f.number}: slice ${f.number}`, "");
    body.push(`- **Delivers:** ${f.delivers.length > 0 ? f.delivers.join(", ") : "(none)"}`);
    body.push(`- **Renders:** ${f.renders !== undefined && f.renders.length > 0 ? f.renders.join(", ") : "(none)"}`);
    body.push("- **Depends on:** (none)");
    if (f.acceptance === null) {
      body.push("- **Acceptance:** (none)");
    } else {
      body.push("- **Acceptance:**");
      body.push("  - `" + f.acceptance + "` — the traced behaviour works");
    }
    body.push("");
  }
  return [...fm, ...body].join(LF);
}

function unitDoc(id: string, parent: string, status: string, withEvidence = true): string {
  return [
    "---", `id: ${id}`, `title: ${id}`, "tier: reversible", `status: ${status}`,
    "budget_usd: 5", `parent: ${parent}`, "delivers: [C1.1]", "depends_on: []",
    ...(withEvidence ? ["evidence:", "  - kind: command", '    run: "exit 0"', '    expect: "exit 0"'] : []),
    "---", "## Intent", "", "Because the ledger cannot import today.", "",
  ].join(LF);
}

interface ArenaSpec {
  epics?: Array<{ id: string; delivers: string[]; features: FeatureSpec[]; evidence: string | null }>;
  units?: Array<{ id: string; parent: string; status: string; withEvidence?: boolean }>;
}

function makeArena(spec: ArenaSpec = {}): string {
  const dir = mkdtempSync(join(tmp, "arena-"));
  gitIn(dir, ["init", "-b", "development"]);
  mkdirSync(join(dir, ".doctrine"), { recursive: true });
  mkdirSync(join(dir, "work", "intents"), { recursive: true });
  mkdirSync(join(dir, "docs", "program", "epics"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), [".doctrine/lease/", ".doctrine/runs/", ".doctrine/canary-runs/", ""].join(LF));
  writeFileSync(join(dir, ".doctrine", "manifest.json"), JSON.stringify({
    name: "t", base_branch: "development", doors: [],
    program: { prd: "docs/PRD.md", arch: "docs/ARCH.md" },
  }));
  writeFileSync(join(dir, "docs", "PRD.md"), PRD);
  writeFileSync(join(dir, "docs", "ARCH.md"), "# ARCH" + LF);
  for (const e of spec.epics ?? []) {
    writeFileSync(join(dir, "docs", "program", "epics", `${e.id}.md`), epicDoc(e.id, e.delivers, e.features, e.evidence));
  }
  for (const u of spec.units ?? []) {
    writeFileSync(join(dir, "work", `${u.id}.md`), unitDoc(u.id, u.parent, u.status, u.withEvidence ?? true));
  }
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-q", "-m", "seed"]);
  return dir;
}

/** No fixture here may buy an ACT: every one of these rungs is meant to be engine-only. */
const refuse: RunAgentFn = async () => { throw new Error("no paid ACT may run in these fixtures"); };

function deps(arenaDir: string, runAgent: RunAgentFn = refuse): TickDeps {
  return { arenaDir, agentDefs: AGENTS, runAgent };
}

/**
 * The planning laws, for the one test that must reach the OLD path rather than stop short
 * of it. Every rung they unlock returns before spending here, because the fixture's epic
 * is malformed — which is the thing being asserted.
 */
const PLANNING_AGENTS = {
  ...AGENTS,
  programDecomposer: AGENTS.decomposer,
  programJudge: AGENTS.planJudge,
  intentFixer: AGENTS.decomposer,
  narrowingDecomposer: AGENTS.decomposer,
  narrowingJudge: AGENTS.planJudge,
  narrowingFixer: AGENTS.decomposer,
};

describe("the feature grade — the ratchet one rung up (ADR-0003)", () => {
  const ONE: ArenaSpec = {
    epics: [{
      id: "ep-ledger", delivers: ["C1.1"], evidence: null,
      features: [{ number: "1.1", delivers: ["C1.1"], acceptance: "exit 0" }],
    }],
    units: [{ id: "wu-import", parent: "ep-ledger#1.1", status: "merged" }],
  };

  it("grades a feature once every unit under it has merged, and commits the record", async () => {
    const dir = makeArena(ONE);
    const r = await tick(deps(dir));
    expect(r.decision).toBe("feature-graded-pass");
    // The record IS the artifact. A feature is a heading with deliberately no status, so
    // this is what the next tick reads to know the level is closed — and it is committed,
    // which is what keeps the loop artifact-derived at the rung ADR-0003 calls the ratchet.
    expect(levelPassed(dir, "feature", "ep-ledger#1.1")).toBe(true);
    expect(gitIn(dir, ["status", "--porcelain", "-uno"])).toBe("");
  });

  it("does not grade a feature whose units have not all landed", async () => {
    const dir = makeArena({
      ...ONE,
      units: [
        { id: "wu-import", parent: "ep-ledger#1.1", status: "merged" },
        // `draft`, not `ready`: unlanded, and not something rung 1 would pick up either —
        // the question here is the grade gate, not what the implementer does next.
        { id: "wu-close", parent: "ep-ledger#1.1", status: "draft" },
      ],
    });
    const r = await tick({ ...deps(dir), agentDefs: PLANNING_AGENTS });
    expect(r.decision).not.toContain("feature-graded");
  });

  it("records a failure and does not re-grade it at the same commit", async () => {
    const dir = makeArena({
      ...ONE,
      epics: [{
        id: "ep-ledger", delivers: ["C1.1"], evidence: null,
        features: [{ number: "1.1", delivers: ["C1.1"], acceptance: "exit 7" }],
      }],
    });
    const first = await tick(deps(dir));
    expect(first.decision).toBe("feature-graded-fail");
    expect(levelPassed(dir, "feature", "ep-ledger#1.1")).toBe(false);
    // Settled. Re-running an end-to-end suite every ninety seconds to be told the same
    // thing is the spin the settlement machinery exists to stop — and the grade's own
    // commit moved HEAD, so this also pins that settlement is keyed past it.
    const second = await tick(deps(dir));
    expect(second.decision).not.toBe("feature-graded-fail");
  });

  it("a feature with NO acceptance is ungraded, and the loop moves past it", async () => {
    // The spin that would otherwise arrive through a third status. `ungraded` is never a
    // pass, so without settling it the same feature is re-decided every tick and no rung
    // below it ever runs — the quiet deadlock this loop has now paid for twice.
    const dir = makeArena({
      ...ONE,
      epics: [{
        id: "ep-ledger", delivers: ["C1.1"], evidence: null,
        features: [{ number: "1.1", delivers: ["C1.1"], acceptance: null }],
      }],
    });
    const first = await tick(deps(dir));
    expect(first.decision).toBe("feature-graded-ungraded");
    expect(first.detail).toContain("carries no acceptance");
    const second = await tick(deps(dir));
    expect(second.decision).not.toBe("feature-graded-ungraded");
  });
});

describe("the epic grade, and program-done", () => {
  it("waits for every feature to pass, then grades the epic", async () => {
    const dir = makeArena({
      epics: [{
        id: "ep-ledger", delivers: ["C1.1", "C1.2"], evidence: "exit 0",
        features: [
          { number: "1.1", delivers: ["C1.1"], acceptance: "exit 0" },
          { number: "1.2", delivers: ["C1.2"], acceptance: "exit 0" },
        ],
      }],
      units: [
        { id: "wu-import", parent: "ep-ledger#1.1", status: "merged" },
        { id: "wu-close", parent: "ep-ledger#1.2", status: "merged" },
      ],
    });
    expect((await tick(deps(dir))).decision).toBe("feature-graded-pass");
    // Not yet. An epic is done when its features are (it no longer stores a status),
    // so the product-level question is asked only once every feature has been shown to work.
    expect(levelPassed(dir, "epic", "ep-ledger")).toBe(false);
    expect((await tick(deps(dir))).decision).toBe("feature-graded-pass");
    expect((await tick(deps(dir))).decision).toBe("epic-graded-pass");
    expect(levelPassed(dir, "epic", "ep-ledger")).toBe(true);
  });

  it("reports program-done when every machine criterion is delivered by a PASSING epic", async () => {
    // The question `programProgress` was written for and has never been asked. Not "every
    // criterion reached a plan" — that is `chain-complete`, a claim about documents — but
    // every criterion delivered by an epic whose acceptance the engine actually ran.
    const dir = makeArena({
      epics: [{
        id: "ep-ledger", delivers: ["C1.1", "C1.2"], evidence: "exit 0",
        features: [{ number: "1.1", delivers: ["C1.1", "C1.2"], acceptance: "exit 0" }],
      }],
      units: [{ id: "wu-import", parent: "ep-ledger#1.1", status: "merged" }],
    });
    expect((await tick(deps(dir))).decision).toBe("feature-graded-pass");
    expect((await tick(deps(dir))).decision).toBe("epic-graded-pass");
    const r = await tick(deps(dir));
    expect(r.decision).toBe("program-done");
    expect(r.detail).toContain("2/2");
  });

  describe("the surface contract is the second condition (ADR-0008)", () => {
    // A target reported done 55/55 with Setup, the connections and statement import
    // unbuilt. Every PRD criterion delivered is not the whole promise.
    function doneArena(surface: string): string {
      const dir = makeArena({
        epics: [{
          id: "ep-ledger", delivers: ["C1.1", "C1.2"], evidence: "exit 0",
          features: [{ number: "1.1", delivers: ["C1.1", "C1.2"], acceptance: "exit 0" }],
        }],
        units: [{ id: "wu-import", parent: "ep-ledger#1.1", status: "merged" }],
      });
      const path = join(dir, ".doctrine", "manifest.json");
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), surface }));
      gitIn(dir, ["add", "-A"]);
      gitIn(dir, ["commit", "-q", "-m", "declare the surface"]);
      return dir;
    }

    it("withholds program-done while the surface command reports unresolved ids, and pauses with its report", async () => {
      const dir = doneArena("echo 'setup.screen  stubbed'; exit 1");
      expect((await tick(deps(dir))).decision).toBe("feature-graded-pass");
      expect((await tick(deps(dir))).decision).toBe("epic-graded-pass");
      const r = await tick(deps(dir));
      expect(r.decision).toBe("surface-unresolved");
      const pause = readFileSync(join(dir, ".doctrine", "pause"), "utf8");
      expect(pause).toContain("surface unresolved");
      expect(pause).toContain("setup.screen  stubbed");
    });

    it("prepares the arena with the manifest's setup before running the surface command", async () => {
      // A fresh clone has no install: the surface command must not fail for that reason alone.
      const dir = doneArena("test -f .doctrine/setup-ran || { echo 'no setup'; exit 1; }");
      const path = join(dir, ".doctrine", "manifest.json");
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), setup: "touch .doctrine/setup-ran" }));
      gitIn(dir, ["add", "-A"]);
      gitIn(dir, ["commit", "-q", "-m", "declare setup"]);
      expect((await tick(deps(dir))).decision).toBe("feature-graded-pass");
      expect((await tick(deps(dir))).decision).toBe("epic-graded-pass");
      // The grades ran setup in the arena. A fresh clone of a finished target has the passing
      // grade records but no install, and no grade runs again before the program-done check.
      rmSync(join(dir, ".doctrine", "setup-ran"), { force: true });
      expect((await tick(deps(dir))).decision).toBe("program-done");
    });

    it("reports program-done once the surface command passes", async () => {
      const dir = doneArena("echo 'surface: 0 unresolved'; exit 0");
      expect((await tick(deps(dir))).decision).toBe("feature-graded-pass");
      expect((await tick(deps(dir))).decision).toBe("epic-graded-pass");
      expect((await tick(deps(dir))).decision).toBe("program-done");
    });
  });

  it("does not report program-done while an epic's own acceptance has not passed", async () => {
    const dir = makeArena({
      epics: [{
        id: "ep-ledger", delivers: ["C1.1", "C1.2"], evidence: "exit 9",
        features: [{ number: "1.1", delivers: ["C1.1", "C1.2"], acceptance: "exit 0" }],
      }],
      units: [{ id: "wu-import", parent: "ep-ledger#1.1", status: "merged" }],
    });
    expect((await tick(deps(dir))).decision).toBe("feature-graded-pass");
    expect((await tick(deps(dir))).decision).toBe("epic-graded-fail");
    expect((await tick(deps(dir))).decision).not.toBe("program-done");
  });
});

describe("the build-out rung — one scaffold, one tick (ADR-0001)", () => {
  const LAW = join(tmp, "build-out-law.md");
  writeFileSync(LAW, ["---", "name: build-out", "---", "Append the spec.", ""].join(LF));

  const okSpawn = (): SpawnRunResult => ({
    spawnFailed: false, exitCode: 0, signal: null, timedOut: false, outage: false,
    logPath: "x", resultMessage: { type: "result", subtype: "success", total_cost_usd: 0.4 },
  });

  const SCAFFOLD: ArenaSpec = {
    epics: [{
      id: "ep-ledger", delivers: ["C1.1"], evidence: null,
      features: [{ number: "1.1", delivers: ["C1.1"], acceptance: "exit 0" }],
    }],
    units: [{ id: "wu-import", parent: "ep-ledger#1.1", status: "scaffold", withEvidence: false }],
  };

  it("picks a scaffolded unit, buys its spec, and the ENGINE promotes it to ready", async () => {
    const dir = makeArena(SCAFFOLD);
    const built: RunAgentFn = async (_p, opts) => {
      const path = join(opts.cwd, "work", "wu-import.md");
      const drafted = readFileSync(path, "utf8").replace("status: scaffold", "status: draft");
      const withEvidence = drafted.replace(
        "---" + LF + "## Intent",
        ["evidence:", "  - kind: command", '    run: "exit 0"', '    expect: "exit 0"', "---", "## Intent"].join(LF),
      );
      writeFileSync(path, withEvidence + LF + "## Spec" + LF + LF + "Write the importer." + LF);
      return okSpawn();
    };
    const r = await tick({ ...deps(dir, built), agentDefs: { ...AGENTS, buildOut: LAW } });
    expect(r.decision).toBe("build-out-built");
    // The promotion is the engine's, never the ACT's.
    expect(readFileSync(join(dir, "work", "wu-import.md"), "utf8")).toContain("status: ready");
  });

  it("stays off entirely when no build-out law is installed", async () => {
    // `.claude/agents/build-out.md` was written after the engine half. Until it existed the
    // ACT was engine-complete and lawless, and nothing could run it against a target.
    const dir = makeArena(SCAFFOLD);
    const r = await tick(deps(dir));
    expect(r.decision).not.toContain("build-out");
  });
});

describe("the four new rungs are INERT on an arena shaped like today's", () => {
  it("takes the old path against intent-dialect units and epics with no feature headings", async () => {
    // The safety case for adding four rungs to a running loop's tick, asserted rather than
    // argued. Three independent facts hold on both live arenas: no `### Feature` heading
    // exists anywhere, so nothing is graded; no unit carries `parent`, so no feature has
    // children even if one did; no unit holds `status: scaffold`, so nothing is built out.
    // Cutover makes all three false at once, deliberately.
    const dir = makeArena();
    // An epic in the shape a pre-cutover target's epics are actually in: no feature headings.
    writeFileSync(
      join(dir, "docs", "program", "epics", "ep-old.md"),
      ["---", "id: ep-old", "level: epic", "title: Old", "status: active", "delivers: [C1.1]", "---",
        "Prose narrowing the PRD, with no feature heading anywhere.", ""].join(LF),
    );
    // A unit in the legacy dialect: `intent:`, not `parent:`.
    writeFileSync(join(dir, "work", "wu-legacy.md"), [
      "---", "id: wu-legacy", "title: legacy", "tier: reversible", "status: merged",
      "budget_usd: 5", "intent: in-old", "---", "body", "",
    ].join(LF));
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-q", "-m", "today's shape"]);

    const r = await tick({ ...deps(dir), agentDefs: PLANNING_AGENTS });
    expect(r.decision).not.toContain("feature-graded");
    expect(r.decision).not.toContain("epic-graded");
    expect(r.decision).not.toContain("build-out");
    expect(r.decision).not.toBe("program-done");
    // The old path is what it takes: the epic declares no features, `parseFeatures` refuses
    // it, and that refusal belongs to the narrowing chain — as it did before these rungs.
    expect(r.decision).toBe("narrowing-malformed");
    expect(existsSync(join(dir, ".doctrine", "grades"))).toBe(false);
  });
});

describe("the ratchet — a failed feature grade buys the next slice (ADR-0003)", () => {
  const GAP_LAW = join(tmp, "scaffold-gap-law.md");
  writeFileSync(GAP_LAW, ["---", "name: scaffold-gap", "---", "Mint what is missing.", ""].join(LF));

  const okSpawn = (): SpawnRunResult => ({
    spawnFailed: false, exitCode: 0, signal: null, timedOut: false, outage: false,
    logPath: "x", resultMessage: { type: "result", subtype: "success", total_cost_usd: 0.6 },
  });

  const FAILING: ArenaSpec = {
    epics: [{
      id: "ep-ledger", delivers: ["C1.1"], evidence: null,
      features: [{ number: "1.1", delivers: ["C1.1"], acceptance: "exit 7" }],
    }],
    units: [{ id: "wu-import", parent: "ep-ledger#1.1", status: "merged" }],
  };

  /** An ACT that mints one more unit under the feature, into its scratch `work/`. */
  const mints = (id: string, parent = "ep-ledger#1.1"): RunAgentFn => async (_p, opts) => {
    writeFileSync(join(opts.cwd, GAP_OUT_DIR, `${id}.md`), [
      "---", `id: ${id}`, `title: ${id}`, "tier: reversible", "budget_usd: 12",
      "status: scaffold", `parent: ${parent}`, "delivers: [C1.1]", "renders: []",
      "depends_on: []", "---", "## Intent", "", "Because rounding is still wrong.", "",
    ].join(LF));
    return okSpawn();
  };

  function withGap(dir: string, runAgent: RunAgentFn): TickDeps {
    return { ...deps(dir, runAgent), agentDefs: { ...AGENTS, scaffoldGap: GAP_LAW } };
  }

  it("mints more units under the feature, with the failure output in hand", async () => {
    const dir = makeArena(FAILING);
    const r = await tick(withGap(dir, mints("wu-rounding")));
    expect(r.decision).toBe("feature-graded-fail+gap-scaffolded");
    expect(r.detail).toContain("wu-rounding");
    expect(readFileSync(join(dir, "work", "wu-rounding.md"), "utf8")).toContain("status: scaffold");
    expect(gitIn(dir, ["status", "--porcelain", "-uno"])).toBe("");
  });

  it("hands the ACT what the acceptance actually printed", async () => {
    let seen = "";
    const dir = makeArena(FAILING);
    await tick(withGap(dir, async (prompt, opts) => {
      seen = prompt;
      return mints("wu-rounding")(prompt, opts);
    }));
    // The evidence, not a summary of it. An intent blocked on a module that does not exist
    // fails with an import error naming it, and that name is the whole input.
    expect(seen).toContain("exit: 7");
    expect(seen).toContain("ep-ledger#1.1");
    expect(seen, "and what already landed, so it does not re-mint it").toContain("wu-import");
  });

  it("lets the ACT edit what it wrote: Edit is allowed, not only Write", async () => {
    // In one run the ACT wrote its unit, then refined it with Edit; Edit was not
    // in the allowed list, the refusal was a permission denial, and the whole (correct) attempt
    // counted as failed. Edit is as contained as Write: scratch directory, repo deny rules,
    // and the repoTouchedBy tripwire.
    let argv: readonly string[] = [];
    const dir = makeArena(FAILING);
    await tick(withGap(dir, async (prompt, opts) => { argv = opts.argv; return mints("wu-rounding")(prompt, opts); }));
    const allowed = argv[argv.indexOf("--allowedTools") + 1] ?? argv.join(" ");
    expect(allowed).toContain("Write");
    expect(allowed).toContain("Edit");
  });

  it("refuses a mint parented to a different feature", async () => {
    // This rung mints under ONE feature. A unit placed elsewhere would be measured against
    // the wrong set by a lint scoped to this feature's criteria.
    const dir = makeArena(FAILING);
    const r = await tick(withGap(dir, mints("wu-elsewhere", "ep-ledger#9.9")));
    expect(r.decision).toBe("feature-graded-fail+gap-rejected");
    expect(r.detail).toContain("this rung mints under ep-ledger#1.1 only");
    expect(existsSync(join(dir, "work", "wu-elsewhere.md"))).toBe(false);
  });

  it("records an honest empty answer and does not re-buy it at the same signature", async () => {
    // Measured before it was built: 16 gap-empty ticks on a target, $31.33, twelve of
    // them in one day. Settlement alone could not fix it — a commit moves for reasons that
    // have nothing to do with this feature. The evidence is the right key.
    const dir = makeArena(FAILING);
    let asked = 0;
    const silent: RunAgentFn = async () => { asked += 1; return okSpawn(); };
    expect((await tick(withGap(dir, silent))).decision).toBe("feature-graded-fail+gap-empty");
    expect(asked).toBe(1);

    // A commit lands that changes nothing about this feature's failure.
    writeFileSync(join(dir, "unrelated.ts"), "export const x = 1;" + LF);
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-q", "-m", "a sibling slice lands"]);

    const second = await tick(withGap(dir, silent));
    expect(second.decision).toBe("feature-graded-fail");
    expect(asked, "the same failing evidence buys the same answer once").toBe(1);
  });

  it("stays off, and records the failure, when no ratchet law is installed", async () => {
    const dir = makeArena(FAILING);
    const r = await tick(deps(dir));
    expect(r.decision).toBe("feature-graded-fail");
  });

  it("treats a REFUSED write as a failure, never as an empty answer, so the question is asked again", async () => {
    // Seven correct diagnoses were once written to a directory the deny
    // profile refused, the engine saw no file, recorded "nothing more to slice", and retired the
    // ratchet on each failure for good.
    let asked = 0;
    const denied: RunAgentFn = async () => {
      asked += 1;
      return {
        ...okSpawn(),
        resultMessage: {
          type: "result", subtype: "success", total_cost_usd: 0.4,
          permission_denials: [{ tool_name: "Write", tool_input: { file_path: "C:/tmp/scratch/out/wu-rounding.md" } }],
        },
      };
    };
    const dir = makeArena(FAILING);
    const r = await tick(withGap(dir, denied));
    expect(r.decision).toBe("feature-graded-fail+gap-failed");
    expect(r.detail).toContain("permission-denied");
    expect(r.detail).toContain("Write denied");

    writeFileSync(join(dir, "unrelated.ts"), "export const x = 1;" + LF);
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-q", "-m", "the deny profile is fixed and a commit lands"]);
    expect((await tick(withGap(dir, denied))).decision).toBe("feature-graded-fail+gap-failed");
    expect(asked, "not retired: the same failure is asked again").toBe(2);
  });
});

describe("the ratchet one rung further up — a failed EPIC grade buys its missing slice", () => {
  // On a target, two epics whose features all passed failed their end-to-end
  // check with "No test files found" (the planner wrote `npm test -- publishers` and no unit
  // was given that test), and with no ratchet at the epic rung nothing ever revisited them.
  const GAP_LAW = join(tmp, "scaffold-gap-law-epic.md");
  writeFileSync(GAP_LAW, ["---", "name: scaffold-gap", "---", "Mint what is missing.", ""].join(LF));

  const okSpawn = (): SpawnRunResult => ({
    spawnFailed: false, exitCode: 0, signal: null, timedOut: false, outage: false,
    logPath: "x", resultMessage: { type: "result", subtype: "success", total_cost_usd: 0.5 },
  });

  /** Two features that pass on their own; an epic acceptance that does not. */
  const EPIC_FAILS: ArenaSpec = {
    epics: [{
      id: "ep-ledger", delivers: ["C1.1", "C1.2"], evidence: "exit 7",
      features: [
        { number: "1.1", delivers: ["C1.1"], acceptance: "exit 0" },
        { number: "1.2", delivers: ["C1.2"], acceptance: "exit 0" },
      ],
    }],
    units: [
      { id: "wu-import", parent: "ep-ledger#1.1", status: "merged" },
      { id: "wu-close", parent: "ep-ledger#1.2", status: "merged" },
    ],
  };

  /** An ACT that mints one scaffold under the epic's LAST feature, which delivers C1.2. */
  const mints = (id: string): RunAgentFn => async (_p, opts) => {
    writeFileSync(join(opts.cwd, GAP_OUT_DIR, `${id}.md`), [
      "---", `id: ${id}`, `title: ${id}`, "tier: reversible", "budget_usd: 12",
      "status: scaffold", "parent: ep-ledger#1.2", "delivers: [C1.2]", "renders: []",
      "depends_on: []", "---", "## Intent", "", "Because nothing tests the ledger end to end.", "",
    ].join(LF));
    return okSpawn();
  };

  function withGap(dir: string, runAgent: RunAgentFn): TickDeps {
    return { ...deps(dir, runAgent), agentDefs: { ...AGENTS, scaffoldGap: GAP_LAW } };
  }

  /** Both features pass, then the next tick is the epic's grade. */
  async function toEpicGrade(dir: string, runAgent: RunAgentFn) {
    expect((await tick(withGap(dir, runAgent))).decision).toBe("feature-graded-pass");
    expect((await tick(withGap(dir, runAgent))).decision).toBe("feature-graded-pass");
    return tick(withGap(dir, runAgent));
  }

  function commitAll(dir: string, message: string): void {
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-q", "-m", message]);
  }

  it("mints the missing unit under the epic's last feature, telling the ACT it was the EPIC that failed", async () => {
    let seen = "";
    const dir = makeArena(EPIC_FAILS);
    const r = await toEpicGrade(dir, async (prompt, opts) => { seen = prompt; return mints("wu-ledger-e2e")(prompt, opts); });
    expect(r.decision).toBe("epic-graded-fail+gap-scaffolded");
    expect(r.detail).toContain("wu-ledger-e2e");
    expect(readFileSync(join(dir, "work", "wu-ledger-e2e.md"), "utf8")).toContain("parent: ep-ledger#1.2");
    // What failed, in its own words, and not "feature 1.2 is not finished": its checks passed,
    // and a planner told otherwise can honestly answer empty and retire the ratchet for good.
    expect(seen).toContain("Epic `ep-ledger`");
    expect(seen).toContain("end-to-end acceptance");
    expect(seen).toContain("`exit 7`");
    expect(seen).toContain("exit: 7");
    expect(gitIn(dir, ["status", "--porcelain", "-uno"])).toBe("");
  });

  it("does not re-grade the epic while its gap unit is still open, and does once it lands", async () => {
    let asked = 0;
    const counting: RunAgentFn = async (p, opts) => { asked += 1; return mints("wu-ledger-e2e")(p, opts); };
    const dir = makeArena(EPIC_FAILS);
    expect((await toEpicGrade(dir, counting)).decision).toBe("epic-graded-fail+gap-scaffolded");
    expect(asked).toBe(1);

    // HEAD moves for a reason unrelated to the epic. Without the guard the epic re-grades,
    // fails identically, and a `scaffolded` answer (which marks nothing) buys a duplicate.
    writeFileSync(join(dir, "unrelated.ts"), "export const x = 1;" + LF);
    commitAll(dir, "a sibling slice lands");
    const pending = await tick(withGap(dir, counting));
    expect(pending.decision.startsWith("epic-graded")).toBe(false);
    expect(asked, "no second ACT while the first answer is still being built").toBe(1);
    // This fixture installs no build-out law, so the open scaffold cannot move and the loop
    // has nothing to do: the stall guard pauses for an observer. Lift it, as an observer would.
    expect(pending.decision).toBe("stalled");
    rmSync(join(dir, ".doctrine", "pause"), { force: true });

    // The gap unit lands. Its host feature is graded again FIRST (its pass was withdrawn when
    // new work went under it), and only then is the epic asked its question again.
    const unitPath = join(dir, "work", "wu-ledger-e2e.md");
    writeFileSync(unitPath, readFileSync(unitPath, "utf8").replace("status: scaffold", "status: merged"));
    commitAll(dir, "wu-ledger-e2e merged");
    const hostRegraded = await tick(withGap(dir, counting));
    expect(hostRegraded.decision).toBe("feature-graded-pass");
    expect(hostRegraded.unit).toBe("ep-ledger#1.2");
    const regraded = await tick(withGap(dir, counting));
    expect(regraded.decision.startsWith("epic-graded")).toBe(true);
  });

  it("hosts the gap under the last feature that DELIVERS, never a render-only one", async () => {
    // The gap lint scopes coverage to the host's `delivers`; over a render-only feature that
    // set is empty and every attempt is refused, so the epic could never finish (doctrine#100).
    let seen = "";
    const dir = makeArena({
      epics: [{
        id: "ep-ledger", delivers: ["C1.1", "C1.2"], evidence: "exit 7",
        features: [
          { number: "1.1", delivers: ["C1.1"], acceptance: "exit 0" },
          { number: "1.2", delivers: ["C1.2"], acceptance: "exit 0" },
          { number: "1.3", delivers: [], renders: ["C1.2"], acceptance: "exit 0" },
        ],
      }],
      units: [
        { id: "wu-import", parent: "ep-ledger#1.1", status: "merged" },
        { id: "wu-close", parent: "ep-ledger#1.2", status: "merged" },
        { id: "wu-close-screen", parent: "ep-ledger#1.3", status: "merged" },
      ],
    });
    const agent: RunAgentFn = async (prompt, opts) => { seen = prompt; return mints("wu-ledger-e2e")(prompt, opts); };
    for (let i = 0; i < 3; i++) expect((await tick(withGap(dir, agent))).decision).toBe("feature-graded-pass");
    const r = await tick(withGap(dir, agent));
    expect(r.decision).toBe("epic-graded-fail+gap-scaffolded");
    expect(seen).toContain("under feature `ep-ledger#1.2`");
    expect(levelPassed(dir, "feature", "ep-ledger#1.3"), "the render-only feature is not reopened").toBe(true);
  });

  it("withdraws the host feature's pass when gap units go under it, so a stale pass cannot carry the epic", async () => {
    const dir = makeArena(EPIC_FAILS);
    expect((await toEpicGrade(dir, mints("wu-ledger-e2e"))).decision).toBe("epic-graded-fail+gap-scaffolded");
    expect(levelPassed(dir, "feature", "ep-ledger#1.2")).toBe(false);
    expect(levelPassed(dir, "feature", "ep-ledger#1.1"), "only the host is reopened").toBe(true);
    expect(gitIn(dir, ["status", "--porcelain", "-uno"])).toBe("");
  });

  it("reaches an epic that failed BEFORE the ratchet existed, at the same commit, and asks once", async () => {
    // The upgrade case (doctrine#100 review): the old engine graded the epic FAIL and settled
    // it at this commit. With nothing else buildable HEAD never moves, so settlement alone
    // would hide the epic from the new ratchet for ever.
    const dir = makeArena(EPIC_FAILS);
    expect((await tick(deps(dir))).decision).toBe("feature-graded-pass");
    expect((await tick(deps(dir))).decision).toBe("feature-graded-pass");
    expect((await tick(deps(dir))).decision).toBe("epic-graded-fail");   // no ratchet law yet

    // The engine is upgraded; the ratchet law is now installed. HEAD has not moved.
    let asked = 0;
    const rejectsOnce: RunAgentFn = async (_p, opts) => {
      asked += 1;
      // Parented to the wrong feature: rejected, which marks nothing as answered.
      writeFileSync(join(opts.cwd, GAP_OUT_DIR, "wu-stray.md"), [
        "---", "id: wu-stray", "title: wu-stray", "tier: reversible", "budget_usd: 12",
        "status: scaffold", "parent: ep-ledger#9.9", "delivers: [C1.2]", "renders: []",
        "depends_on: []", "---", "## Intent", "", "Because.", "",
      ].join(LF));
      return okSpawn();
    };
    expect((await tick(withGap(dir, rejectsOnce))).decision).toBe("epic-graded-fail+gap-rejected");
    expect(asked).toBe(1);
    // A rejected round at this commit is not re-bought on the next tick.
    expect((await tick(withGap(dir, rejectsOnce))).decision.startsWith("epic-graded-fail+gap")).toBe(false);
    expect(asked).toBe(1);
  });

  it("records an honest empty answer against the epic and does not re-buy it at the same signature", async () => {
    let asked = 0;
    const silent: RunAgentFn = async () => { asked += 1; return okSpawn(); };
    const dir = makeArena(EPIC_FAILS);
    expect((await toEpicGrade(dir, silent)).decision).toBe("epic-graded-fail+gap-empty");
    expect(asked).toBe(1);

    writeFileSync(join(dir, "unrelated.ts"), "export const x = 1;" + LF);
    commitAll(dir, "a sibling slice lands");
    expect((await tick(withGap(dir, silent))).decision).toBe("epic-graded-fail");
    expect(asked, "the same failing evidence buys the same answer once").toBe(1);
  });

  it("stays off, and records the failure, when no ratchet law is installed", async () => {
    const dir = makeArena(EPIC_FAILS);
    expect((await tick(deps(dir))).decision).toBe("feature-graded-pass");
    expect((await tick(deps(dir))).decision).toBe("feature-graded-pass");
    expect((await tick(deps(dir))).decision).toBe("epic-graded-fail");
  });
});

describe("a retired epic clears the chain instead of stalling it", () => {
  /** An epic in the shape a pre-cutover target's epics are actually in, plus a retirement marker. */
  function retiredEpic(dir: string, status: string): void {
    writeFileSync(
      join(dir, "docs", "program", "epics", "ep-old.md"),
      ["---", "id: ep-old", "level: epic", "title: Old", `status: ${status}`,
        "delivers: [C1.1, C1.2]", "renders: []", "depends_on: []", "---",
        "Prose narrowing the PRD, with no feature heading anywhere.", ""].join(LF),
    );
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-q", "-m", `ep-old ${status}`]);
  }

  it("STALLS while the epic is active — the failure this retirement exists to end", async () => {
    const dir = makeArena();
    retiredEpic(dir, "active");
    const r = await tick({ ...deps(dir), agentDefs: PLANNING_AGENTS });
    expect(r.decision).toBe("narrowing-malformed");
    expect(r.detail).toContain("declares no features");
  });

  it("counts a retired epic's coverage all the way to program-done", async () => {
    // The fixture's PRD has two criteria and a retired epic delivers both, with nothing in
    // flight — so the program is genuinely finished, and saying so is the strongest form of
    // "its coverage still counts". Before PR #94's review this reached the epic-set review
    // instead, because program-done asked `levelPassed` of an epic that is never graded.
    const dir = makeArena();
    retiredEpic(dir, "done");
    const r = await tick({ ...deps(dir), agentDefs: PLANNING_AGENTS });
    expect(r.decision).toBe("program-done");
    expect(r.detail).toContain("2/2");
  });

  it("does NOT report program-done while an intent is still building what a retired epic claims", async () => {
    // The case the fix had to get right, and the reason it goes through `dependableSlices`
    // rather than treating retirement as done outright. On a real target the retired epics
    // name C2.7, C10.1 and C10.3 while intents are still building them; "every, not any"
    // holds each of those open until its intent is done.
    const dir = makeArena();
    retiredEpic(dir, "done");
    writeFileSync(join(dir, "work", "intents", "in-building.md"), [
      "---", "id: in-building", "title: Still building", "status: decomposed", "budget_usd: 20",
      "tier_default: reversible", "delivers: [C1.2]",
      "acceptance:", "  - kind: command", '    run: "exit 0"', '    expect: "exit 0"',
      "---", "body", "",
    ].join(LF));
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-q", "-m", "an intent still in flight"]);
    const r = await tick({ ...deps(dir), agentDefs: PLANNING_AGENTS });
    expect(r.decision).not.toBe("program-done");
  });

  it("asks for a new epic for criteria the retired one does NOT deliver", async () => {
    // Retirement is not amnesty for the rest of the PRD. An epic that covered half the
    // program leaves the other half owed, and the chain must still say so.
    const dir = makeArena();
    writeFileSync(
      join(dir, "docs", "program", "epics", "ep-old.md"),
      ["---", "id: ep-old", "level: epic", "title: Old", "status: done",
        "delivers: [C1.1]", "renders: []", "depends_on: []", "---", "Prose only.", ""].join(LF),
    );
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-q", "-m", "half the program"]);
    // The narrowing ACT would run here and this fixture refuses to spend, so the assertion
    // is on WHICH rung was reached rather than on what it produced.
    await expect(tick({ ...deps(dir), agentDefs: PLANNING_AGENTS }))
      .rejects.toThrow("no paid ACT may run in these fixtures");
  });
});

describe("a feature is not frozen by a unit stranded behind an escalation (PR #94 review)", () => {
  /** A unit file with the fields these cases turn on. */
  function unit(dir: string, id: string, parent: string, status: string, delivers: string[], dependsOn: string[] = []): void {
    writeFileSync(join(dir, "work", `${id}.md`), [
      "---", `id: ${id}`, `title: ${id}`, "tier: reversible", `status: ${status}`,
      "budget_usd: 5", `parent: ${parent}`, `delivers: [${delivers.join(", ")}]`,
      `depends_on: [${dependsOn.join(", ")}]`,
      ...(status === "scaffold" ? [] : ["evidence:", "  - kind: command", '    run: "exit 0"', '    expect: "exit 0"']),
      "---", "## Intent", "", "Because.", "",
    ].join(LF));
  }

  it("grades the feature, and retires the stranded unit on disk first", async () => {
    // wu-close waits on C1.1, and the only unit that delivers C1.1 escalated. It can never
    // become admissible, so it sits `ready` for ever — and before this fix the feature
    // waited on it for ever too: no grade, no ratchet, a stalled program.
    const dir = makeArena({
      epics: [{
        id: "ep-ledger", delivers: ["C1.1", "C1.2"], evidence: null,
        features: [{ number: "1.1", delivers: ["C1.1", "C1.2"], acceptance: "exit 0" }],
      }],
    });
    unit(dir, "wu-import", "ep-ledger#1.1", "escalated", ["C1.1"]);
    unit(dir, "wu-close", "ep-ledger#1.1", "ready", ["C1.2"], ["C1.1"]);
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-q", "-m", "an escalation upstream"]);

    const r = await tick(deps(dir));
    expect(r.decision).toBe("feature-graded-pass");
    // Retired for real, not merely counted: left `ready` on disk it would still read as open
    // work to every other reader in the tick.
    expect(readFileSync(join(dir, "work", "wu-close.md"), "utf8")).toContain("status: escalated");
  });

  it("does NOT retire a unit whose criterion another feature is still building", async () => {
    // The direction this must never be wrong in, and the reason `strandedChildren` looks at
    // EVERY unit. C1.1's escalated deliverer is in this feature, but wu-other in a second
    // feature also delivers C1.1 and is still alive. Asked of this feature's children alone,
    // C1.1 looks dead and wu-close would be retired — permanently, on disk — over work that is
    // merely in flight.
    const dir = makeArena({
      epics: [{
        id: "ep-ledger", delivers: ["C1.1", "C1.2"], evidence: null,
        features: [
          { number: "1.1", delivers: ["C1.2"], acceptance: "exit 0" },
          { number: "1.2", delivers: ["C1.1"], acceptance: "exit 0" },
        ],
      }],
    });
    unit(dir, "wu-import", "ep-ledger#1.1", "escalated", ["C1.1"]);
    unit(dir, "wu-close", "ep-ledger#1.1", "ready", ["C1.2"], ["C1.1"]);
    unit(dir, "wu-other", "ep-ledger#1.2", "scaffold", ["C1.1"]);
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-q", "-m", "C1.1 is still being built elsewhere"]);

    const r = await tick(deps(dir));
    expect(r.decision).not.toContain("feature-graded");
    expect(readFileSync(join(dir, "work", "wu-close.md"), "utf8")).toContain("status: ready");
  });
});

describe("program-done is never reported over a set the epic-set gate would block (PR #94 second review)", () => {
  it("falls through to the set review instead, which pauses with the reason", async () => {
    // The scenario exactly as reviewed. Two epics both deliver C1.1 — seeded directly,
    // because the mint gate now refuses the second — and every unit is merged, so the grades
    // and the ratchet keep the tick busy and rung 3, where the set review lives, is not
    // reached until the end. Both epics then pass, and program-done would have been the
    // next thing said.
    const dir = makeArena({
      epics: [
        { id: "ep-a", delivers: ["C1.1", "C1.2"], evidence: "exit 0",
          features: [{ number: "1.1", delivers: ["C1.1", "C1.2"], acceptance: "exit 0" }] },
        { id: "ep-b", delivers: ["C1.1"], evidence: "exit 0",
          features: [{ number: "1.1", delivers: ["C1.1"], acceptance: "exit 0" }] },
      ],
      units: [
        { id: "wu-a", parent: "ep-a#1.1", status: "merged" },
        { id: "wu-b", parent: "ep-b#1.1", status: "merged" },
      ],
    });
    const decisions: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await tick({ ...deps(dir), agentDefs: PLANNING_AGENTS });
      decisions.push(r.decision);
      if (r.decision.endsWith("-blocked") || r.decision === "program-done") break;
    }
    expect(decisions, decisions.join(" -> ")).not.toContain("program-done");
    expect(decisions.at(-1)).toBe("epic-set-blocked");
    expect(readFileSync(join(dir, ".doctrine", "pause"), "utf8")).toContain("C1.1 is claimed by 2 epics");
  });
});

describe("every ACT the tick spawns runs under the containment deny profile (PR #98 review)", () => {
  it("build-out passes --settings", async () => {
    // Missing until review found it: build-out and decompose held `Write` with nothing between
    // them and the doors, and a write into a gitignored door is invisible to the lane check.
    const LAW = join(tmp, "build-out-law-deny.md");
    writeFileSync(LAW, ["---", "name: build-out", "---", "Append the spec.", ""].join(LF));
    const dir = makeArena({
      epics: [{ id: "ep-ledger", delivers: ["C1.1"], evidence: null,
        features: [{ number: "1.1", delivers: ["C1.1"], acceptance: "exit 0" }] }],
      units: [{ id: "wu-import", parent: "ep-ledger#1.1", status: "scaffold", withEvidence: false }],
    });
    let argv: readonly string[] = [];
    const capture: RunAgentFn = async (_p, opts) => {
      argv = opts.argv;
      return { spawnFailed: false, exitCode: 0, signal: null, timedOut: false, outage: false, logPath: "x", resultMessage: { type: "result", subtype: "success", total_cost_usd: 0.1 } } as unknown as SpawnRunResult;
    };
    await tick({ ...deps(dir, capture), agentDefs: { ...AGENTS, buildOut: LAW } });
    expect(argv).toContain("--settings");
    const settings = JSON.parse(readFileSync(argv[argv.indexOf("--settings") + 1]!, "utf8")) as { permissions: { deny: string[] } };
    expect(settings.permissions.deny.some((d) => d.includes(".doctrine/pause"))).toBe(true);
  });
});
