import { parseCriteria } from "../src/coverage.js";
import { FileNarrowingStore } from "../src/narrowing-store.js";
import { reviewEpicSet } from "../src/narrowing-set.js";
import { writeSetReport } from "../src/narrowing-set-act.js";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { priorNarrowingRejectionForTest, tick, type TickDeps } from "../src/dispatch.js";
import { MAX_INTENTS_PER_RUN, readRejectedDrafts, readRejectedObjections, runProgramDecompose, type ProgramContext } from "../src/program.js";
import { assembleDecomposerPrompt } from "../src/decompose.js";
import { parseNarrowing } from "../src/narrowing.js";
import type { SpawnRunResult } from "../src/spawn.js";

const LF = String.fromCharCode(10);

/**
 * The feature every fixture intent is cut from — a shape, not a document, because that is
 * what a feature is now: a heading inside `ep-billing` whose `Delivers` list bounds what
 * its intents may claim.
 */
const testFeature = () => ({ id: "ep-billing#1.1", delivers: ["C1.1"] });
const tmp = mkdtempSync(join(tmpdir(), "doctrine-program-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const INTENT = (id: string, status = "proposed", acceptance = true): string => `---
id: ${id}
title: A slice
status: ${status}
budget_usd: 40
tier_default: reversible
parent: ep-billing#1.1
level: intent
delivers: [C1.1]
${acceptance ? `acceptance:
  - kind: command
    run: "test -f MARKER"
    expect: "exit 0 once the slice exists"` : ""}
---
The brief.
`;

function arena(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "work", "intents"), { recursive: true });
  mkdirSync(join(dir, "docs", "program"), { recursive: true });
  mkdirSync(join(dir, ".doctrine", "runs"), { recursive: true });
  writeFileSync(join(dir, "docs", "program", "PRD.md"), "# PRD\nThe app bills hours.\n");
  writeFileSync(join(dir, "docs", "program", "ARCH.md"), "# ARCH\nSQLite, integer cents.\n");
  writeFileSync(join(dir, "law.md"), "---\nname: pd\n---\nprogram law\n");
  writeFileSync(join(dir, "judge-law.md"), "---\nname: pj\n---\njudge law\n");
  writeFileSync(join(dir, "fixer-law.md"), "---\nname: nf\n---\nfixer law\n");
  gitIn(dir, ["init", "-q", "-b", "development"]);
  gitIn(dir, ["add", "-A"]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

function ok(cost = 0.5): SpawnRunResult {
  return {
    exitCode: 0, spawnFailed: false, signal: null, stdout: "", stderr: "",
    timedOut: false, outage: false, logPath: "",
    resultMessage: { type: "result", subtype: "success", total_cost_usd: cost },
  } as unknown as SpawnRunResult;
}

/** Every prompt the correction pass was given this test, for asserting what it was told. */
let fixerPrompts: string[] = [];
beforeEach(() => { fixerPrompts = []; });

/**
 * An ACT that writes `files`, a judge that answers `verdict`, and a correction pass that
 * writes `fixes`.
 *
 * `fixes` omitted means the pass changed nothing — a real case and one the engine refuses,
 * because publishing a byte-identical document would report every finding as addressed.
 */
function agents(dir: string, files: Record<string, string>, verdict: unknown, fixes?: Record<string, string>) {
  return async (prompt: string, opts: { cwd: string; logPath: string }): Promise<SpawnRunResult> => {
    writeFileSync(opts.logPath, "");
    if (prompt.includes("Write your verdict to EXACTLY:")) {
      const m = /Write your verdict to EXACTLY: (.+)/.exec(prompt);
      // A raw string is written verbatim, so a test can hand the judge unparseable
      // output; anything else is serialised as a verdict.
      if (m) writeFileSync(m[1]!.trim(), typeof verdict === "string" ? verdict : JSON.stringify(verdict));
      return ok(0.2);
    }
    if (prompt.includes("# The intents to correct")) {
      fixerPrompts.push(prompt);
      for (const [rel, body] of Object.entries(fixes ?? {})) {
        mkdirSync(join(dir, rel, ".."), { recursive: true });
        writeFileSync(join(dir, rel), body);
      }
      return ok(0.3);
    }
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
    return ok();
  };
}

function ctx(dir: string, runAgent: ProgramContext["runAgent"]): ProgramContext {
  return {
    arenaDir: dir,
    prdPath: "docs/program/PRD.md",
    archPath: "docs/program/ARCH.md",
    featurePath: "docs/program/epics/ep-billing.md",
    intentFixerAgentPath: join(dir, "fixer-law.md"),
    feature: testFeature(),
    existing: [],
    logPath: join(dir, ".doctrine", "runs", "pd.log"),
    agentDefinitionPath: join(dir, "law.md"),
    programJudgeAgentPath: join(dir, "judge-law.md"),
    budgetUsd: 20,
    ...(runAgent !== undefined ? { runAgent } : {}),
  };
}

const PASS = { verdict: "pass", intents: [{ id: "in-2026-09-05-skeleton", ok: true, cite: "The app bills hours.", problems: [] }], coverage_check: "grepped src/, nothing built", nothing_dropped: "all slices taken" };

/**
 * The rung that lets the loop find its own next work. Without it an app-sized program
 * stalls the moment its intents run out — which is exactly what happened when a
 * target's harness intent finished and the loop went idle waiting for a person.
 */
describe("the program rung — intents minted from the PRD, gated like a plan", () => {
  it("mints, lints, judges and promotes proposed -> ready in one commit", async () => {
    const dir = arena("mints");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
    }, PASS)));

    expect(out.kind).toBe("minted");
    if (out.kind !== "minted") return;
    expect(out.intentIds).toEqual(["in-2026-09-05-skeleton"]);
    // Promotion is the ENGINE's, never the ACT's: it wrote `proposed`, this is `ready`.
    expect(readFileSync(join(dir, "work", "intents", "in-2026-09-05-skeleton.md"), "utf8")).toContain("status: ready");
    expect(gitIn(dir, ["log", "-1", "--format=%s"])).toContain("program-decompose");
    expect(gitIn(dir, ["status", "--porcelain", "-uall", "--", "work", "src", "docs"])).toBe("");
  });

  it("an intent with no acceptance evidence is a FINDING, and correcting it publishes", async () => {
    // It used to revert the run, and the next tick paid a planner to mint a different
    // intent. Now the correction pass is told what is missing and adds it.
    const dir = arena("no-acceptance");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-vague.md": INTENT("in-2026-09-05-vague", "proposed", false),
    }, { ...PASS, intents: [{ id: "in-2026-09-05-vague", ok: true, cite: "The app bills hours.", problems: [] }] }, {
      "work/intents/in-2026-09-05-vague.md": INTENT("in-2026-09-05-vague"),
    })));

    expect(out.kind).toBe("minted");
    if (out.kind !== "minted") return;
    expect(out.findingsFixed).toBe(1);
    expect(fixerPrompts[0]!).toMatch(/acceptance/);
    expect(readFileSync(join(dir, "work", "intents", "in-2026-09-05-vague.md"), "utf8")).toContain("status: ready");
  });

  it("...and one that survives the correction is refused, because re-checking is free", async () => {
    // The asymmetry the whole change turns on. The paid judge ran once and is not asked
    // again; the arithmetic is deterministic and costs nothing, so it is re-run and can
    // afford to refuse. It is also the half that protects the coverage chain.
    const dir = arena("no-acceptance-survives");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-vague.md": INTENT("in-2026-09-05-vague", "proposed", false),
    }, { ...PASS, intents: [{ id: "in-2026-09-05-vague", ok: true, cite: "x", problems: [] }] }, {
      // It edited the intent — retitled it — and still left no acceptance evidence. The
      // realistic shape of this failure: a pass that visibly did something is the one
      // nothing else would question.
      "work/intents/in-2026-09-05-vague.md": INTENT("in-2026-09-05-vague", "proposed", false).replace("title: A slice", "title: A reworded slice"),
    })));

    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toContain("survived the correction pass");
    expect(out.problems.join(" ")).toMatch(/acceptance/);
    // Reverted wholesale — a half-minted program is worse than none.
    expect(gitIn(dir, ["status", "--porcelain", "-uall", "--", "work", "src", "docs"])).toBe("");
  });

  it("a program-decomposer that writes anything but an intent is reverted wholesale", async () => {
    const dir = arena("touches-code");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-ok.md": INTENT("in-2026-09-05-ok"),
      "src/app.ts": "export const sneaky = 1;\n",
    }, PASS)));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.problems).toContain("src/app.ts");
    expect(gitIn(dir, ["status", "--porcelain", "-uall", "--", "work", "src", "docs"])).toBe("");
  });

  it("more than the ceiling is refused — a program planned to the end is fiction", async () => {
    const dir = arena("too-many");
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_INTENTS_PER_RUN; i++) {
      files[`work/intents/in-2026-09-05-s${i}.md`] = INTENT(`in-2026-09-05-s${i}`);
    }
    // A finding now, not a refusal — but one no correction pass addressed, so the free
    // re-check refuses it.
    // The judge must report on every intent, or the RUN fails before findings matter —
    // so it does, and the ceiling is what is left to find.
    const judged = {
      ...PASS,
      intents: Object.keys(files).map((f) => ({
        id: f.slice("work/intents/".length, -3), ok: true, cite: "The app bills hours.", problems: [],
      })),
    };
    const out = await runProgramDecompose(ctx(dir, agents(dir, files, judged)));
    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(fixerPrompts[0]!).toMatch(/ceiling is 3/);
  });

  it("hop 3: an intent covering a criterion its feature does not is CORRECTED", async () => {
    // Bloat, at the last hop. The feature holds C1.1 alone; an intent claiming C9.9 is
    // scope the feature has no record of. Mechanical, so finding it costs nothing — the
    // judge's round is for quotations and fidelity, not arithmetic.
    const dir = arena("hop3-bloat");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton").replace("delivers: [C1.1]", "delivers: [C1.1, C9.9]"),
    }, PASS, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
    })));

    expect(out.kind).toBe("minted");
    // And the correction pass was told WHICH id, by name. A finding that does not name
    // the thing to change is a finding nobody can act on.
    expect(fixerPrompts[0]!).toContain("C9.9");
    expect(fixerPrompts[0]!).toContain("outside the feature");
    expect(fixerPrompts[0]!).toContain("the complete list");
  });

  it("hop 3: an intent with no feature backlink is an orphan and is refused", async () => {
    const dir = arena("hop3-orphan");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton").replace("parent: ep-billing#1.1" + LF, ""),
    }, PASS)));

    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(fixerPrompts[0]!).toContain("cut from the feature it names");
  });

  it("a judge rejection reverts the intents and returns its reasons for the retry", async () => {
    const dir = arena("judge-fail");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-invented.md": INTENT("in-2026-09-05-invented"),
    }, {
      verdict: "fail",
      intents: [{ id: "in-2026-09-05-invented", ok: false, cite: "", problems: ["not in the PRD: invented a reporting feature"] }],
      coverage_check: "grepped", nothing_dropped: "all slices taken",
    })));

    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toContain("invented a reporting feature");
    expect(gitIn(dir, ["status", "--porcelain", "-uall", "--", "work", "src", "docs"])).toBe("");
  });

  it("an outstanding slice is a PASS, not a failure — the ceiling is three intents", async () => {
    // The schema once said "no intent takes it, which is a fail", contradicting the
    // judge's own law, which says naming the outstanding slices IS a pass. A judge
    // following the schema would have rejected every partial batch — and with a ceiling
    // of three intents, every source needing a fourth could never have progressed.
    const dir = arena("outstanding-passes");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
    }, { ...PASS, nothing_dropped: "slice 1 -> in-2026-09-05-skeleton; slices 2 and 3 outstanding, for the next round" })));

    expect(out.kind).toBe("minted");
  });

  it("a judge that passes without accounting for what is LEFT is not a pass", async () => {
    // The other direction, and the one this ladder never had. Every gate asked whether
    // something was invented; none asked whether something was dropped, so an intent set
    // serving half its brief passed exactly like one serving all of it.
    const dir = arena("nothing-dropped");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
    }, { verdict: "pass", intents: [{ id: "in-2026-09-05-skeleton", ok: true, cite: "The app bills hours.", problems: [] }], coverage_check: "x" })));

    // A `failed`, not a `rejected`. Each of these says the JUDGE did not do its job, and
    // there is nothing in an intent for a correction pass to change in response — handing
    // it to a fixer would launder an unperformed check into a corrected one. So it fails
    // the run and the engine pays for another judge.
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.problems.join(" ")).toMatch(/still lists as remaining/);
  });

  it("the judge is handed the FEATURE as its source, never the PRD", async () => {
    // The planner is told the feature is "YOUR SOURCE, and the only one you need"; a judge
    // grading against documents its planner was forbidden to read fails faithful work and
    // passes work that reached past its own slice.
    //
    // This assertion is why the word could not be tidied on its own. `program-judge.md`
    // used to trigger on the literal "BRIEF" — "when your task names a BRIEF, that is your
    // source" — so renaming it here without rewriting the law would have stopped the
    // trigger firing and dropped the judge through to its "the PRD or ARCH when you were
    // not given one" fallback: the grandparent-grading defect, restored by a rename. Law
    // and prompt were changed in one edit, and `contract-drift.test.ts` now watches the
    // pair so the next rename cannot separate them.
    const dir = arena("judge-source");
    let judgePrompt = "";
    const out = await runProgramDecompose({
      ...ctx(dir, agents(dir, {
        "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
      }, PASS)),
      runAgent: async (prompt, opts) => {
        const inner = agents(dir, { "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton") }, PASS);
        if (prompt.includes("What you are judging")) judgePrompt = prompt;
        return inner(prompt, opts);
      },
    });

    expect(out.kind).toBe("minted");
    expect(judgePrompt).toContain("ep-billing.md");
    expect(judgePrompt).toContain("THE FEATURE these intents were minted from");
    // and the grandparent is NOT offered as a source alongside it
    expect(judgePrompt).not.toMatch(/^- PRD: /m);
  });

  it("a judge that passes without citing the PRD is not a pass", async () => {
    // Cite-or-fail, the same law the plan-judge runs on: a verdict that approves
    // without quoting the text it approves against has checked nothing.
    const dir = arena("uncited");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
    }, { verdict: "pass", intents: [{ id: "in-2026-09-05-skeleton", ok: true, cite: "   ", problems: [] }], coverage_check: "x", nothing_dropped: "all slices taken" })));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.problems.join(" ")).toMatch(/no citation/);
  });

  it("the findings the loop deferred reach the planner that can act on them", async () => {
    // handleReview tells reviewers a deferred finding "enters intake as a maintenance unit".
    // It did not: nothing read context/review-findings/. No engine code touched it, and the
    // decomposer's law lists context/contracts.md, context/decisions.md and context/defects/
    // and stops there. Seven had piled up on a target, one of them a defect found,
    // deferred, and rediscovered by the promotion review three days later.
    const dir = arena("outstanding-findings");
    mkdirSync(join(dir, "context", "review-findings"), { recursive: true });
    writeFileSync(
      join(dir, "context", "review-findings", "u-old-deferred.md"),
      "# Deferred review findings — u-old\n\n- trace() drops the source line for an entry edited after it was billed\n",
    );
    // Committed: an uncommitted file in the arena reads as something the ACT wrote, and
    // the containment check then reverts the whole run.
    gitIn(dir, ["add", "-A"]);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a finding the loop deferred"], { cwd: dir });

    let sawTheFinding = false;
    const out = await runProgramDecompose(ctx(dir, async (prompt, opts) => {
      if (prompt.includes("Maintenance this program already owes")
        && prompt.includes("drops the source line")) sawTheFinding = true;
      return agents(dir, {
        "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
      }, { verdict: "pass", intents: [{ id: "in-2026-09-05-skeleton", ok: true, cite: "PRD §1", problems: [] }], coverage_check: "x", nothing_dropped: "all slices taken" })(prompt, opts);
    }));

    expect(sawTheFinding).toBe(true);
    expect(out.kind).toBe("minted");
  });

  it("and reach the UNIT planner too, for targets that have no program rung", () => {
    // A target configured without `manifest.program` — hand-written intents, which is how a
    // PR-review target runs — never invokes the program decomposer at all. Feeding the
    // findings only there left exactly those targets with a directory nobody reads, which is
    // the bug being fixed rather than a corner of it.
    const dir = arena("findings-to-decomposer");
    mkdirSync(join(dir, "context", "review-findings"), { recursive: true });
    writeFileSync(
      join(dir, "context", "review-findings", "u-old-deferred.md"),
      "# Deferred review findings — u-old\n\n- payments match on qbo_invoice_id alone, across realms\n",
    );
    const prompt = assembleDecomposerPrompt({
      // A real `WorkUnit`, not a cast. The cast was hiding the shape: it survived
      // `acceptance` becoming `evidence` at compile time and threw at run time on a
      // field that was simply absent.
      intent: {
        id: "in-x", title: "t", status: "ready", budgetUsd: 10, tier: "reversible",
        delivers: [], renders: [], dependsOn: [], evidence: [], body: "b",
      },
      arenaDir: dir,
      logPath: join(dir, "x.log"),
      agentDefinitionPath: join(dir, "law.md"),
      planJudgeAgentPath: join(dir, "judge-law.md"),
      budgetUsd: 10,
      slices: [],
    });

    expect(prompt).toContain("Defects already recorded against this code");
    expect(prompt).toContain("across realms");
  });

  it("a pass that judges nothing is not a pass", async () => {
    // The gate only inspected the entries that happened to be present, so an empty list
    // cleared it and every draft was promoted to `ready`. It failed open exactly when the
    // judge's output was least trustworthy.
    const dir = arena("empty-verdict");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
    }, { verdict: "pass", intents: [], coverage_check: "x", nothing_dropped: "all slices taken" })));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.problems.join(" ")).toMatch(/reported no result for this intent/);
  });

  it("a pass that skips one of the minted intents is not a pass", async () => {
    // The dangerous shape: the verdict looks well-formed and cites properly, but says
    // nothing at all about the second intent — which is promoted anyway.
    const dir = arena("partial-verdict");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
      "work/intents/in-2026-09-05-second.md": INTENT("in-2026-09-05-second"),
    }, {
      verdict: "pass",
      intents: [{ id: "in-2026-09-05-skeleton", ok: true, cite: "PRD §1", problems: [] }],
      coverage_check: "x", nothing_dropped: "all slices taken",
    })));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.problems.join(" ")).toMatch(/in-2026-09-05-second.*reported no result/);
  });

  it("a pass whose own entry says not ok is not a pass", async () => {
    // Internally contradictory, and it used to win: the top-level word beat the entry.
    const dir = arena("contradictory-verdict");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
    }, {
      verdict: "pass",
      intents: [{ id: "in-2026-09-05-skeleton", ok: false, cite: "PRD §1", problems: ["invents scope"] }],
      coverage_check: "x", nothing_dropped: "all slices taken",
    })));

    // This one IS a finding, and the change is deliberate. A verdict that says pass while
    // an entry is not ok is not a contradiction to resolve — it is a judge that found
    // something and rounded it off, so the entry is taken as authoritative and its reason
    // goes to the correction pass. No pass was supplied here, so the free re-check refuses.
    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(fixerPrompts[0]!).toContain("invents scope");
  });

  it("a pass whose entry omits `ok` entirely is not a pass either", () => {
    // `ok === false` only catches the literal. The verdict is unvalidated external JSON cast
    // to a type, so a missing or null `ok` is not an affirmation — and checking for the
    // literal let every malformed entry promote a draft: the same failing-open shape, one
    // field deeper.
    return (async () => {
      const dir = arena("missing-ok");
      const out = await runProgramDecompose(ctx(dir, agents(dir, {
        "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
      }, {
        verdict: "pass",
        intents: [{ id: "in-2026-09-05-skeleton", cite: "PRD §1", problems: [] }],
        coverage_check: "x", nothing_dropped: "all slices taken",
      })));
      // Not ok, and no reason given. That is NOT a finding: a correction pass cannot act
      // on "something is wrong" with nothing named, and any unrelated byte it changed
      // would then satisfy the "changed something" guard, leaving the original defect to
      // be promoted to `ready`. So it fails the RUN and the engine buys another judge.
      //
      // `ok === false` only catches the literal. The verdict is unvalidated external JSON
      // cast to a type, so a missing or null `ok` is not an affirmation either.
      expect(out.kind).toBe("failed");
      if (out.kind !== "failed") return;
      expect(out.problems.join(" ")).toContain("a finding that names nothing cannot be acted on");
      expect(fixerPrompts).toHaveLength(0);
    })();
  });

  it("a refusal that says nothing about any intent fails the RUN", async () => {
    // An explicit `verdict: "fail"` with no problem named anywhere. There is no finding
    // for a correction pass to act on, so publishing would mean acting on a refusal
    // nobody can answer — and the pass would "correct" nothing while the guard that
    // catches a no-op is satisfied by any stray byte.
    const dir = arena("empty-refusal");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
    }, {
      verdict: "fail",
      intents: [{ id: "in-2026-09-05-skeleton", ok: true, cite: "PRD §1", problems: [] }],
      coverage_check: "x", nothing_dropped: "all slices taken",
    })));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.problems.join(" ")).toMatch(/without saying what is wrong/);
    expect(fixerPrompts).toHaveLength(0);
  });

  it("a pass about an intent nobody minted is not a pass", async () => {
    // A judge answering about something else has not judged what was written.
    const dir = arena("phantom-verdict");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
    }, {
      verdict: "pass",
      intents: [{ id: "in-2026-09-05-ghost", ok: true, cite: "PRD §1", problems: [] }],
      coverage_check: "x", nothing_dropped: "all slices taken",
    })));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.problems.join(" ")).toMatch(/no such intent was minted/);
  });

  it("an id that already exists in the program is refused", async () => {
    const dir = arena("dupe");
    const existing = [{
      id: "in-2026-09-05-skeleton", title: "A slice", status: "done" as const,
      budgetUsd: 40, tier: "reversible" as const, evidence: [], delivers: [], renders: [], dependsOn: [], body: "",
    }];
    const out = await runProgramDecompose({
      ...ctx(dir, agents(dir, { "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton") }, PASS)),
      existing,
    });
    // A finding now: re-minting an id is the most expensive failure available here, and
    // it is also the easiest thing to correct. No pass was supplied, so the free
    // re-check refuses.
    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(fixerPrompts[0]!).toMatch(/already exists/);
  });

  it("REGRESSION: a MODIFIED tracked file is caught, not just a newly created one", async () => {
    // The guard above this one had a hole from the beginning, and every existing test
    // missed it because they all wrote NEW files.
    //
    // `git()` trims its whole output, which eats the leading space of porcelain's first
    // line — so a modified tracked file sorting first arrives as `M docs/program/PRD.md`
    // rather than ` M docs/program/PRD.md`. Against the old `/^..\s+/` the two dots ate
    // "M" and the space, leaving `\s+` to match the `d` of `docs`; it did not, the line
    // was skipped, and the modification was invisible. An ACT could edit the PRD, the
    // ARCH, its own feature or `context/contracts.md` — the one-way doors this check
    // exists for — and be reported as having touched nothing.
    //
    // `decompose.ts` parses by pattern and says why. Same rule, two implementations, one
    // fix. Found by a test written for the correction pass; it was never about the pass.
    const dir = arena("modifies-prd");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-ok.md": INTENT("in-2026-09-05-ok"),
      // Sorts before `work/`, so it is porcelain's FIRST line — which is the only
      // position the bug was reachable from.
      "docs/program/PRD.md": "# PRD\nQuietly rewritten by the ACT.\n",
    }, PASS)));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toMatch(/outside work\/intents\//);
    expect(out.problems.join(" ")).toContain("docs/program/PRD.md");
    expect(gitIn(dir, ["status", "--porcelain", "-uall", "--", "work", "src", "docs"])).toBe("");
  });

  it("the correction pass may not touch anything outside work/intents/", async () => {
    // It writes in the REPOSITORY, as the planner does, and it has a motive the planner
    // does not: a finding says these intents disagree with their feature, and editing the
    // FEATURE resolves it just as well. `docs/program/**` is outside `work/intents/`, so
    // `changedFiles` already names it — this asserts the check is actually consulted
    // after the fix and not only after the plan.
    const dir = arena("fix-touches-docs");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
    }, { ...PASS, intents: [{ id: "in-2026-09-05-skeleton", ok: false, cite: "PRD §1", problems: ["invents a reporting screen"] }] }, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton").replace("The brief.", "corrected"),
      "docs/program/PRD.md": "# a PRD that now agrees with the intent\n",
    })));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toMatch(/correction pass touched files outside work\/intents\//);
    // Reverted, not merely reported.
    expect(gitIn(dir, ["status", "--porcelain", "-uall", "--", "work", "src", "docs"])).toBe("");
  });

  it("the correction pass may not soften the objections standing against its own drafts", async () => {
    // The same motive the PLANNER has on this rung, and the same blind spot: `changedFiles`
    // skips `.doctrine/` as engine-owned runtime state, so nothing above would have caught
    // it, and the edit would have survived into the next tick as genuine. The planner was
    // given this guard after review on doctrine#21; the correction pass was added without
    // it, which is the sibling divergence this whole change is about.
    const dir = arena("fix-tampers");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
    }, { ...PASS, intents: [{ id: "in-2026-09-05-skeleton", ok: false, cite: "PRD §1", problems: ["invents a reporting screen"] }] }, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton").replace("The brief.", "corrected"),
      ".doctrine/ticks.jsonl": "",
    })));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toMatch(/correction pass modified engine-owned state/);
  });

  it("the correction pass may not change WHICH intents exist", async () => {
    // The silent false success. The re-reads after the fix are BY NAME, so a pass that
    // writes a fourth intent and leaves the three alone would re-check clean and publish,
    // reporting every finding as addressed. Nothing downstream could tell it from real
    // work — which makes it worse than any refusal.
    const dir = arena("fix-adds-intent");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
    }, { ...PASS, intents: [{ id: "in-2026-09-05-skeleton", ok: false, cite: "PRD §1", problems: ["invents a reporting screen"] }] }, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton").replace("The brief.", "corrected"),
      "work/intents/in-2026-09-05-extra.md": INTENT("in-2026-09-05-extra"),
    })));

    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toContain("changed WHICH intents exist");
    expect(gitIn(dir, ["status", "--porcelain", "-uall", "--", "work", "src", "docs"])).toBe("");
  });

  it("a correction pass that changed NOTHING is refused, with the findings named", async () => {
    // Byte-identical with findings outstanding. Publishing would report every one of them
    // as addressed when none was — and unlike a mechanical finding, a judge's finding has
    // nothing free to re-check it with, so this comparison is the only thing between an
    // ignored finding and a promoted intent.
    const dir = arena("fix-noop");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
    }, { ...PASS, intents: [{ id: "in-2026-09-05-skeleton", ok: false, cite: "PRD §1", problems: ["invents a reporting screen"] }] }, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
    })));

    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toContain("changed nothing");
    expect(out.problems.join(" ")).toContain("invents a reporting screen");
    // And the draft is shelved, so the next planner revises rather than re-invents.
    expect(readFileSync(join(dir, ".doctrine", "rejected", "in-2026-09-05-skeleton.md"), "utf8")).toContain("The brief.");
  });

  it("the judge is never asked twice — the cost of a plan is bounded", async () => {
    // The property the whole change is for. Under the old shape a refusal shelved the
    // drafts and the next tick paid a PLANNER to answer the same question again, bounded
    // only by the three-consecutive-failure halt, which stops the whole loop rather than
    // finishing this plan. Exactly one judge spawn per run, findings or no findings.
    const dir = arena("judged-once");
    let judgeSpawns = 0;
    const inner = agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
    }, { ...PASS, intents: [{ id: "in-2026-09-05-skeleton", ok: false, cite: "PRD §1", problems: ["invents a reporting screen"] }] }, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton").replace("The brief.", "corrected"),
    });
    const out = await runProgramDecompose(ctx(dir, async (prompt, opts) => {
      if (prompt.includes("Write your verdict to EXACTLY:")) judgeSpawns += 1;
      return inner(prompt, opts);
    }));

    expect(out.kind).toBe("minted");
    if (out.kind !== "minted") return;
    expect(out.findingsFixed).toBe(1);
    expect(judgeSpawns).toBe(1);
    expect(fixerPrompts).toHaveLength(1);
    // Three spawns billed: plan $0.50, judge $0.20, correct $0.30. A pass billed at
    // nothing is a pass that spends outside every budget, which this rung has already
    // been caught doing once.
    expect(out.spendUsd).toBeCloseTo(1.0, 5);
  });

  it("a judge that cannot RUN is a failure, never a rejection", async () => {
    // Both used to return the same wrapper string, so a prefix check on it accepted
    // "program-judge rejected the intents: program-judge timed-out" and handed a fact
    // about the harness to the planner as an objection (doctrine#16 review).
    const dir = arena("judge-broke");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
    }, "not json at all")));
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.problems.join(" ")).toMatch(/not JSON/);
  });

  it("no intents written is an honest empty frontier, not a failure", async () => {
    const dir = arena("empty");
    const out = await runProgramDecompose(ctx(dir, agents(dir, {}, PASS)));
    expect(out.kind).toBe("empty");
  });
});

/**
 * The rung's integration, which is where all five of doctrine#13's findings were: the
 * module was fine and the wiring was not. Every case here is a way the loop could
 * quietly spend money forever, or quietly stop minting forever.
 */
describe("the program rung in the tick — spend, settling, retries and steering", () => {
  const makeDeps = (dir: string, runAgent: TickDeps["runAgent"]): TickDeps => ({
    arenaDir: dir,
    agentDefs: {
      implementer: join(dir, "law.md"), judge: join(dir, "judge-law.md"),
      decomposer: join(dir, "law.md"), planJudge: join(dir, "judge-law.md"),
      programDecomposer: join(dir, "law.md"), programJudge: join(dir, "judge-law.md"),
      intentFixer: join(dir, "fixer-law.md"),
    },
    ...(runAgent !== undefined ? { runAgent } : {}),
  });

  function programArena(name: string): string {
    const dir = arena(name);
    mkdirSync(join(dir, ".doctrine"), { recursive: true });
    writeFileSync(join(dir, ".doctrine", "manifest.json"), JSON.stringify({
      name: "t", base_branch: "development",
      program: { prd: "docs/program/PRD.md", arch: "docs/program/ARCH.md" },
    }));
    // A COMPLETE NARROWING CHAIN, because there is one path and it runs through one.
    // These tests are about the intent rung's spend, settling and retry behaviour, and it
    // is only reachable once the chain above it is satisfied: a PRD with identified
    // criteria, an epic covering them, a feature covering the epic, and an active brief
    // for the intent ACT to read. Before the chain existed these arenas minted intents
    // straight from the PRD, which is the route the engine no longer takes.
    mkdirSync(join(dir, "docs", "program", "epics"), { recursive: true });
    mkdirSync(join(dir, "docs", "program", "features"), { recursive: true });
    mkdirSync(join(dir, "docs", "program", "briefs"), { recursive: true });
    writeFileSync(
      join(dir, "docs", "program", "PRD.md"),
      ["# PRD", "", "### C1. Billing", "", "- **machine** `C1.1` The app bills hours.", ""].join(LF),
    );
    writeFileSync(join(dir, "docs", "program", "ARCH.md"), "# ARCH" + LF);
    writeFileSync(
      join(dir, "docs", "program", "epics", "ep-billing.md"),
      // The epic carries its feature: `ft-billing` is a heading in here, not a document.
      ["---", "id: ep-billing", "level: epic", "title: Billing", "status: active", "delivers: [C1.1]", "---",
        "the slice", "", "### Feature 1.1: Billing", "",
        "- **Delivers:** C1.1", "- **Renders:** (none)", "- **Depends on:** (none)", "- **Acceptance:** (none)", ""].join(LF),
    );
    writeFileSync(
      join(dir, "docs", "program", "features", "ep-billing.md"),
      ["---", "id: ft-billing", "level: feature", "parent: ep-billing", "title: Billing", "status: active", "delivers: [C1.1]", "---", "the slice", ""].join(LF),
    );
    writeFileSync(
      join(dir, "docs", "program", "briefs", "01-skeleton.md"),
      ["---", "step: 1", "title: Skeleton", "status: active", "---", "the step", ""].join(LF),
    );
    // ...and the set reviews that chain has already passed. These tests are about the
    // INTENT rung, which sits below the set rung: a complete epic level and a complete
    // feature set are each owed a coherence review the moment they complete, so without
    // these the first two ticks of every arena here would be reviews rather than the
    // behaviour under test. A real arena that has reached the intent rung has them.
    {
      const store = new FileNarrowingStore(dir);
      const criteria = parseCriteria(readFileSync(join(dir, "docs", "program", "PRD.md"), "utf8"));
      const epics = store.load("epic").narrowings;
      const feats = store.load("feature").narrowings;
      const reviewed = { ok: true as const, findings: [], spendUsd: 0 };
      writeSetReport(dir, reviewEpicSet(criteria, epics), reviewed);
    }

    // Committed, not merely written: `changedFiles` skips `.doctrine/` but not `docs/`,
    // so uncommitted program documents read as the ACT touching a forbidden path.
    gitIn(dir, ["add", "-A"]);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "program docs"], { cwd: dir });
    return dir;
  }

  it("a refused narrowing's objections reach the retry — the lookup matches the new names", async () => {
    // Caught by grep, not by a test: the lookup still matched `brief-rejected`, a decision
    // the engine had stopped emitting, so every narrowing retry would have run blind. That
    // is the single most expensive failure shape this repo has recorded — a retry that is
    // a second attempt at the same attempt rather than at the problem.
    const dir = programArena("narrowing-retry");
    appendFileSync(
      join(dir, ".doctrine", "ticks.jsonl"),
      JSON.stringify({ decision: "feature-rejected", problems: ["quotes-are-real: 'tie-out' is not in ep-billing"] }) + LF,
    );
    expect(priorNarrowingRejectionForTest(dir)).toContain("tie-out");
  });

  it("REGRESSION: a parked DECOMPOSED intent must not hold the program frontier shut", async () => {
    // Observed live on a target: the loop idled for an hour with an entire
    // program unbuilt. One intent was `decomposed`, all its units merged, its grade failed
    // and its gap decomposer honestly had nothing to add — it was blocked on a table a
    // sibling slice owes it. `openIntent` counted every `decomposed` intent as open, so
    // rung 3a never ran, so the slice that would unblock it could never be planned.
    //
    // The comment above `openIntent` described exactly this deadlock and had fixed it for
    // `ready` only. In flight is the test, not status.
    const dir = programArena("parked-decomposed");
    writeFileSync(
      join(dir, "work", "intents", "in-blocked.md"),
      ["---", "id: in-blocked", "level: intent", "title: t", "parent: ep-billing#1.1",
       "status: decomposed", "budget_usd: 20", "tier_default: reversible", "delivers: [C1.1]",
       "acceptance:", "  - kind: command", '    run: "exit 1"', '    expect: "never"',
       "---", "blocked on a sibling slice", ""].join(LF),
    );
    writeFileSync(
      join(dir, "work", "wu-done.md"),
      ["---", "id: wu-done", "title: t", "intent: in-blocked", "tier: reversible",
       "status: merged", "budget_usd: 5", "evidence:", "  - kind: command",
       '    run: "true"', '    expect: "ok"', "---", "b", ""].join(LF),
    );
    gitIn(dir, ["add", "-A"]);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "an intent with nothing of its own in flight"], { cwd: dir });

    const emptyGap: TickDeps["runAgent"] = async () => ok();

    // Tick one grades it and settles it: from here it is parked, not working.
    expect((await tick(makeDeps(dir, emptyGap))).decision).toBe("intent-graded-fail+gap-empty");

    // Tick two must REACH a rung that could unblock it. Before the fix this was `idle`,
    // every tick, on a frontier only that rung could move.
    const second = await tick(makeDeps(dir, emptyGap));
    expect(second.decision, "a parked intent is not work in progress").not.toBe("idle");
  });

  it("the chain runs before the intent rung: no epics means an epic is minted, not an intent", async () => {
    // The ordering the whole layer exists for. An intent is cut from a feature, a feature
    // from an epic, an epic from the program — and nothing below a level starts until
    // that level is complete, because a feature cut from a half-drawn epic layer is cut
    // from boundaries that then move underneath it.
    const dir = programArena("chain-first");
    rmSync(join(dir, "docs", "program", "epics", "ep-billing.md"));
    rmSync(join(dir, "docs", "program", "features", "ep-billing.md"));
    gitIn(dir, ["add", "-A"]);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "drop the chain"], { cwd: dir });

    let sawIntentAct = false;
    const deps = {
      ...makeDeps(dir, async (prompt: string, opts: { cwd: string; logPath: string }) => {
        if (prompt.includes("work/intents")) sawIntentAct = true;
        writeFileSync(opts.logPath, "");
        const m = /Write your verdict JSON to EXACTLY: (.+)/.exec(prompt);
        if (m) {
          writeFileSync(m[1]!.trim(), JSON.stringify({
            verdict: "pass",
            checks: ["quotes-are-real", "nothing-invented", "nothing-binding-missing", "right-size", "points-not-copies", "dependencies-declared"]
              .map((check) => ({ check, ok: true, cite: "x" })),
            problems: [],
          }));
          return ok(0.2);
        }
        // Into the ACT's OWN working directory — a scratch dir. Writing into the arena
        // now trips the containment tripwire, which is the point of the change.
        writeFileSync(
          join(opts.cwd, "ep-new.md"),
          // An epic carries its features — `parseFeatures` refuses one that declares none.
          ["---", "id: ep-new", "level: epic", "title: Billing", "status: active", "delivers: [C1.1]", "---",
            "the slice", "", "### Feature 1.1: the whole slice", "",
            "- **Delivers:** C1.1", "- **Renders:** (none)", "- **Depends on:** (none)", "- **Acceptance:** (none)", ""].join(LF),
        );
        // And the units under that feature, in the same ACT (ADR-0006). An epic that
        // scaffolds nothing is refused.
        mkdirSync(join(opts.cwd, "work"), { recursive: true });
        writeFileSync(
          join(opts.cwd, "work", "wu-billing.md"),
          ["---", "id: wu-billing", "title: Billing", "tier: reversible", "budget_usd: 12",
            "status: scaffold", "parent: ep-new#1.1", "delivers: [C1.1]", "renders: []",
            "depends_on: []", "---", "## Intent", "", "Because billing does not exist.", ""].join(LF),
        );
        return ok();
      }),
    } as TickDeps;
    (deps.agentDefs as Record<string, string>)["narrowingDecomposer"] = join(dir, "law.md");
    (deps.agentDefs as Record<string, string>)["narrowingJudge"] = join(dir, "judge-law.md");
    (deps.agentDefs as Record<string, string>)["narrowingFixer"] = join(dir, "fixer-law.md");

    const out = await tick(deps);
    expect(out.decision).toBe("epic-minted");
    expect(sawIntentAct).toBe(false);
  }, 60_000);

  it("an empty plan settles at its commit, and the frontier moves on to the next intent", async () => {
    // `decompose-empty` left the intent `ready`, so the next tick's
    // `intents.find(i => i.status === "ready")` picked the same one, paid the same ~$2,
    // and got the same honest empty plan — forever. The failure halt could not see it:
    // an empty plan is not a failure, so nothing counted it. Busy, expensive, producing
    // nothing, with every backstop blind. Caught live on a target, one tick after it
    // started, when a frontier of two intents handed the loop the DEPENDENT one first —
    // an invoice push that needs a walking skeleton's modules to exist.
    const dir = programArena("empty-settles");
    for (const id of ["in-2026-09-05-aaa-dependent", "in-2026-09-05-zzz-skeleton"]) {
      writeFileSync(join(dir, "work", "intents", `${id}.md`), INTENT(id, "ready"));
    }
    gitIn(dir, ["add", "-A"]);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "two ready intents"], { cwd: dir });

    // A decomposer that writes no units: an honest empty plan, whichever it is asked for.
    const asked: string[] = [];
    const emptyPlan: TickDeps["runAgent"] = async (prompt) => {
      const m = /in-2026-09-05-[a-z-]+/.exec(prompt);
      if (m) asked.push(m[0]);
      return ok();
    };

    expect((await tick(makeDeps(dir, emptyPlan))).decision).toBe("decompose-empty");
    expect((await tick(makeDeps(dir, emptyPlan))).decision).toBe("decompose-empty");

    // Two different intents, not the same one twice. That is the whole fix.
    expect(new Set(asked).size).toBe(2);
    expect(asked[0]).toBe("in-2026-09-05-aaa-dependent");

    // Both settled at this commit, so the rung stops asking — and, crucially, the tick
    // falls THROUGH to the program rung rather than idling. Counting a settled intent
    // as open work turned this fix into a quieter deadlock than the spin it replaced:
    // rung 2 selects nothing, rung 4 sees work in progress and stands down, and the
    // loop idles forever on a frontier only rung 4 could have moved (doctrine#24
    // review).
    const third = await tick(makeDeps(dir, emptyPlan));
    expect(third.decision).not.toBe("decompose-empty");
    expect(third.decision).not.toBe("idle");
    // It reaches the work-CREATING half of the ladder, which is now the narrowing chain
    // rather than the intent rung alone. Here the chain reports `chain-complete`, because
    // this fixture's one feature is served by the two intents on disk. Either is the
    // property under test; idling is not.
    expect(third.decision === "chain-complete" || third.decision.startsWith("program-")).toBe(true);

    // Until something lands. A moved HEAD is a different question, so both are asked again.
    writeFileSync(join(dir, "app.txt"), "the skeleton landed\n");
    gitIn(dir, ["add", "-A"]);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "work landed"], { cwd: dir });
    expect((await tick(makeDeps(dir, emptyPlan))).decision).toBe("decompose-empty");
  }, 60_000);

  it("a decomposer cannot pre-settle the intents it does not want to be asked about", async () => {
    // The quietest of the tampering routes: writing `intents-settled.json` with other
    // intent ids at the current HEAD marks them already answered, and they are simply
    // never asked again. No rejected diff, no failed unit — an unasked question rather
    // than a wrong answer. The decompose rung skips `.doctrine/` when deciding what an
    // ACT touched and when reverting, so nothing else would have caught it.
    const dir = programArena("presettle");
    for (const id of ["in-2026-09-05-aaa-first", "in-2026-09-05-zzz-second"]) {
      writeFileSync(join(dir, "work", "intents", `${id}.md`), INTENT(id, "ready"));
    }
    gitIn(dir, ["add", "-A"]);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "two ready intents"], { cwd: dir });
    const head = gitIn(dir, ["rev-parse", "HEAD"]);

    const settling: TickDeps["runAgent"] = async () => {
      writeFileSync(
        join(dir, ".doctrine", "intents-settled.json"),
        JSON.stringify({ "in-2026-09-05-zzz-second": head }, null, 2),
      );
      return ok();
    };
    const out = await tick(makeDeps(dir, settling));
    expect(out.decision).toBe("decompose-failed");
    expect(out.detail).toContain("modified engine-owned state");
    expect(out.detail).toContain("intents-settled.json");

    // And the file it wrote is gone, so the second intent is still going to be asked.
    expect(existsSync(join(dir, ".doctrine", "intents-settled.json"))).toBe(false);
  }, 60_000);

  it("program spend reaches metrics.jsonl, where the daily gate actually reads", async () => {
    // appendTick alone left every program ACT outside dailySpendUsd — the rung could
    // have spent without limit while the gate reported zero.
    const dir = programArena("spend");
    await tick(makeDeps(dir, agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
    }, PASS)));
    const metrics = readFileSync(join(dir, ".doctrine", "metrics.jsonl"), "utf8");
    expect(metrics).toContain('"type":"decompose"');
    expect(metrics).toContain('"intent":"program"');
    expect(JSON.parse(metrics.trim().split("\n").at(-1)!).spend_usd).toBeGreaterThan(0);
  }, 60_000);

  it("an empty answer settles at its commit instead of being re-asked every tick", async () => {
    // The arena's one feature delivers C1.1 and the ACT mints nothing, so the planner is
    // saying it has nothing to add while its own feature's criterion reaches no intent.
    // That is a CONTRADICTION and the decision says so — it used to flip the feature done
    // and drop the criterion silently. Either way the property under test is the same:
    // one ACT, and the next tick at the same HEAD buys nothing.
    const dir = programArena("settles");
    const noop = agents(dir, {}, PASS);
    let calls = 0;
    const counting: TickDeps["runAgent"] = async (prompt, opts) => { calls += 1; return noop(prompt, opts); };

    expect((await tick(makeDeps(dir, counting))).decision).toBe("feature-incomplete");
    expect(calls).toBe(1);
    // Second tick at the same HEAD: no ACT, no spend. The property under test is the
    // spend, not the label — `calls` is still 1.
    //
    // Settled at HEAD, so the same contradiction is not bought again every idle interval.
    // It clears itself the moment anything lands, because a moved HEAD is a different
    // question.
    expect((await tick(makeDeps(dir, counting))).decision).not.toBe("feature-incomplete");
    expect(calls).toBe(1);
  }, 60_000);

  it("a parked unit does not block the frontier forever", async () => {
    // Every status but `merged` counted as open, so one escalated unit stopped the
    // program rung permanently — the opposite of park-and-move-on.
    const dir = programArena("escalated");
    writeFileSync(join(dir, "work", "wu-stuck.md"), `---\nid: wu-stuck\ntitle: Stuck\ntier: reversible\nstatus: escalated\nbudget_usd: 5\nevidence:\n  - kind: command\n    run: "true"\n    expect: "exit 0"\n---\nParked.\n`);
    gitIn(dir, ["add", "-A"]);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "park"], { cwd: dir });

    const out = await tick(makeDeps(dir, agents(dir, {
      "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton"),
    }, PASS)));
    expect(out.decision).toBe("program-minted");
  }, 60_000);

  it("intake_mode: manual turns the rung off — minting intents IS intake", async () => {
    const dir = programArena("manual");
    writeFileSync(join(dir, ".doctrine", "directives.md"), "---\nintake_mode: manual\n---\nobserver holds intake\n");
    let calls = 0;
    const counting: TickDeps["runAgent"] = async () => { calls += 1; return ok(); };
    expect((await tick(makeDeps(dir, counting))).decision).toBe("idle");
    expect(calls).toBe(0);
  }, 60_000);

  it("a rejection survives an unrelated failure that lands after it", async () => {
    // Scanning backward used to stop at the first program-failed of any kind, so a
    // timeout after a rejection threw the live objection away and the next attempt
    // re-minted exactly what had been refused (doctrine#16 review).
    const dir = programArena("rejection-survives");
    const REJECT = {
      verdict: "fail",
      intents: [{ id: "in-2026-09-05-invented", ok: false, cite: "", problems: ["invented a reporting feature"] }],
      coverage_check: "grepped", nothing_dropped: "all slices taken",
    };
    const files = { "work/intents/in-2026-09-05-invented.md": INTENT("in-2026-09-05-invented") };
    expect((await tick(makeDeps(dir, agents(dir, files, REJECT)))).decision).toBe("program-rejected");

    // Now an infrastructure failure: the decomposer writes something unparseable.
    const broken = { "work/intents/in-2026-09-05-invented.md": "not an intent at all" };
    expect((await tick(makeDeps(dir, agents(dir, broken, REJECT)))).decision).toBe("program-failed");

    // The rejection is still the newest thing that said anything about the PLAN.
    let sawRejection = false;
    const third: TickDeps["runAgent"] = async (prompt, opts) => {
      if (!prompt.includes("Write your verdict to EXACTLY:")) {
        sawRejection = prompt.includes("invented a reporting feature");
      }
      return agents(dir, files, REJECT)(prompt, opts);
    };
    await tick(makeDeps(dir, third));
    expect(sawRejection).toBe(true);
  }, 60_000);

  it("a rejection is fed back, so the retry does not re-mint the same intents", async () => {
    const dir = programArena("retry");
    const REJECT = {
      verdict: "fail",
      intents: [{ id: "in-2026-09-05-invented", ok: false, cite: "", problems: ["invented a reporting feature"] }],
      coverage_check: "grepped", nothing_dropped: "all slices taken",
    };
    const files = { "work/intents/in-2026-09-05-invented.md": INTENT("in-2026-09-05-invented") };
    expect((await tick(makeDeps(dir, agents(dir, files, REJECT)))).decision).toBe("program-rejected");

    // The revert restores the repo exactly, so without the rejection in the prompt the
    // planner has nothing to distinguish this run from the last one.
    let sawRejection = false;
    const second: TickDeps["runAgent"] = async (prompt, opts) => {
      if (!prompt.includes("Write your verdict to EXACTLY:")) {
        sawRejection = prompt.includes("invented a reporting feature");
      }
      return agents(dir, files, REJECT)(prompt, opts);
    };
    await tick(makeDeps(dir, second));
    expect(sawRejection).toBe(true);
  }, 60_000);

  it("feeds back EVERY objection, not the first few hundred characters of them", async () => {
    // The tick ledger's `detail` is a summary, clipped so a person and a monitor can
    // read it. Reading the objections back out of it handed the planner one of four,
    // cut mid-sentence: it fixed the one it could see and tripped over the three it
    // could not, twice, at ~$9 an attempt. Reasons a later tick must act on travel in
    // `problems`, in full.
    const dir = programArena("every-objection");
    const filler = "x".repeat(500);
    const REJECT = {
      verdict: "fail",
      intents: [{
        id: "in-2026-09-05-invented",
        ok: false,
        cite: "",
        problems: [
          `FIRST-OBJECTION ${filler}`,
          `SECOND-OBJECTION ${filler}`,
          `THIRD-OBJECTION ${filler}`,
          "FOURTH-OBJECTION `paid` is claimed in scope and graded by nothing",
        ],
      }],
      coverage_check: "grepped", nothing_dropped: "all slices taken",
    };
    const files = { "work/intents/in-2026-09-05-invented.md": INTENT("in-2026-09-05-invented") };
    expect((await tick(makeDeps(dir, agents(dir, files, REJECT)))).decision).toBe("program-rejected");

    let seen = "";
    const second: TickDeps["runAgent"] = async (prompt, opts) => {
      // The PLANNER's prompt specifically. There are three ACTs on this rung now, and
      // matching "not the judge" caught the correction pass, which runs last.
      if (prompt.includes("# The program")) seen = prompt;
      return agents(dir, files, REJECT)(prompt, opts);
    };
    await tick(makeDeps(dir, second));
    for (const marker of ["FIRST-OBJECTION", "SECOND-OBJECTION", "THIRD-OBJECTION", "FOURTH-OBJECTION"]) {
      expect(seen).toContain(marker);
    }
  }, 60_000);

  it("shelves the refused draft so the retry revises it instead of starting over", async () => {
    // The revert wipes work/intents/ — correctly, a refused intent must never look like
    // real work — but that left the next attempt holding a critique of a document that
    // existed nowhere. It did the only thing it could: wrote a NEW intent, with new
    // holes. Two attempts, ~$17, not one shared paragraph. Revision needs the draft.
    const dir = programArena("shelved-draft");
    const body = "MARKER-OF-THE-REFUSED-DRAFT: bills hours through to a sent invoice.";
    const draft = INTENT("in-2026-09-05-invented").replace("The brief.", body);
    const REJECT = {
      verdict: "fail",
      intents: [{ id: "in-2026-09-05-invented", ok: false, cite: "", problems: ["`paid` is graded by nothing"] }],
      coverage_check: "grepped", nothing_dropped: "all slices taken",
    };
    const files = { "work/intents/in-2026-09-05-invented.md": draft };
    expect((await tick(makeDeps(dir, agents(dir, files, REJECT)))).decision).toBe("program-rejected");

    // Shelved, and COMMITTED: a shelf that only survives while this process lives is a
    // memory, not state — a fresh clone would silently go back to starting over.
    expect(readFileSync(join(dir, ".doctrine", "rejected", "in-2026-09-05-invented.md"), "utf8")).toContain(body);
    expect(gitIn(dir, ["status", "--porcelain", ".doctrine/rejected"])).toBe("");
    // And the frontier is still clean, so the decompose rung cannot pick it up.
    expect(existsSync(join(dir, "work", "intents", "in-2026-09-05-invented.md"))).toBe(false);

    let seen = "";
    const second: TickDeps["runAgent"] = async (prompt, opts) => {
      // The PLANNER's prompt specifically. There are three ACTs on this rung now, and
      // matching "not the judge" caught the correction pass, which runs last.
      if (prompt.includes("# The program")) seen = prompt;
      return agents(dir, files, REJECT)(prompt, opts);
    };
    await tick(makeDeps(dir, second));
    expect(seen).toContain(body);
    expect(seen).toContain("`paid` is graded by nothing");
  }, 60_000);

  it("stands alone in a fresh clone — the shelf carries its own objections", async () => {
    // `.doctrine/ticks.jsonl` is not committed. A fresh clone or a `git clean -fdx`
    // keeps the shelf and loses the log, and requiring a ledger row meant the planner
    // was handed nothing at all while the refused draft sat right there on disk.
    const dir = programArena("shelf-stands-alone");
    const body = "MARKER-OF-THE-REFUSED-DRAFT: bills hours through to a sent invoice.";
    const draft = INTENT("in-2026-09-05-invented").replace("The brief.", body);
    const REJECT = {
      verdict: "fail",
      intents: [{ id: "in-2026-09-05-invented", ok: false, cite: "", problems: ["OBJECTION-ON-THE-SHELF: `paid` is graded by nothing"] }],
      coverage_check: "grepped", nothing_dropped: "all slices taken",
    };
    const files = { "work/intents/in-2026-09-05-invented.md": draft };
    expect((await tick(makeDeps(dir, agents(dir, files, REJECT)))).decision).toBe("program-rejected");

    // Simulate the clone: the committed shelf survives, the local ledger does not.
    rmSync(join(dir, ".doctrine", "ticks.jsonl"), { force: true });
    expect(readRejectedObjections(dir)).toContain("OBJECTION-ON-THE-SHELF");

    let seen = "";
    const second: TickDeps["runAgent"] = async (prompt, opts) => {
      // The PLANNER's prompt specifically. There are three ACTs on this rung now, and
      // matching "not the judge" caught the correction pass, which runs last.
      if (prompt.includes("# The program")) seen = prompt;
      return agents(dir, files, REJECT)(prompt, opts);
    };
    await tick(makeDeps(dir, second));
    expect(seen).toContain(body);
    expect(seen).toContain("OBJECTION-ON-THE-SHELF");
  }, 60_000);

  it("refuses a run that edited the shelf — the ACT cannot soften its own objections", async () => {
    // This is the ACT that READS the shelf, so it is the one with a motive. And it was
    // the one path nothing checked: the guardrail diff check runs on implementer and
    // review-fix branches, `changedFiles` skips `.doctrine/` as engine-owned runtime
    // state, and `revertAll` excludes that directory outright — so an edit here would
    // have survived a run that returned empty or failed, and been read as genuine on
    // the next attempt. Found in review on doctrine#21.
    const dir = programArena("shelf-tamper");
    const REJECT = {
      verdict: "fail",
      intents: [{ id: "in-2026-09-05-invented", ok: false, cite: "", problems: ["ORIGINAL-OBJECTION: `paid` is graded by nothing"] }],
      coverage_check: "grepped", nothing_dropped: "all slices taken",
    };
    const files = { "work/intents/in-2026-09-05-invented.md": INTENT("in-2026-09-05-invented") };
    expect((await tick(makeDeps(dir, agents(dir, files, REJECT)))).decision).toBe("program-rejected");
    const objections = join(dir, ".doctrine", "rejected", "objections.md");
    expect(readFileSync(objections, "utf8")).toContain("ORIGINAL-OBJECTION");

    // Next attempt: the ACT rewrites the case standing against it.
    const tampering: TickDeps["runAgent"] = async (prompt, opts) => {
      if (!prompt.includes("Write your verdict to EXACTLY:")) {
        writeFileSync(objections, "1. nothing was wrong with the plan, actually\n");
      }
      return agents(dir, files, REJECT)(prompt, opts);
    };
    const out = await tick(makeDeps(dir, tampering));
    expect(out.decision).toBe("program-failed");
    expect(out.detail).toContain("modified engine-owned state");

    // And the objection it tried to erase is intact, so the attempt after this one
    // still has to answer it.
    expect(readFileSync(objections, "utf8")).toContain("ORIGINAL-OBJECTION");
    expect(gitIn(dir, ["status", "--porcelain", ".doctrine/rejected"])).toBe("");
  }, 60_000);

  it("clears the shelf once something is accepted", async () => {
    // A spent objection that keeps arguing is worse than none: it is about a plan that
    // no longer exists.
    const dir = programArena("shelf-cleared");
    const REJECT = {
      verdict: "fail",
      intents: [{ id: "in-2026-09-05-invented", ok: false, cite: "", problems: ["invented a reporting feature"] }],
      coverage_check: "grepped", nothing_dropped: "all slices taken",
    };
    const bad = { "work/intents/in-2026-09-05-invented.md": INTENT("in-2026-09-05-invented") };
    expect((await tick(makeDeps(dir, agents(dir, bad, REJECT)))).decision).toBe("program-rejected");
    expect(existsSync(join(dir, ".doctrine", "rejected"))).toBe(true);

    const good = { "work/intents/in-2026-09-05-skeleton.md": INTENT("in-2026-09-05-skeleton") };
    expect((await tick(makeDeps(dir, agents(dir, good, PASS)))).decision).toBe("program-minted");
    expect(readRejectedDrafts(dir)).toBe("");
    // Cleared on disk AND committed. Left unstaged, the shelf comes back with the next
    // clone and argues about a plan that no longer exists.
    expect(gitIn(dir, ["status", "--porcelain", ".doctrine/rejected"])).toBe("");
    expect(gitIn(dir, ["ls-files", ".doctrine/rejected"])).toBe("");
  }, 60_000);
});
