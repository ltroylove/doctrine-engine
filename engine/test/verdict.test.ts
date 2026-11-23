import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadVerdict, validateVerdict } from "../src/verdict.js";
import { parseWorkUnit, type WorkUnit } from "../src/work-unit.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-verdict-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function unit(): WorkUnit {
  const res = parseWorkUnit(`---
id: wu-x
title: t
tier: reversible
status: ready
budget_usd: 5
evidence:
  - kind: test
    run: "pnpm vitest run test/x.test.ts"
    expect: "fails on base, passes on head"
---
b`);
  if (!res.ok) throw new Error("fixture must parse");
  return res.unit;
}

const GATES = ["diff-read", "build", "test-head"] as const;

function goodVerdict(): Record<string, unknown> {
  return {
    unit: "wu-x",
    verdict: "pass",
    judged: true,
    coherence: [{ criterion: "scope fits the unit", ok: true, quote: "only test/x and src/x touched" }],
    evidence: [
      {
        spec: "pnpm vitest run test/x.test.ts",
        run: {
          command: "pnpm vitest run test/x.test.ts",
          exit_code: 0,
          output_sha256: "ab12",
          log: "runs/x/evidence-0.log",
        },
        ok: true,
      },
    ],
    gates_executed: ["diff-read", "build", "test-head"],
    base_sha: "aaa111",
    head_sha: "bbb222",
    spend_usd: 0.5,
  };
}

describe("validateVerdict — gate honesty in engine code", () => {
  it("accepts an honest, complete verdict", () => {
    const res = validateVerdict(goodVerdict(), unit(), GATES);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.verdict).toBe("pass");
    expect(res.verdict.gates_executed).toContain("build");
  });

  it("judged:false is unrepresentable — a keyless no-op judge fails the tick", () => {
    const v = goodVerdict();
    v["judged"] = false;
    const res = validateVerdict(v, unit(), GATES);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("malformed-verdict");
    expect(res.errors.join("\n")).toContain("judged must be exactly true");
  });

  it("an evidence claim without an executed run block is rejected — assertion is not evidence", () => {
    const v = goodVerdict();
    (v["evidence"] as Record<string, unknown>[])[0]!["run"] = { command: "pnpm vitest" }; // no exit code, hash, log
    const res = validateVerdict(v, unit(), GATES);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("assertion is not evidence");
  });

  it("every unit evidence spec must be discharged", () => {
    const v = goodVerdict();
    v["evidence"] = [];
    const res = validateVerdict(v, unit(), GATES);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("every spec must be discharged");
  });

  it("a missing gate execution is green-by-absence — banned", () => {
    const v = goodVerdict();
    v["gates_executed"] = ["diff-read", "test-head"]; // build never ran
    const res = validateVerdict(v, unit(), GATES);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain('gate "build" has no execution proof');
  });

  it("a pass with failing entries is dishonest by construction", () => {
    const v = goodVerdict();
    (v["evidence"] as Record<string, unknown>[])[0]!["ok"] = false;
    const res = validateVerdict(v, unit(), GATES);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("dishonest by construction");
  });

  it("a passing coherence criterion must quote the artifact", () => {
    const v = goodVerdict();
    (v["coherence"] as Record<string, unknown>[])[0]!["quote"] = "";
    const res = validateVerdict(v, unit(), GATES);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("quote-or-it-didn't-happen");
  });

  it("rejects a verdict for the wrong unit", () => {
    const v = goodVerdict();
    v["unit"] = "wu-somebody-else";
    const res = validateVerdict(v, unit(), GATES);
    expect(res.ok).toBe(false);
  });
});

describe("loadVerdict", () => {
  it("missing file → missing-verdict", () => {
    const res = loadVerdict(join(tmp, "nope.json"), unit(), GATES);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("missing-verdict");
  });

  it("unparseable file → malformed-verdict", () => {
    const p = join(tmp, "bad.json");
    writeFileSync(p, "{not json");
    const res = loadVerdict(p, unit(), GATES);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("malformed-verdict");
  });

  it("valid file round-trips", () => {
    const p = join(tmp, "good.json");
    writeFileSync(p, JSON.stringify(goodVerdict()));
    const res = loadVerdict(p, unit(), GATES);
    expect(res.ok).toBe(true);
  });
});

describe("what a failed verdict tells the retry", () => {
  // The summary a retry receives has three ways of becoming worse than silence, and all
  // three were live (doctrine#29 review).
  const summarise = (v: {
    coherence: { criterion: string; ok: boolean; quote?: string }[];
    evidence: { spec: string; run: { exit_code: number }; ok: boolean }[];
  }, unitEvidence: { run: string; expect: string }[]): string =>
    [
      ...v.coherence.filter((c) => !c.ok).map((c) => {
        const q = (c.quote ?? "").trim();
        return "coherence `" + c.criterion + "`" + (q.length > 0 ? ": " + q : " — the judge recorded no quote");
      }),
      ...v.evidence.filter((e) => !e.ok).map((e) => {
        const expect = unitEvidence.find((u) => u.run === e.spec)?.expect;
        const wanted = expect === undefined ? "" : " — expected: " + expect;
        return e.run.exit_code === 0
          ? "evidence `" + e.spec + "` ran clean but its output did not satisfy the spec" + wanted
          : "evidence `" + e.spec + "` exited " + e.run.exit_code + wanted;
      }),
    ].join("; ");

  it("never reports a rejected check as having exited 0", () => {
    // The common case: the judge RAN it, and the output did not satisfy the spec.
    // "exited 0" there reads as a passing check and sends the retry elsewhere.
    const out = summarise(
      { coherence: [], evidence: [{ spec: "npm test", run: { exit_code: 0 }, ok: false }] },
      [{ run: "npm test", expect: "the totals row shows the sum" }],
    );
    expect(out).toContain("ran clean but its output did not satisfy the spec");
    expect(out).toContain("expected: the totals row shows the sum");
    expect(out).not.toContain("exited 0");
  });

  it("reports the exit code when the exit code IS the finding", () => {
    const out = summarise(
      { coherence: [], evidence: [{ spec: "npm test", run: { exit_code: 1 }, ok: false }] },
      [{ run: "npm test", expect: "exit 0" }],
    );
    expect(out).toContain("exited 1");
    expect(out).toContain("expected: exit 0");
  });

  it("never emits `criterion: undefined` for a coherence entry with no quote", () => {
    // quote-or-it-didn't-happen binds a PASS, so a failing entry may legally omit it.
    const out = summarise(
      { coherence: [{ criterion: "scope", ok: false }], evidence: [] },
      [],
    );
    expect(out).toContain("coherence `scope`");
    expect(out).not.toContain("undefined");
    expect(out).toContain("no quote");
  });
});

describe("a rejection has to name what it rejected", () => {
  // Only the pass direction was checked, so a `fail` whose every entry passed was a
  // legal verdict. It reached the retry as "code-judge fail: " — a prefix with nothing
  // after it, non-blank, and therefore indistinguishable downstream from a real reason.
  it("refuses a fail whose every entry passes", () => {
    const raw: Record<string, unknown> = { ...goodVerdict(), verdict: "fail" };
    const res = validateVerdict(raw, unit(), GATES);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("malformed-verdict");
    expect(res.errors.join(" ")).toContain("names nothing it rejected");
  });

  it("accepts a fail that names one", () => {
    const raw: Record<string, unknown> = { ...goodVerdict(), verdict: "fail" };
    raw["coherence"] = [{ criterion: "scope fits the unit", ok: false, quote: "src/unrelated.ts is in the diff" }];
    const res = validateVerdict(raw, unit(), GATES);
    expect(res.ok).toBe(true);
  });

  it("accepts a fail named by a failing evidence entry alone", () => {
    const raw: Record<string, unknown> = { ...goodVerdict(), verdict: "fail" };
    raw["evidence"] = [{
      spec: "pnpm vitest run test/x.test.ts",
      run: { command: "pnpm vitest run test/x.test.ts", exit_code: 1, output_sha256: "ab12", log: "runs/x/evidence-0.log" },
      ok: false,
    }];
    expect(validateVerdict(raw, unit(), GATES).ok).toBe(true);
  });

  it("an escalate must carry its diagnosis, because that diagnosis is the only way out", () => {
    // This test used to assert the opposite, on the premise that escalate means "a person
    // should look" and no retry reads it. Half of that is still true — no retry reads it —
    // and that is exactly why the rule changed. Nothing in the loop ever moves an escalated
    // unit again, so the judge's account of what is wrong with the UNIT is the only thing
    // that can become progress: it is what the gap decomposer reads to write a replacement
    // spec. A blank one buys a permanently dead unit and a planner told nothing.
    //
    // Malformed rather than failed, deliberately: that is an instrument failure, so the
    // judge is asked again and the unit is charged nothing for our missing field.
    const bare = { ...goodVerdict(), verdict: "escalate" };
    const bareResult = validateVerdict(bare, unit(), GATES);
    expect(bareResult.ok).toBe(false);
    if (!bareResult.ok) expect(bareResult.reason).toBe("malformed-verdict");

    // A real escalate has something that did not pass — the impossible spec is what fails.
    // An escalate with every entry green is a `pass` wearing a different word, and it is
    // rejected by the same rule as a fail that names nothing; see the next test.
    const withDiagnosis = {
      ...goodVerdict(),
      verdict: "escalate",
      evidence: [{ ...(goodVerdict()["evidence"] as Record<string, unknown>[])[0]!, ok: false }],
      escalation: {
        reason: "evidence spec 0 contradicts itself",
        detail: "its `ok` expression requires both `during` to exclude the dateless rows and the 2026-08-31 queue to include them",
        escape_hatches_closed: "created_at filtering is forbidden by the unit's own presence table",
      },
    };
    expect(validateVerdict(withDiagnosis, unit(), GATES).ok).toBe(true);
  });

  it("and a blank field is not a diagnosis", () => {
    // The failure mode this actually guards is not a judge that omits the block; it is one
    // that emits its shape and fills it with nothing.
    const blank = {
      ...goodVerdict(),
      verdict: "escalate",
      evidence: [{ ...(goodVerdict()["evidence"] as Record<string, unknown>[])[0]!, ok: false }],
      escalation: { reason: "   ", detail: "", escape_hatches_closed: "x" },
    };
    expect(validateVerdict(blank, unit(), GATES).ok).toBe(false);
  });

  it("and an escalate whose every check passes is a pass wearing a different word", () => {
    // The consequence is heavier than a fail's — the unit is parked permanently and the
    // intent may grade around it — so spending that on a verdict where nothing tripped is
    // the worse version of the same mistake.
    const allGreen = {
      ...goodVerdict(),
      verdict: "escalate",
      escalation: { reason: "r", detail: "d", escape_hatches_closed: "e" },
    };
    expect(validateVerdict(allGreen, unit(), GATES).ok).toBe(false);
  });
});
