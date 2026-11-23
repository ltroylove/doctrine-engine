import { describe, expect, it } from "vitest";
import {
  lintCoverage,
  lintScaffold,
  parseCriteria,
  programProgress,
  structuralIntents,
  type Covering,
} from "../src/coverage.js";
import { parseIntent, type Intent, type IntentStatus } from "../src/intent.js";

const LF = String.fromCharCode(10);

const PRD = `# PRD — a target

## 4. Capabilities and success criteria

### C1. Ledger and close

The app keeps its own ledger.

- **machine** \`C1.1\` Import produces exactly the lines in the fixture's expected file.
- **machine** \`C1.2\` Close with one uncategorized line refuses, naming the line.

### C2. Reports

- **machine** \`C2.1\` The monthly package renders for a fixture month.
- **draft** \`C2.2\` The package reads well to an accountant.
`;

function intent(
  id: string,
  opts: { delivers?: string[]; deps?: string[]; status?: IntentStatus; acceptance?: boolean } = {},
): Intent {
  const acceptance = opts.acceptance
    ? `acceptance:
  - kind: test
    run: "npm test"
    expect: "exit 0"`
    : "";
  const res = parseIntent(`---
id: ${id}
level: intent
title: ${id}
status: ${opts.status ?? "scaffold"}
parent: ft-fixture
budget_usd: 20
tier_default: reversible
delivers: [${(opts.delivers ?? ["C1.1"]).join(", ")}]
depends_on: [${(opts.deps ?? []).join(", ")}]
${acceptance}
---
body`);
  if (!res.ok) throw new Error(`fixture must parse: ${res.errors.join("; ")}`);
  return res.intent;
}

describe("parseCriteria", () => {
  it("reads ids, kinds and the capability heading that scopes them", () => {
    const parse = parseCriteria(PRD);
    expect(parse.criteria.map((c) => c.id)).toEqual(["C1.1", "C1.2", "C2.1", "C2.2"]);
    expect(parse.criteria.map((c) => c.capability)).toEqual(["C1", "C1", "C2", "C2"]);
    expect(parse.criteria.find((c) => c.id === "C2.2")?.kind).toBe("draft");
    expect(parse.unlabelled).toEqual([]);
    expect(parse.duplicateIds).toEqual([]);
  });

  it("counts an unlabelled criterion instead of skipping it", () => {
    // The failure this guards: an operator labels half the PRD, the parser silently
    // shrinks the denominator, and coverage reports green over the labelled half.
    const parse = parseCriteria(PRD.replace("- **machine** `C1.2`", "- **machine**"));
    expect(parse.criteria.map((c) => c.id)).toEqual(["C1.1", "C2.1", "C2.2"]);
    expect(parse.unlabelled).toHaveLength(1);
    expect(parse.unlabelled[0]).toContain("C1:");
  });

  it("reports an id used twice rather than letting one shadow the other", () => {
    expect(parseCriteria(PRD.replace("`C2.1`", "`C1.1`")).duplicateIds).toEqual(["C1.1"]);
  });
});

describe("lintCoverage", () => {
  const parse = parseCriteria(PRD);

  it("passes when every criterion is claimed by some intent", () => {
    const lint = lintCoverage(parse, [
      intent("in-a", { delivers: ["C1.1", "C1.2"] }),
      intent("in-b", { delivers: ["C2.1", "C2.2"] }),
    ]);
    expect(lint.problems).toEqual([]);
    expect(lint.ok).toBe(true);
  });

  it("fails on a criterion no intent delivers — the whole point of the rung", () => {
    const lint = lintCoverage(parse, [intent("in-a", { delivers: ["C1.1", "C1.2", "C2.1"] })]);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join("\n")).toContain("C2.2");
    expect(lint.problems.join("\n")).toContain("covered by no slice");
  });

  it("counts a draft criterion toward coverage, like any other requirement", () => {
    // Dropping `draft` here would quietly redefine the program as its testable part.
    const lint = lintCoverage(parse, [intent("in-a", { delivers: ["C1.1", "C1.2", "C2.1"] })]);
    expect(lint.problems.some((p) => p.startsWith("C2.2"))).toBe(true);
  });

  it("fails on an invented criterion id, so coverage cannot be typed into existence", () => {
    const lint = lintCoverage(parse, [
      intent("in-a", { delivers: ["C1.1", "C1.2", "C2.1", "C2.2", "C9.9"] }),
    ]);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join("\n")).toContain("C9.9");
    expect(lint.problems.join("\n")).toContain("not a criterion in the PRD");
  });

  it("fails when the PRD itself has unlabelled criteria", () => {
    const half = parseCriteria(PRD.replace("- **machine** `C1.2`", "- **machine**"));
    const lint = lintCoverage(half, [
      intent("in-a", { delivers: ["C1.1"] }),
      intent("in-b", { delivers: ["C2.1", "C2.2"] }),
    ]);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join("\n")).toContain("carries no id");
  });

  it("flags but does not fail a criterion two intents share", () => {
    const lint = lintCoverage(parse, [
      intent("in-a", { delivers: ["C1.1", "C1.2"] }),
      intent("in-b", { delivers: ["C1.1", "C2.1", "C2.2"] }),
    ]);
    expect(lint.ok).toBe(true);
    expect(lint.flags.join("\n")).toContain("C1.1 is covered by 2 slices");
  });

  it("fails a criterion whose id disagrees with the heading it sits under", () => {
    // The hazard of the manual id migration: C2.1 typed under ### C1. is claimable,
    // coverable, and wrong about which capability it belongs to.
    const drifted = parseCriteria(PRD.replace("- **machine** `C1.2`", "- **machine** `C2.9`"));
    const lint = lintCoverage(drifted, [
      intent("in-a", { delivers: ["C1.1", "C2.9"] }),
      intent("in-b", { delivers: ["C2.1", "C2.2"] }),
    ]);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(" ")).toContain("sits under the C1 heading");
  });

  it("flags a structural intent without failing the set", () => {
    const lint = lintCoverage(parse, [
      intent("in-a", { delivers: ["C1.1", "C1.2"] }),
      intent("in-b", { delivers: ["C2.1", "C2.2"] }),
      intent("in-infra", { delivers: [] }),
    ]);
    expect(lint.ok).toBe(true);
    expect(lint.flags.join(" ")).toContain("in-infra delivers no criterion");
    expect(structuralIntents([intent("in-a"), intent("in-infra", { delivers: [] })])).toEqual(["in-infra"]);
  });

  it("still fails when a structural intent leaves a criterion uncovered", () => {
    // Allowing an empty `delivers` must not become the hatch: the SET still has to close.
    const lint = lintCoverage(parse, [
      intent("in-a", { delivers: ["C1.1", "C1.2"] }),
      intent("in-infra", { delivers: [] }),
    ]);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(" ")).toContain("C2.1");
  });

  it("refuses to call an empty criterion set covered", () => {
    expect(lintCoverage(parseCriteria("# nothing here"), []).ok).toBe(false);
  });
});

describe("the scaffold status keeps rule 2 intact", () => {
  it("refuses a scaffold that carries acceptance evidence", () => {
    const res = parseIntent(`---
id: in-a
title: a
status: scaffold
budget_usd: 20
tier_default: reversible
delivers: [C1.1]
acceptance:
  - kind: test
    run: "npm test"
    expect: "exit 0"
---
body`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join("\n")).toContain("must carry no acceptance evidence");
  });

  it("ALLOWS a scaffold that delivers nothing — blocking it would force a dishonest claim", () => {
    // Structural work exists (a chart of accounts, a test harness). Requiring every
    // intent to name a criterion makes the planner attach one it does not grade, which
    // is coverage typed into existence — the failure the invented-id check exists to
    // stop. Completeness is a SET property and `lintCoverage` still carries it; this
    // intent is reported by `structuralIntents` instead of refused.
    const res = parseIntent(`---
id: in-a
title: a
status: scaffold
budget_usd: 20
tier_default: reversible
---
body`);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.intent.delivers).toEqual([]);
  });

  it("still refuses a ready intent with no acceptance — the older half of the law", () => {
    const res = parseIntent(`---
id: in-a
title: a
status: ready
budget_usd: 20
tier_default: reversible
delivers: [C1.1]
---
body`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join("\n")).toContain("without acceptance evidence");
  });
});

describe("lintScaffold", () => {
  const parse = parseCriteria(PRD);
  // in-b waits on C1.1, which in-a delivers. Edges name REQUIREMENTS at every level
  // (ADR-0004); a scaffold naming another scaffold was the earlier shape, and the
  // fixtures here went on asserting it green for two changes after it stopped being true.
  const full = (): Intent[] => [
    intent("in-a", { delivers: ["C1.1", "C1.2"] }),
    intent("in-b", { delivers: ["C2.1", "C2.2"], deps: ["C1.1"] }),
  ];

  it("passes a covered, acyclic set with resolvable edges", () => {
    expect(lintScaffold(parse, full()).ok).toBe(true);
  });

  it("fails an edge on a criterion nothing in the scaffold delivers or renders", () => {
    // The whole-program mint gate is the one place a CLOSED-world answer is right: a
    // newly minted scaffold is the program, so nothing it waits on can be outside it.
    const lint = lintScaffold(parse, [
      intent("in-a", { delivers: ["C1.1", "C1.2"] }),
      intent("in-b", { delivers: ["C2.1", "C2.2"], deps: ["C9.9"] }),
    ]);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(LF)).toContain("depends on C9.9, which no scaffold delivers or renders");
  });

  it("fails a cycle — which would idle the loop forever with work outstanding", () => {
    const lint = lintScaffold(parse, [
      intent("in-a", { delivers: ["C1.1", "C1.2"], deps: ["C2.1"] }),
      intent("in-b", { delivers: ["C2.1", "C2.2"], deps: ["C1.1"] }),
    ]);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(LF)).toContain("cycle");
  });

  it("fails any member that is not actually a scaffold", () => {
    // Otherwise the gate is bypassable by writing the wrong status: parseIntent
    // requires acceptance only for ready/decomposed, so a `done` intent with none
    // parses, delivers, and is counted COMPLETE by programProgress on the spot.
    const lint = lintScaffold(parse, [
      intent("in-a", { delivers: ["C1.1", "C1.2"] }),
      intent("in-b", { delivers: ["C2.1", "C2.2"], status: "done" }),
    ]);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(" ")).toContain('in-b has status "done"');
  });

  it("fails a self-dependency — a slice cannot wait on its own work", () => {
    const lint = lintScaffold(parse, [
      intent("in-a", { delivers: ["C1.1", "C1.2"], deps: ["C1.1"] }),
      intent("in-b", { delivers: ["C2.1", "C2.2"] }),
    ]);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(LF)).toContain("which it names itself");
  });

  it("scoped to one epic, a criterion another epic owns is not this scaffold's gap", () => {
    // ADR-0006: the epic ACT scaffolds its own units, so the coverage question is "every
    // criterion THIS EPIC delivers reaches one of its units". Asked against the whole PRD
    // it would fail every epic for the criteria the other epics own. `lintEpics` asks the
    // other half; the whole-program answer is the composition.
    const lint = lintScaffold(parse, [intent("in-a", { delivers: ["C1.1", "C1.2"] })], { scope: ["C1.1", "C1.2"] });
    expect(lint.problems).toEqual([]);
    expect(lint.ok).toBe(true);
  });

  it("but still fails a gap INSIDE its own scope, which is what it is answerable for", () => {
    const lint = lintScaffold(parse, [intent("in-a", { delivers: ["C1.1"] })], { scope: ["C1.1", "C1.2"] });
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(LF)).toContain("C1.2");
  });

  it("accepts an edge on a criterion an EARLIER epic delivers — open-world, per ADR-0006", () => {
    // The cost of scaffolding per epic, which a closed-world check gets wrong.
    // Handed only the new units, this edge reads as one that can never
    // clear, and the gate built to prevent the quiet kind of stuck causes it.
    const earlier = [intent("in-earlier", { delivers: ["C1.1", "C1.2"] })];
    const lint = lintScaffold(parse, [intent("in-b", { delivers: ["C2.1", "C2.2"], deps: ["C1.1"] })], {
      elsewhere: earlier,
      scope: ["C2.1", "C2.2"],
    });
    expect(lint.problems).toEqual([]);
  });

  it("refuses an id that already exists elsewhere in the program", () => {
    // Only possible because minting is per epic now: a whole-program scaffold had nothing
    // to collide with. Re-minting an id is the most expensive failure available here.
    const lint = lintScaffold(parse, [intent("in-a", { delivers: ["C2.1", "C2.2"] })], {
      elsewhere: [intent("in-a", { delivers: ["C1.1", "C1.2"] })],
      scope: ["C2.1", "C2.2"],
    });
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(LF)).toContain("duplicate unit id in-a");
  });

  it("does not fail an epic for a defect among slices it did not write", () => {
    // Otherwise the ACT reverts, re-runs and refuses again until the failure halt trips —
    // spend, with nothing it could have done differently.
    const broken = [intent("in-old", { delivers: ["C1.1", "C1.2"], deps: ["C7.7"] })];
    const lint = lintScaffold(parse, [intent("in-b", { delivers: ["C2.1", "C2.2"] })], {
      elsewhere: broken,
      scope: ["C2.1", "C2.2"],
    });
    expect(lint.problems).toEqual([]);
  });

  it("carries the coverage failure through — one gate, not two", () => {
    const lint = lintScaffold(parse, [intent("in-a", { delivers: ["C1.1"] })]);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join("\n")).toContain("covered by no unit");
  });
});

describe("programProgress — done is computed, not claimed", () => {
  const parse = parseCriteria(PRD);
  /** What "landed" means for an intent document. An epic's is `status === "done"` too,
   *  and a unit's is `merged` — which is the whole reason the predicate is the caller's. */
  const landed = (s: Covering) => (s as Intent).status === "done";

  it("counts a machine criterion done only when every covering intent is done", () => {
    const p = programProgress(parse, [
      intent("in-a", { delivers: ["C1.1", "C1.2"], status: "done", acceptance: true }),
      intent("in-b", { delivers: ["C2.1", "C2.2"] }),
    ], landed);
    expect(p.machineTotal).toBe(3);
    expect(p.machineDone).toBe(2);
    expect(p.outstanding).toEqual(["C2.1"]);
    expect(p.done).toBe(false);
  });

  it("never marks a draft criterion done, however its covering intent lands", () => {
    // The failure this guards: an intent lands on its other acceptance entries and a
    // criterion nothing grades flips to done — an acceptance list where nothing fails,
    // one rung up, inside the gate built to stop exactly that.
    const p = programProgress(parse, [
      intent("in-a", { delivers: ["C1.1", "C1.2", "C2.1", "C2.2"], status: "done", acceptance: true }),
    ], landed);
    expect(p.outstanding).toEqual([]);
    expect(p.done).toBe(true);
    expect(p.unverifiable).toEqual(["C2.2"]);
    expect(p.machineTotal).toBe(3);
  });

  it("does not let the easier of two covering intents settle a shared criterion", () => {
    const p = programProgress(parse, [
      intent("in-a", { delivers: ["C1.1", "C1.2", "C2.1", "C2.2"], status: "done", acceptance: true }),
      intent("in-b", { delivers: ["C1.1"] }),
    ], landed);
    expect(p.outstanding).toEqual(["C1.1"]);
    expect(p.done).toBe(false);
  });

  it("refuses to call a program with no machine criteria done", () => {
    const draftOnly = ["### C1. x", "", "- **draft** `C1.1` prose only.", ""].join("\n");
    const p = programProgress(parseCriteria(draftOnly), [
      intent("in-a", { delivers: ["C1.1"], status: "done", acceptance: true }),
    ], landed);
    expect(p.done).toBe(false);
    expect(p.unverifiable).toEqual(["C1.1"]);
  });
});

describe("lintScaffold resolves edges through dependableSlices, like admissibility does", () => {
  const parse = parseCriteria(PRD);

  it("accepts an edge on a criterion only a RETIRED epic carries", () => {
    // The stall this prevents: old units declare no `delivers`, so a mint gate that
    // resolved through units alone refused the first post-cutover scaffold depending on
    // work the previous ladder built — "an edge that can never clear", about an edge that
    // has already cleared.
    const minted = [
      intent("wu-new", { delivers: ["C2.1", "C2.2"], deps: ["C1.1"] }),
    ];
    const retired = [{ id: "ep-old", delivers: ["C1.1", "C1.2"], renders: [], dependsOn: [] }];
    expect(lintScaffold(parse, minted, { scope: ["C2.1", "C2.2"] }).problems.join(LF))
      .toContain("depends on C1.1");
    expect(lintScaffold(parse, minted, { scope: ["C2.1", "C2.2"], dependable: retired }).ok).toBe(true);
  });

  it("does not invent a cycle when a unit appears in both `elsewhere` and `dependable`", () => {
    // Every existing unit is in both — ids for collision, edges for resolution. Counting
    // one twice is how a graph walk manufactures a cycle out of a single node.
    const earlier = intent("wu-earlier", { delivers: ["C1.1", "C1.2"] });
    const minted = [intent("wu-new", { delivers: ["C2.1", "C2.2"], deps: ["C1.1"] })];
    const lint = lintScaffold(parse, minted, {
      scope: ["C2.1", "C2.2"],
      elsewhere: [earlier],
      dependable: [earlier],
    });
    expect(lint.problems.join(LF)).not.toContain("cycle");
    expect(lint.ok).toBe(true);
  });
});
