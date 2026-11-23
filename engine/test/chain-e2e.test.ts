import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseCriteria } from "../src/coverage.js";
import { tick, type TickDeps } from "../src/dispatch.js";
import { parseIntent } from "../src/intent.js";
import { FileNarrowingStore } from "../src/narrowing-store.js";
import type { SpawnRunResult } from "../src/spawn.js";
import { pausePath } from "../src/steering.js";

/**
 * The whole chain, driven tick by tick against fake agents.
 *
 * **Why this file exists.** The three most recent defects in this layer were all
 * COMPOSITION failures, and not one of them was visible to a unit test:
 *
 *  - a criterion-less program reported the chain complete, because coverage over an empty
 *    set is vacuously satisfied at every hop;
 *  - an honest empty intent ACT left its feature unserved, so the next tick bought the
 *    same empty answer forever;
 *  - "an outstanding slice is a pass" composed with "served = some intent names it" to
 *    finish a feature on its first batch of three and drop the rest, while the chain
 *    reported complete.
 *
 * Every one of those was two correct behaviours meeting. A unit test asks whether a
 * function is right; only a run asks whether the functions are right TOGETHER. This is
 * that run, offline and free.
 */

const LF = String.fromCharCode(10);
const tmp = mkdtempSync(join(tmpdir(), "doctrine-chain-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Four criteria across two capabilities — enough for two epics, or one with two features. */
const PRD = [
  "# PRD", "",
  "### C1. Ledger", "",
  "- **machine** `C1.1` Import produces the fixture's expected lines.",
  "- **machine** `C1.2` Close with one uncategorized line refuses.", "",
  "### C2. Billing", "",
  "- **machine** `C2.1` Billing lists customers with unbilled work.",
  "- **machine** `C2.2` An invoice pushed to the sandbox comes back equal.", "",
].join(LF);

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function arena(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "docs", "program"), { recursive: true });
  mkdirSync(join(dir, "work", "intents"), { recursive: true });
  mkdirSync(join(dir, ".doctrine", "runs"), { recursive: true });
  writeFileSync(join(dir, "docs", "program", "PRD.md"), PRD);
  writeFileSync(join(dir, "docs", "program", "ARCH.md"), `# ARCH${LF}`);
  writeFileSync(join(dir, "law.md"), ["---", "name: l", "---", "law", ""].join(LF));
  writeFileSync(join(dir, "judge-law.md"), ["---", "name: j", "---", "judge law", ""].join(LF));
  writeFileSync(join(dir, "fixer-law.md"), ["---", "name: nf", "---", "fixer law", ""].join(LF));
  writeFileSync(join(dir, ".doctrine", "manifest.json"), JSON.stringify({
    name: "t", base_branch: "development",
    program: { prd: "docs/program/PRD.md", arch: "docs/program/ARCH.md" },
  }));
  gitIn(dir, ["init", "-q", "-b", "development"]);
  gitIn(dir, ["add", "-A"]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

/**
 * An epic, with its features written inside it — which is the only shape there is now.
 * `features` is one entry per `### Feature` heading: the criteria that heading delivers.
 */
const narrowing = (id: string, delivers: string[], features: string[][]) => [
  "---", `id: ${id}`, "level: epic", `title: ${id}`, "status: active",
  `delivers: [${delivers.join(", ")}]`, "---", "the slice", "",
  ...features.flatMap((delivers, i) => [
    `### Feature 1.${i + 1}: ${id} slice ${i + 1}`, "",
    `- **Delivers:** ${delivers.join(", ")}`,
    "- **Renders:** (none)",
    "- **Depends on:** (none)",
    "- **Acceptance:** (none)", "",
  ]),
].join(LF);

/** A scaffolded unit: what and why, and nothing about how (ADR-0001, ADR-0006). */
const scaffoldDoc = (id: string, parent: string, delivers: string[]) => [
  "---", `id: ${id}`, `title: ${id}`, "tier: reversible", "budget_usd: 12",
  "status: scaffold", `parent: ${parent}`,
  `delivers: [${delivers.join(", ")}]`, "renders: []", "depends_on: []",
  "---", "## Intent", "", "Because the slice needs building.", "",
].join(LF);

const intentDoc = (id: string, parent: string, delivers: string[]) => [
  "---", `id: ${id}`, "level: intent", `title: ${id}`, "status: proposed",
  `parent: ${parent}`, "budget_usd: 20", "tier_default: reversible",
  `delivers: [${delivers.join(", ")}]`,
  "acceptance:", "  - kind: command", '    run: "true"', '    expect: "exit 0"',
  "---", "the work", "",
].join(LF);

const NARROWING_PASS = JSON.stringify({
  verdict: "pass",
  checks: ["quotes-are-real", "nothing-invented", "nothing-binding-missing", "right-size", "points-not-copies", "dependencies-declared"]
    .map((check) => ({ check, ok: true, cite: "x" })),
  problems: [],
});

function okSpawn(): SpawnRunResult {
  return {
    spawnFailed: false, exitCode: 0, signal: null, timedOut: false, outage: false,
    logPath: "", resultMessage: { type: "result", subtype: "success", total_cost_usd: 0.1 },
  } as unknown as SpawnRunResult;
}

/**
 * A planner that answers whatever the chain asks for next, from a script.
 *
 * `plan` maps a level to the documents it should produce, one per call — so the fake can
 * mint a feature's intents across SEVERAL calls, which is the case the ceiling forces and
 * the case the composition bug lived in.
 */
function planner(dir: string, plan: { epics: Array<{ delivers: string[]; features: string[][] }>; intents: Array<[string, string[]]> }) {
  let epicN = 0, intentN = 0;
  // The ids minted by the LAST intent ACT. The program verdict must account for exactly
  // the newly minted set: judging an intent that was not minted this round is refused, and
  // rightly — a verdict that ranges over the whole directory is not a ruling on this run.
  let lastMinted: string[] = [];
  const calls: string[] = [];
  const run = async (prompt: string, opts: { cwd: string; logPath: string }): Promise<SpawnRunResult> => {
    writeFileSync(opts.logPath, "");
    const verdict = /Write your verdict JSON to EXACTLY: (.+)/.exec(prompt);
    if (verdict) { writeFileSync(verdict[1]!.trim(), NARROWING_PASS); return okSpawn(); }
    // The SET judge, which reads a whole level rather than one document. It answers
    // coherent here: this fixture's planner partitions cleanly, and a fake that invented
    // a cross-document finding would be testing the fake.
    const setVerdict = /Write this JSON to EXACTLY: (.+)/.exec(prompt);
    if (setVerdict) {
      calls.push("set-judge");
      writeFileSync(setVerdict[1]!.trim(), JSON.stringify({
        verdict: "coherent",
        checks: ["no-two-build-one-thing", "order-matches-parent", "gaps-are-shared", "no-contradicted-boundaries"]
          .map((check) => ({ check, ok: true, cite: "read all of them" })),
        findings: [],
      }));
      return okSpawn();
    }
    const progJudge = /Write your verdict to EXACTLY: (.+)/.exec(prompt);
    if (progJudge) {
      writeFileSync(progJudge[1]!.trim(), JSON.stringify({
        verdict: "pass",
        intents: lastMinted.map((id) => ({ id, ok: true, cite: "the PRD", problems: [] })),
        coverage_check: "grepped", nothing_dropped: "accounted for",
      }));
      return okSpawn();
    }
    // A correction pass, if one is ever asked for. Both judges pass in this fixture, so
    // reaching here means the engine found MECHANICAL findings — and the honest answer is
    // to change nothing and let the free re-check refuse, which surfaces the arithmetic
    // problem rather than hiding it behind a fake that "fixes" whatever it is handed.
    if (prompt.includes("# The document to correct") || prompt.includes("# The intents to correct")) {
      calls.push("fix");
      return okSpawn();
    }
    if (prompt.includes("Write ONE **epic**")) {
      calls.push("epic");
      const spec = plan.epics[epicN++];
      if (spec !== undefined) {
        writeFileSync(join(opts.cwd, `ep-${epicN}.md`), narrowing(`ep-${epicN}`, spec.delivers, spec.features));
        // The units under its features, written in the same ACT (ADR-0006). One per
        // feature here; a real ACT may cut a feature into several.
        mkdirSync(join(opts.cwd, "work"), { recursive: true });
        spec.features.forEach((delivers, i) => {
          const epic = `ep-${epicN}`;
          writeFileSync(join(opts.cwd, "work", `wu-${epic}-${i + 1}.md`), scaffoldDoc(`wu-${epic}-${i + 1}`, `${epic}#1.${i + 1}`, delivers));
        });
      }
      return okSpawn();
    }
    if (prompt.includes("work/intents/<id>.md")) {
      calls.push("intent");
      const spec = plan.intents[intentN++];
      lastMinted = [];
      if (spec !== undefined) {
        lastMinted = [`in-${intentN}`];
        writeFileSync(join(dir, "work", "intents", `in-${intentN}.md`), intentDoc(`in-${intentN}`, spec[0], spec[1]));
      }
      return okSpawn();
    }
    // Anything else — the unit decomposer, the implementer — is out of this file's scope
    // and answers honestly empty. Matching it as the intent rung by accident consumed a
    // scripted intent and made the chain look broken when the fake was.
    calls.push("other");
    return okSpawn();
  };
  return { run, calls };
}

const deps = (dir: string, runAgent: TickDeps["runAgent"]): TickDeps => ({
  arenaDir: dir,
  agentDefs: {
    implementer: join(dir, "law.md"), judge: join(dir, "judge-law.md"),
    decomposer: join(dir, "law.md"), planJudge: join(dir, "judge-law.md"),
    programDecomposer: join(dir, "law.md"), programJudge: join(dir, "judge-law.md"),
    narrowingDecomposer: join(dir, "law.md"), narrowingJudge: join(dir, "judge-law.md"),
    narrowingFixer: join(dir, "fixer-law.md"),
    narrowingSetJudge: join(dir, "judge-law.md"),
    intentFixer: join(dir, "fixer-law.md"),
  },
  ...(runAgent !== undefined ? { runAgent } : {}),
});

/**
 * Put an epic in the store DIRECTLY, with no units under its features.
 *
 * That state cannot be produced through the epic ACT any more — its mint gate refuses an
 * epic that scaffolds nothing — and it is the only state in which the legacy program rung
 * (feature -> intents) is reached. The two tests using this guard that rung for as long as
 * it exists; they are deleted with it, with the intent dialect, at cutover.
 */
function seedLegacyEpic(dir: string, id: string, delivers: string[], features: string[][]): void {
  mkdirSync(join(dir, "docs", "program", "epics"), { recursive: true });
  writeFileSync(join(dir, "docs", "program", "epics", `${id}.md`), narrowing(id, delivers, features));
  gitIn(dir, ["add", "-A"]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `seed ${id}`], { cwd: dir });
}

async function run(dir: string, p: ReturnType<typeof planner>, ticks: number): Promise<string[]> {
  const decisions: string[] = [];
  for (let i = 0; i < ticks; i++) decisions.push((await tick(deps(dir, p.run))).decision);
  return decisions;
}

describe("the chain end to end, offline", () => {
  it("walks PRD to epics to units, in that order, and stops when covered", async () => {
    const dir = arena("happy");
    const p = planner(dir, {
      epics: [
        { delivers: ["C1.1", "C1.2"], features: [["C1.1", "C1.2"]] },
        { delivers: ["C2.1", "C2.2"], features: [["C2.1", "C2.2"]] },
      ],
      intents: [["ep-1#1.1", ["C1.1", "C1.2"]], ["ep-2#1.1", ["C2.1", "C2.2"]]],
    });
    // Enough ticks to REACH the end: each minted intent is followed by the unit
    // decomposer's own tick before the chain is asked again. Asserting a terminal state
    // the run never reaches is a test that passes without checking its own claim.
    const decisions = await run(dir, p, 16);

    // The ORDER is the design. The epic layer goes to completion first, because a unit cut
    // from a half-drawn epic layer is cut from boundaries that then move underneath it —
    // and the set review sits between the levels, fired the moment `nextChainNeed` stops
    // asking for an epic. Seven epics on a target were published with two of them
    // building the same Attention queue because nothing looked there.
    //
    // There is no feature ACT in this sequence and that absence is the point of ADR-0001:
    // features arrive with their epic, in the same document, written by the same call.
    expect(p.calls.slice(0, 3)).toEqual(["epic", "epic", "set-judge"]);
    expect(p.calls, "a feature is never minted on its own").not.toContain("feature");
    expect(decisions.slice(0, 3)).toEqual(["epic-minted", "epic-minted", "epic-set-reviewed"]);

    // Once, not every tick. The report carries the hash of the documents it read, so a set
    // that has not changed is not re-judged — the unbounded re-judge every other rung
    // removed, arriving at a new one.
    expect(decisions.filter((d) => d === "epic-set-reviewed").length).toBe(1);
    expect(p.calls.filter((c) => c === "set-judge").length, "the epic set, and nothing below it").toBe(1);

    // And the report is the key, so it is COMMITTED — a set review that lived only in
    // `.doctrine/runs/` would be lost to a fresh clone and re-bought every time.
    expect(readFileSync(join(dir, "docs/program/coherence/epics.md"), "utf8")).toContain("hash:");
    expect(gitIn(dir, ["status", "--porcelain", "-uall", "--", "docs/program/coherence"])).toBe("");

    // NO intents. Each epic arrived with its units already scaffolded under its features
    // (ADR-0006), so every feature is served by them — and minting intents here would plan
    // the same work twice and then build it twice. The first version of this test expected
    // `program-minted` and so asserted exactly that duplication; external review on PR #94
    // caught it, because `servedFeatures` was being asked about intents alone.
    expect(decisions).not.toContain("program-minted");
    expect(p.calls, "the legacy intent rung is never reached").not.toContain("intent");
    // And it STOPS: every criterion reaches an epic, every feature is served by its units.
    expect(decisions).toContain("chain-complete");
    expect(decisions).not.toContain("feature-incomplete");
    expect(p.calls.filter((c) => c === "epic").length).toBe(2);

    const store = new FileNarrowingStore(dir);
    expect(store.load("epic").narrowings.map((n) => n.id)).toEqual(["ep-1", "ep-2"]);
  }, 90_000);

  it("REGRESSION: a feature needing more intents than the ceiling is revisited, not abandoned", async () => {
    // The composition bug, end to end. One feature holds all four criteria; the planner
    // takes two on its first pass and two on its second. "Served = some intent names it"
    // finished the feature after the first and dropped C2.1 and C2.2 while reporting
    // `complete` — two correct behaviours meeting, invisible to either one's tests.
    // LEGACY RUNG — see `seedLegacyEpic`. Deleted with the intent dialect at cutover.
    const dir = arena("revisit");
    seedLegacyEpic(dir, "ep-1", ["C1.1", "C1.2", "C2.1", "C2.2"], [["C1.1", "C1.2", "C2.1", "C2.2"]]);
    const p = planner(dir, {
      epics: [],
      intents: [["ep-1#1.1", ["C1.1", "C1.2"]], ["ep-1#1.1", ["C2.1", "C2.2"]]],
    });
    await run(dir, p, 12);

    // The intent rung ran TWICE for the one feature.
    expect(p.calls.filter((c) => c === "intent").length).toBeGreaterThanOrEqual(2);

    const intents = readdirSync(join(dir, "work", "intents")).filter((f) => f.endsWith(".md"))
      .map((f) => parseIntent(readFileSync(join(dir, "work", "intents", f), "utf8")))
      .flatMap((r) => (r.ok ? [r.intent] : []));
    const claimed = new Set(intents.flatMap((i) => i.delivers));
    expect([...claimed].sort()).toEqual(["C1.1", "C1.2", "C2.1", "C2.2"]);
  }, 90_000);




  it("REGRESSION: a planner with nothing to add on an uncovered feature is a contradiction, not a completion", async () => {
    // LEGACY RUNG — see `seedLegacyEpic`. Deleted with the intent dialect at cutover.
    const dir = arena("incomplete");
    seedLegacyEpic(dir, "ep-1", ["C1.1", "C1.2", "C2.1", "C2.2"], [["C1.1", "C1.2", "C2.1", "C2.2"]]);
    const p = planner(dir, {
      epics: [],
      intents: [], // the ACT mints nothing, while four criteria wait
    });
    // The epic set is reviewed as it completes, and a review is a tick's work like any other.
    const decisions = await run(dir, p, 6);
    expect(decisions).toContain("feature-incomplete");
    // Settled at HEAD: the contradiction is not bought again every idle interval.
    expect(p.calls.filter((c) => c === "intent").length).toBe(1);
  }, 60_000);
});
