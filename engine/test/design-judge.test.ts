import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assembleDesignJudgePrompt, designFailureDetail, designFailureSummary, runDesignJudge, validateDesignVerdict } from "../src/design-judge.js";
import { baselineState } from "../src/dispatch.js";
import type { DesignJudgeContext } from "../src/design-judge.js";
import type { SpawnRunResult } from "../src/spawn.js";
import { evaluateDesignCatch } from "../src/design-canary.js";
import type { DesignJudgeOutcome } from "../src/design-judge.js";

const finding = (over: Partial<{ screen: string; region: string; rule: string; observed: string; ok: boolean }> = {}) => ({
  screen: "ledger.png",
  region: "the three totals cards",
  rule: "spacing-off-scale",
  observed: "the middle card's left inset is a few pixels short of the others",
  ok: false,
  ...over,
});

const verdict = (over: Record<string, unknown> = {}) => ({
  verdict: "fail",
  screens: ["ledger.png"],
  findings: [finding()],
  gates_executed: ["screens-rendered", "screens-viewed"],
  ...over,
});

/**
 * The design-judge's verdict is the only thing it produces that counts, so the shape is
 * where its honesty is enforced. Every rule here exists because the corresponding
 * failure is one a plausible-sounding verdict could otherwise get away with.
 */
describe("design verdict — what makes it evidence rather than an opinion", () => {
  it("accepts a verdict that names screens, cites regions, and proves its gates", () => {
    const r = validateDesignVerdict(verdict());
    expect(r.ok).toBe(true);
  });

  it("rejects a finding with no region — cite the region or it did not happen", () => {
    const r = validateDesignVerdict(verdict({ findings: [finding({ region: "  " })] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toMatch(/region/);
  });

  it("rejects a finding that says what is wrong without saying what is there", () => {
    // `observed` is the discipline: say what you see before you say what is wrong with
    // it. A judgement with no observation is unfalsifiable.
    const r = validateDesignVerdict(verdict({ findings: [finding({ observed: "" })] }));
    expect(r.ok).toBe(false);
  });

  it("rejects a pass with no findings — that is a judge that did not look", () => {
    const r = validateDesignVerdict(verdict({ verdict: "pass", findings: [] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toMatch(/did not look/);
  });

  it("rejects a pass that carries a failing finding", () => {
    const r = validateDesignVerdict(verdict({ verdict: "pass", findings: [finding({ ok: false })] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toMatch(/dishonest by construction/);
  });

  it("rejects a verdict that opened no images", () => {
    const r = validateDesignVerdict(verdict({ screens: [] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toMatch(/did not look/);
  });

  it("rejects green-by-absence: both gates must be positively proved", () => {
    const r = validateDesignVerdict(verdict({ gates_executed: ["screens-rendered"] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toMatch(/screens-viewed/);
  });
});

const judged = (v: Record<string, unknown>): DesignJudgeOutcome => {
  const parsed = validateDesignVerdict(verdict(v));
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.errors.join("; ")}`);
  return { kind: "judged", verdict: parsed.verdict, spendUsd: 0.4, logPath: "" };
};

describe("design canary scoring — recall, and the control that keeps it honest", () => {
  it("counts a catch when the judge fails the screen and names the seeded rule", () => {
    const r = evaluateDesignCatch(judged({}), { verdict: "fail", must_flag: "spacing-off-scale", base: "abc" });
    expect(r.result).toBe("caught");
  });

  it("counts a catch when the judge describes the defect under another name", () => {
    // Scoring the rule string alone would measure vocabulary rather than sight: a judge
    // that says exactly what is wrong, in the right place, has seen it.
    const r = evaluateDesignCatch(
      judged({ findings: [finding({ rule: "uneven-padding", observed: "the cards' spacing-off-scale insets differ" })] }),
      { verdict: "fail", must_flag: "spacing-off-scale", base: "abc" },
    );
    expect(r.result).toBe("caught");
  });

  it("counts a catch when the judge spells the rule with spaces instead of hyphens", () => {
    const r = evaluateDesignCatch(
      judged({ findings: [finding({ rule: "ban-list: inconsistent state", observed: "the table takes a smaller corner than the cards" })] }),
      { verdict: "fail", must_flag: "inconsistent-state", base: "abc" },
    );
    expect(r.result).toBe("caught");
  });

  it("counts a miss when the screen fails for an unrelated reason", () => {
    const r = evaluateDesignCatch(
      judged({ findings: [finding({ rule: "emoji-as-iconography", observed: "an emoji sits in the heading" })] }),
      { verdict: "fail", must_flag: "spacing-off-scale", base: "abc" },
    );
    expect(r.result).toBe("missed");
    expect(r.detail).toMatch(/never named/);
  });

  it("counts a miss when the seeded defect passes", () => {
    const r = evaluateDesignCatch(
      judged({ verdict: "pass", findings: [finding({ ok: true, observed: "the cards are even" })] }),
      { verdict: "fail", must_flag: "spacing-off-scale", base: "abc" },
    );
    expect(r.result).toBe("missed");
  });

  it("counts a FALSE POSITIVE when the control is failed", () => {
    // Without the control a judge that fails everything scores perfect recall, and that
    // is the likelier failure here — "this could be better" is always available to say.
    const r = evaluateDesignCatch(judged({}), { verdict: "pass", base: "abc" });
    expect(r.result).toBe("false-positive");
  });

  it("a judge that could not run is an error, never a catch", () => {
    const r = evaluateDesignCatch(
      { kind: "failed", reason: "no-screens-head", errors: ["nothing rendered"], outage: false, spendUsd: 0, logPath: "" },
      { verdict: "fail", must_flag: "x", base: "abc" },
    );
    expect(r.result).toBe("error");
  });
});

const tmp = mkdtempSync(join(tmpdir(), "doctrine-djb-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * The bootstrap case: a target's FIRST UI unit.
 *
 * It is by definition the unit that registers the first screen, so its base worktree
 * has an empty register and the capture command renders nothing. Demanding images on
 * both sides made that unit impossible to pass — `no-screens`, branch reaped, and every
 * UI unit behind it blocked on a human seeding a baseline by hand, inside a loop whose
 * premise is that no human is in it. Found in review on doctrine#20.
 *
 * The relaxation is narrow on purpose. `baselineEmpty` is decided by the ENGINE running
 * the capture command in the base worktree; the judge is only told the answer. From
 * inside a verdict, "the baseline is legitimately empty" and "I skipped the baseline
 * render" look the same, and only one of them may open the gate.
 */
describe("the first UI unit — a change with no before", () => {
  let n = 0;
  function dirs(): { baseDir: string; headDir: string; out: string; verdictPath: string } {
    const root = join(tmp, `case-${n++}`);
    const headDir = join(root, "head");
    const baseDir = join(root, "base");
    mkdirSync(join(headDir, "shots"), { recursive: true });
    mkdirSync(join(baseDir), { recursive: true }); // base renders NOTHING
    writeFileSync(join(headDir, "shots", "billing.png"), "png");
    return { baseDir, headDir, out: "shots", verdictPath: join(root, "verdict.json") };
  }

  const ctx = (over: Partial<DesignJudgeContext> = {}): DesignJudgeContext => {
    const d = dirs();
    return {
      headDir: d.headDir,
      baseDir: d.baseDir,
      baselineEmpty: true,
      design: { contract: "DESIGN.md", screens: "npm run ui:screens", out: d.out },
      verdictPath: d.verdictPath,
      logPath: join(tmp, "log.txt"),
      budgetUsd: 3,
      agentDefinitionPath: join(tmp, "law.md"),
      ...over,
    } as DesignJudgeContext;
  };

  it("tells the judge there is no before, and to grade against the contract directly", () => {
    writeFileSync(join(tmp, "law.md"), "---\nname: dj\n---\ndesign law\n");
    const boot = assembleDesignJudgePrompt(ctx());
    expect(boot).toContain("registers the FIRST screens");
    expect(boot).toContain("There is no before");
    expect(boot).not.toContain("BEFORE and AFTER");

    const normal = assembleDesignJudgePrompt(ctx({ baselineEmpty: false }));
    expect(normal).toContain("BEFORE and AFTER");
    expect(normal).toContain("in BOTH worktrees");
  });

  it("accepts head-only images when the engine established the base is empty", async () => {
    writeFileSync(join(tmp, "law.md"), "---\nname: dj\n---\ndesign law\n");
    const c = ctx();
    const runAgent = async (): Promise<SpawnRunResult> => {
      writeFileSync(c.verdictPath, JSON.stringify(verdict({
        verdict: "pass",
        screens: ["billing.png"],
        findings: [finding({ screen: "billing.png", ok: true })],
      })));
      return {
        exitCode: 0, spawnFailed: false, signal: null, stdout: "", stderr: "",
        timedOut: false, outage: false, logPath: "",
        resultMessage: { type: "result", subtype: "success", total_cost_usd: 0.4 },
      } as unknown as SpawnRunResult;
    };
    const out = await runDesignJudge({ ...c, runAgent });
    expect(out.kind).not.toBe("failed");
  }, 30_000);

  it("still refuses head-only images when a baseline was expected", async () => {
    writeFileSync(join(tmp, "law.md"), "---\nname: dj\n---\ndesign law\n");
    const c = ctx({ baselineEmpty: false });
    const runAgent = async (): Promise<SpawnRunResult> => {
      writeFileSync(c.verdictPath, JSON.stringify(verdict({ verdict: "pass", findings: [finding({ ok: true })] })));
      return {
        exitCode: 0, spawnFailed: false, signal: null, stdout: "", stderr: "",
        timedOut: false, outage: false, logPath: "",
        resultMessage: { type: "result", subtype: "success", total_cost_usd: 0.4 },
      } as unknown as SpawnRunResult;
    };
    const out = await runDesignJudge({ ...c, runAgent });
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toBe("no-screens-base");
  }, 30_000);
});

/**
 * How the engine decides there is no baseline — and what it must not conclude.
 *
 * Both rules here are review findings on doctrine#22, and both are inversions rather
 * than omissions: each one, left alone, turns a gate into its opposite.
 */
describe("probing the base worktree", () => {
  let n = 0;
  function target(script: string): { dir: string; design: { contract: string; screens: string; out: string } } {
    const dir = join(tmp, `probe-${n++}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "capture.mjs"), script);
    return {
      dir,
      design: { contract: "DESIGN.md", screens: `node capture.mjs`, out: "shots" },
    };
  }

  it("calls it empty ONLY on the documented exit code, never on a capture that broke", () => {
    // Inferring "empty" from "no images appeared" cannot tell an empty register from a
    // browser that failed to launch — and reading a transient base failure as "this app
    // has never had screens" would grade a change to a mature UI absolutely, with the
    // real baseline never compared.
    const empty = target(`process.exit(3)`);
    expect(baselineState(empty.dir, empty.design)).toBe("empty");

    const broken = target(`console.error('chromium failed to launch'); process.exit(1)`);
    expect(baselineState(broken.dir, broken.design)).toBe("broken");

    const ok = target(`
      import { mkdirSync, writeFileSync } from 'node:fs';
      mkdirSync('shots', { recursive: true });
      writeFileSync('shots/billing.png', 'png');
    `);
    expect(baselineState(ok.dir, ok.design)).toBe("rendered");
  }, 30_000);

  it("leaves none of its own images behind for the judge's check to find", () => {
    // The probe writes into the very directory the validator inspects. Left there, a
    // judge that skipped its baseline render would pass the check that exists to catch
    // exactly that — the false positive rendering both sides was added to prevent,
    // arriving through the back door.
    const ok = target(`
      import { mkdirSync, writeFileSync } from 'node:fs';
      mkdirSync('shots', { recursive: true });
      writeFileSync('shots/billing.png', 'png');
    `);
    expect(baselineState(ok.dir, ok.design)).toBe("rendered");
    expect(existsSync(join(ok.dir, "shots"))).toBe(false);
  }, 30_000);
});

describe("the bootstrap prompt carries one grading rule, not two", () => {
  it("drops the delta instructions entirely when there is no before", () => {
    // The bootstrap block said "every flaw here is this change's doing" and the shared
    // text right after it said to mark flaws visible in both images as pre-existing.
    // With no before image, that is a contradiction the model gets to resolve — and the
    // relaxed reading is the one that passes the first screen this app ever drew.
    writeFileSync(join(tmp, "law2.md"), "---\nname: dj\n---\ndesign law\n");
    const base = {
      headDir: join(tmp, "h"), baseDir: join(tmp, "b"),
      design: { contract: "DESIGN.md", screens: "npm run ui:screens", out: "shots" },
      verdictPath: join(tmp, "v.json"), logPath: join(tmp, "l.txt"),
      budgetUsd: 3, agentDefinitionPath: join(tmp, "law2.md"),
    };
    const boot = assembleDesignJudgePrompt({ ...base, baselineEmpty: true } as never);
    expect(boot).toContain("Every flaw here is this change's doing");
    expect(boot).not.toContain("grading the difference, not the screen");
    // The delta rule's operative clause: mark a flaw seen in both as someone else's.
    expect(boot).not.toContain("A flaw visible in BOTH images");
    expect(boot).not.toContain("say it pre-exists");
    // NOT a bare `not.toContain("ok: true")` any more, and the reason matters. That was
    // a proxy for "the excuse is absent", and it stopped being one: the bootstrap path
    // now uses `ok: true` for a different purpose — recording a property the contract
    // does not pin. Two instructions, same token, opposite meanings, so the assertion
    // has to name the instruction. The bootstrap prompt still says the words "nothing on
    // them pre-exists", which is why the check above is the delta's "say it pre-exists".
    expect(boot).toContain("does not pin");
    expect(boot).not.toContain("without the change being blamed for it");

    const delta = assembleDesignJudgePrompt({ ...base, baselineEmpty: false } as never);
    expect(delta).toContain("grading the difference, not the screen");
    expect(delta).not.toContain("Every flaw here is this change's doing");
  });
});

describe("what a design rejection tells the next attempt", () => {
  // Eight findings whose `observed` reads like a real one: a measurement, a token
  // name and a contract citation. That is what the rung actually produces, and it is
  // the length the old 300-character clip could not carry.
  const realistic = {
    verdict: "fail" as const,
    screens: ["lines.png", "lines-narrow.png"],
    gates_executed: ["screens-rendered", "screens-viewed"],
    findings: Array.from({ length: 8 }, (_, i) => ({
      screen: i % 2 === 0 ? "lines.png" : "lines-narrow.png",
      region: `region ${i}`,
      rule: `rule-${i}`,
      observed: `Measured finding ${i}: digit ink height is 10.0px where DESIGN.md §3 names --text-figure-sm at 20px 600 tabular. ${"x".repeat(500)}`,
      ok: false,
    })),
  };

  it("carries every failing finding's observation, not just the rule slug", () => {
    const detail = designFailureDetail(realistic);
    // The rule is a slug; `observed` is the only field that says what is wrong.
    for (const f of realistic.findings) {
      expect(detail).toContain(f.observed);
      expect(detail).toContain(f.region);
      expect(detail).toContain(f.rule);
    }
  });

  it("does not clip an ordinary verdict — the cap guards pathology, it is not a budget", () => {
    const detail = designFailureDetail(realistic);
    // The regression this replaces clipped at 300, which is two findings out of eight.
    expect(detail.length).toBeGreaterThan(4000);
    expect(detail).toContain(realistic.findings[7]!.observed);
  });

  it("caps a pathological verdict rather than handing the retry a novel", () => {
    const huge = {
      ...realistic,
      findings: Array.from({ length: 60 }, (_, i) => ({
        screen: "lines.png", region: `r${i}`, rule: `rule-${i}`,
        observed: "y".repeat(2000), ok: false,
      })),
    };
    const detail = designFailureDetail(huge);
    // Under the cap, plus room for the omission note.
    expect(detail.length).toBeLessThan(12400);
    expect(detail).toContain("further finding(s) omitted for length");
  });

  it("drops whole findings at the cap — never a slice through the middle of one", () => {
    const huge = {
      ...realistic,
      findings: Array.from({ length: 40 }, (_, i) => ({
        screen: "lines.png", region: `r${i}`, rule: `rule-${i}`,
        observed: `OPENING-${i} ${"y".repeat(1500)} CLOSING-${i}`, ok: false,
      })),
    };
    const detail = designFailureDetail(huge);
    // A raw slice would leave the last kept finding opened and never closed, and the
    // retry would read that half as the whole finding. Every OPENING present must have
    // its CLOSING present too.
    for (let i = 0; i < 40; i += 1) {
      if (detail.includes(`OPENING-${i} `)) {
        expect(detail).toContain(`CLOSING-${i}`);
      }
    }
    // And it says how many it could not carry, so a short retry knows it is short.
    const omitted = /\[(\d+) further finding\(s\) omitted/.exec(detail);
    expect(omitted).not.toBeNull();
    const kept = detail.split("CLOSING-").length - 1;
    expect(kept + Number(omitted![1])).toBe(40);
  });

  it("keeps the opening of a single finding that is itself longer than the cap", () => {
    const monster = {
      ...realistic,
      findings: [{ screen: "a.png", region: "r", rule: "x", observed: "z".repeat(20000), ok: false }],
    };
    const detail = designFailureDetail(monster);
    // Returning nothing at all would be the worst answer: the retry would look like an
    // attempt that recorded no reason, which is the state this whole path exists to end.
    expect(detail.length).toBeGreaterThan(0);
    expect(detail).toContain("truncated");
    expect(detail).toContain("a.png (r)");
  });

  it("omits findings the judge passed — a retry answers what failed", () => {
    const mixed = {
      ...realistic,
      findings: [
        { screen: "a.png", region: "r", rule: "kept", observed: "THIS FAILED", ok: false },
        { screen: "b.png", region: "r", rule: "dropped", observed: "THIS PASSED", ok: true },
      ],
    };
    const detail = designFailureDetail(mixed);
    expect(detail).toContain("THIS FAILED");
    expect(detail).not.toContain("THIS PASSED");
    expect(detail).not.toContain("dropped");
  });

  it("names the region even when the judge left the rule blank", () => {
    const noRule = {
      ...realistic,
      findings: [{ screen: "a.png", region: "the total row", rule: "", observed: "no total is drawn", ok: false }],
    };
    // `rule` is optional in the schema, so interpolating it unconditionally is how
    // "criterion: undefined" got written into a retry's input once already.
    const detail = designFailureDetail(noRule);
    expect(detail).toContain("a.png (the total row): no total is drawn");
    expect(detail).not.toContain("undefined");
    expect(detail).not.toContain("— :");
  });

  it("keeps the human summary one line — the tick log is not the retry's input", () => {
    const summary = designFailureSummary(realistic);
    expect(summary).not.toContain("\n");
    expect(summary.length).toBeLessThanOrEqual(300);
    // And it stays a summary: the observations belong in the metric, not here.
    expect(summary).not.toContain(realistic.findings[0]!.observed);
  });
});

describe("a design rejection has to name what it rejected", () => {
  it("refuses a fail whose every finding passes", () => {
    // On the delta path an all-`ok: true` verdict is the shape of a PASS: every flaw
    // seen was ruled pre-existing. Calling that a fail rejects the change for something
    // it did not do, and hands the retry nothing to answer.
    const res = validateDesignVerdict(verdict({ verdict: "fail", findings: [finding({ ok: true })] }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join(" ")).toContain("names nothing it rejected");
  });

  it("accepts a fail that names one", () => {
    const res = validateDesignVerdict(verdict({ verdict: "fail", findings: [finding({ ok: true }), finding({ ok: false })] }));
    expect(res.ok).toBe(true);
  });
});

describe("the contract is the standard, not the judge's taste", () => {
  const ctx = (baselineEmpty: boolean) => {
    const tmp2 = mkdtempSync(join(tmpdir(), "doctrine-dj-brake-"));
    writeFileSync(join(tmp2, "law.md"), "---\nname: dj\n---\ndesign law\n");
    return {
      headDir: join(tmp2, "h"), baseDir: join(tmp2, "b"),
      design: { contract: "DESIGN.md", screens: "npm run ui:screens", out: "shots" },
      verdictPath: join(tmp2, "v.json"), logPath: join(tmp2, "l.txt"),
      budgetUsd: 3, agentDefinitionPath: join(tmp2, "law.md"),
      baselineEmpty,
    };
  };

  // A target's first UI unit failed four times, and on the fourth THREE of the four
  // findings were properties the previous judge had explicitly declined to fail because
  // the contract does not pin them — a missing total ("DESIGN mandates a total nowhere
  // for a line list"), an unlit nav pill ("the contract does not cover it either way"),
  // and a column width whose clause reads two ways. Same pixels, opposite rulings. The
  // prompt allowed both, which is the defect: it said who owns a flaw and never what
  // counts as one.
  for (const baselineEmpty of [true, false]) {
    it(`carries the contract brake on the ${baselineEmpty ? "empty-baseline" : "delta"} path`, () => {
      const p = assembleDesignJudgePrompt(ctx(baselineEmpty) as never);
      expect(p).toContain("Name the standard you are failing it against");
      expect(p).toContain("does not pin");
      // The ambiguity half: a clause readable two ways, satisfied one way, passes.
      expect(p).toContain("read two ways");
      // And the half that must NOT be weakened: the ban-list and the at-a-glance test
      // stand on their own. A rule that made every finding cite the target's contract
      // would silence exactly the tells this judge exists to catch — a wall of
      // equal-weight cards breaks no token, and neither does a missing total.
      expect(p).toContain("INDEPENDENT of the contract");
      expect(p).toContain("wall of equal-weight cards");
      expect(p).toContain("hunt for has failed");
    });
  }

  it("says explicitly that owning a flaw is not the same as it being one", () => {
    // The empty-baseline branch is where this is easiest to skip, because "every flaw
    // here is this change's doing" reads like a licence to fail anything.
    const p = assembleDesignJudgePrompt(ctx(true) as never);
    expect(p).toContain("Every flaw here is this change's doing");
    // Substrings that do not straddle a line break in the prompt's wrapped prose.
    expect(p).toContain("who OWNS a flaw");
    expect(p).toContain("what COUNTS as one");
  });
});

describe("a verdict may say which worktree it opened", () => {
  const shots = (dir: string, names: string[]) => {
    mkdirSync(dir, { recursive: true });
    for (const n of names) writeFileSync(join(dir, n), "x");
  };

  const runWith = async (screens: string[], baselineEmpty: boolean) => {
    const tmp2 = mkdtempSync(join(tmpdir(), "doctrine-dj-shots-"));
    const headDir = join(tmp2, "impl");
    const baseDir = join(tmp2, "base");
    shots(join(headDir, "shots"), ["billing.png", "billing-narrow.png"]);
    if (!baselineEmpty) shots(join(baseDir, "shots"), ["billing.png", "billing-narrow.png"]);
    writeFileSync(join(tmp2, "law.md"), "---\nname: dj\n---\ndesign law\n");
    const verdictPath = join(tmp2, "v.json");
    return runDesignJudge({
      headDir, baseDir, baselineEmpty,
      design: { contract: "DESIGN.md", screens: "true", out: "shots" },
      verdictPath, logPath: join(tmp2, "l.txt"),
      budgetUsd: 3, agentDefinitionPath: join(tmp2, "law.md"),
      runAgent: async (_p: string, opts: { logPath: string }) => {
        writeFileSync(verdictPath, JSON.stringify({
          verdict: "pass", screens,
          findings: [finding({ ok: true, screen: screens[0] })],
          gates_executed: ["screens-rendered", "screens-viewed"],
        }));
        writeFileSync(opts.logPath, "");
        return { exitCode: 0, spawnFailed: false, signal: null, stdout: "", stderr: "", timedOut: false, outage: false, logPath: opts.logPath, resultMessage: { total_cost_usd: 0.1 } };
      },
    } as never);
  };

  it("accepts worktree-qualified names, which the delta path needs", async () => {
    // Two directories hold the same file names, so "billing.png" alone cannot say before from
    // after. The judge writes the path; this check compares by file name. Refusing these cost
    // u-2026-09-05-invoice-review an attempt on 2026-09-07 — the first UI unit judged against a
    // real baseline — and would have refused every UI unit after it.
    const out = await runWith(
      ["impl/.artifacts/screens/billing.png", "base/.artifacts/screens/billing.png"],
      false,
    );
    expect(out.kind).toBe("judged");
  });

  it("still accepts a bare name", async () => {
    const out = await runWith(["billing.png"], false);
    expect(out.kind).toBe("judged");
  });

  it("refuses a BASE screen on the bootstrap path, where the base rendered nothing", async () => {
    // The hole that comparing by file name alone would open, and the one this check exists for.
    // With no baseline the judge cannot have opened `base/shots/billing.png` — but the HEAD did
    // render `billing.png`, so a name-only comparison would accept it and admit a verdict claiming
    // a before/after comparison that never happened.
    const out = await runWith(["base/shots/billing.png"], true);
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.errors.join(" ")).toContain("were not rendered");
  });

  it("attributes a qualified name to the side it names, not to either", async () => {
    // Same rule on the delta path: `impl/...` is checked against the head's images and `base/...`
    // against the base's, so a file present on only one side cannot be claimed for the other.
    const ok = await runWith(["impl/shots/billing.png", "base/shots/billing-narrow.png"], false);
    expect(ok.kind).toBe("judged");
  });

  it("still refuses a screen nothing rendered", async () => {
    // The liveness property this check exists for: a name matching no rendered image is a judge
    // that did not look, whatever directory it claims to have looked in.
    const out = await runWith(["impl/.artifacts/screens/invented.png"], false);
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toBe("malformed-verdict");
    expect(out.errors.join(" ")).toContain("were not rendered");
  });
});
