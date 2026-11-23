import { describe, expect, it } from "vitest";
import { delivered, featuresOfEpics, parseFeatures } from "../src/feature.js";
import { dependableSlices, edgeProblems, inDependencyOrder, satisfied } from "../src/depends.js";
import { lintFeatures } from "../src/narrowing.js";

/** A well-formed epic body: two features, every bullet present, ids explicit. */
const GOOD = `Some prose introducing the epic.

### Feature 1.1: The harness

- **Delivers:** \`C1.1\`
- **Renders:** (none)
- **Depends on:** (none)
- **Acceptance:** (none)

### Feature 1.2: Invoice push

- **Delivers:** \`C1.2\`, \`C1.3\`
- **Renders:** \`C1.1\`
- **Depends on:** \`C1.1\`
- **Acceptance:** (none)
`;

describe("a feature is a feature inside its epic", () => {
  it("reads every feature, in declaration order, with an id it did not have to author", () => {
    const { features, problems } = parseFeatures("ep-ledger", GOOD);
    expect(problems).toEqual([]);
    expect(features.map((t) => t.id)).toEqual(["ep-ledger#1.1", "ep-ledger#1.2"]);
    expect(features.map((t) => t.position)).toEqual([1, 2]);
    expect(features[1]!.title).toBe("Invoice push");
    expect(features[1]!.delivers).toEqual(["C1.2", "C1.3"]);
    expect(features[1]!.renders).toEqual(["C1.1"]);
    expect(features[1]!.dependsOn).toEqual(["C1.1"]);
  });

  it("accepts ids with or without backticks, and is indifferent to which", () => {
    const bare = GOOD.replace(/`/g, "");
    expect(parseFeatures("ep-ledger", bare).problems).toEqual([]);
    expect(delivered(parseFeatures("ep-ledger", bare).features)).toEqual(["C1.1", "C1.2", "C1.3"]);
  });

  it("stops a feature block at the next heading, never swallowing the rest of the document", () => {
    const withTail = `${GOOD}\n## Out of scope\n\n- **Delivers:** \`C9.9\`\n`;
    const { features } = parseFeatures("ep-ledger", withTail);
    expect(features).toHaveLength(2);
    expect(delivered(features)).not.toContain("C9.9");
  });
});

describe("only Delivers counts toward coverage", () => {
  it("a slice that renders everything and delivers nothing delivers nothing", () => {
    // The reason for the split: without it, a UI feature claiming
    // it delivers what it merely displays makes any coverage check pass while the product
    // is unbuilt.
    const ui = `### Feature 2.1: The screen

- **Delivers:** (none)
- **Renders:** \`C1.1\`, \`C1.2\`, \`C1.3\`
- **Depends on:** \`C1.1\`
- **Acceptance:** (none)
`;
    const { features, problems } = parseFeatures("ep-ui", ui);
    expect(problems).toEqual([]);
    expect(delivered(features)).toEqual([]);
    expect(features[0]!.renders).toHaveLength(3);
  });

  it("refuses an id claimed as both delivered and rendered", () => {
    const both = `### Feature 1.1: Confused

- **Delivers:** \`C1.1\`
- **Renders:** \`C1.1\`
- **Depends on:** (none)
- **Acceptance:** (none)
`;
    expect(parseFeatures("ep-x", both).problems.join(" ")).toContain("both Delivers and Renders");
  });
});

describe("the list rules, each bought with a defect elsewhere", () => {
  it("refuses a range instead of expanding it", () => {
    for (const range of ["`C1.1` through `C1.3`", "`C1.1`–`C1.3`", "`C1.1` - `C1.3`"]) {
      const doc = `### Feature 1.1: T\n\n- **Delivers:** ${range}\n- **Renders:** (none)\n- **Depends on:** (none)\n- **Acceptance:** (none)\n`;
      expect(parseFeatures("ep-x", doc).problems.join(" ")).toContain("range");
    }
  });

  it("requires (none) explicitly and refuses an omitted bullet", () => {
    const omitted = `### Feature 1.1: T\n\n- **Delivers:** \`C1.1\`\n- **Depends on:** (none)\n- **Acceptance:** (none)\n`;
    expect(parseFeatures("ep-x", omitted).problems.join(" ")).toContain('missing "- **Renders:**"');

    const blank = `### Feature 1.1: T\n\n- **Delivers:** \`C1.1\`\n- **Renders:**\n- **Depends on:** (none)\n- **Acceptance:** (none)\n`;
    expect(parseFeatures("ep-x", blank).problems.join(" ")).toContain("empty");
  });

  it("refuses prose the parser would silently throw away", () => {
    const prose = `### Feature 1.1: T

- **Delivers:** \`C1.1\` and everything downstream of it
- **Renders:** (none)
- **Depends on:** (none)
- **Acceptance:** (none)
`;
    expect(parseFeatures("ep-x", prose).problems.join(" ")).toContain("ignores");
  });

  it("refuses a misspelled feature bullet that carries ids, rather than skipping it", () => {
    // The silent skip is the failure: a reader sees the ids, the parser does not.
    const typo = `### Feature 1.1: T

- **Delivered:** \`C1.1\`
- **Delivers:** (none)
- **Renders:** (none)
- **Depends on:** (none)
- **Acceptance:** (none)
`;
    expect(parseFeatures("ep-x", typo).problems.join(" ")).toContain("is not one of");
  });

  it("refuses a duplicate bullet, a duplicate feature number, and a self-dependency", () => {
    const twice = `### Feature 1.1: T\n\n- **Delivers:** \`C1.1\`\n- **Delivers:** \`C1.2\`\n- **Renders:** (none)\n- **Depends on:** (none)\n- **Acceptance:** (none)\n`;
    expect(parseFeatures("ep-x", twice).problems.join(" ")).toContain("appears twice");

    const dupNum = `${GOOD}\n### Feature 1.1: Again\n\n- **Delivers:** \`C1.9\`\n- **Renders:** (none)\n- **Depends on:** (none)\n- **Acceptance:** (none)\n`;
    expect(parseFeatures("ep-ledger", dupNum).problems.join(" ")).toContain("declared twice");

    const selfDep = `### Feature 1.1: T\n\n- **Delivers:** \`C1.1\`\n- **Renders:** (none)\n- **Depends on:** \`C1.1\`\n- **Acceptance:** (none)\n`;
    expect(parseFeatures("ep-x", selfDep).problems.join(" ")).toContain("which it delivers itself");
  });
});

describe("an epic with no features is not an epic", () => {
  it("fails rather than reporting an empty set", () => {
    expect(parseFeatures("ep-x", "Just prose, no features.").problems.join(" ")).toContain("declares no features");
  });
});

describe("ids quoted outside a feature block are legal here", () => {
  it("flags them for the observer and refuses nothing", () => {
    const quoting = `The PRD says \`C1.1\` must hold.

### Feature 1.1: T

- **Delivers:** \`C1.1\`
- **Renders:** (none)
- **Depends on:** (none)
- **Acceptance:** (none)
`;
    const { problems, flags } = parseFeatures("ep-x", quoting);
    expect(problems).toEqual([]);
    expect(flags.join(" ")).toContain("outside every feature block");
  });
});

describe("lintFeatures — an epic against the features inside it", () => {
  const epic = {
    id: "ep-ledger", level: "epic" as const, title: "Ledger", status: "active" as const,
    dependsOn: [], delivers: ["C1.1", "C1.2", "C1.3"], renders: [], evidence: [], body: "", source: "", path: "docs/program/epics/ep-ledger.md",
  };

  it("passes when every criterion is delivered by exactly one feature", () => {
    const { features } = parseFeatures("ep-ledger", GOOD);
    const r = lintFeatures(epic, features);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("says RENDERING DELIVERS NOTHING rather than reporting the criterion simply missing", () => {
    // The two have different fixes, so they must not produce the same message.
    const ui = `### Feature 1.1: Screen

- **Delivers:** \`C1.1\`, \`C1.2\`
- **Renders:** \`C1.3\`
- **Depends on:** (none)
- **Acceptance:** (none)
`;
    const { features } = parseFeatures("ep-ledger", ui);
    const r = lintFeatures(epic, features);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("rendering delivers nothing");
  });

  it("treats a rendered criterion the epic does not own as bloat, like a delivered one", () => {
    const outside = `### Feature 1.1: T

- **Delivers:** \`C1.1\`, \`C1.2\`, \`C1.3\`
- **Renders:** \`C9.9\`
- **Depends on:** (none)
- **Acceptance:** (none)
`;
    const { features } = parseFeatures("ep-ledger", outside);
    expect(lintFeatures(epic, features).problems.join(" ")).toContain("C9.9, which ep-ledger does not");
  });

  it("flags a split across features without refusing it", () => {
    const split = `### Feature 1.1: A

- **Delivers:** \`C1.1\`, \`C1.2\`
- **Renders:** (none)
- **Depends on:** (none)
- **Acceptance:** (none)

### Feature 1.2: B

- **Delivers:** \`C1.2\`, \`C1.3\`
- **Renders:** (none)
- **Depends on:** (none)
- **Acceptance:** (none)
`;
    const r = lintFeatures(epic, parseFeatures("ep-ledger", split).features);
    expect(r.ok).toBe(true);
    expect(r.flags.join(" ")).toContain("split across 2 features");
  });
});

describe("the epic declares both lists too, and they have to match its features", () => {
  const epic = (delivers: string[], renders: string[]) => ({
    id: "ep-ui", level: "epic" as const, title: "UI", status: "active" as const,
    dependsOn: [], delivers, renders, evidence: [], body: "", source: "", path: "docs/program/epics/ep-ui.md",
  });

  it("a UI epic that only RENDERS closes no coverage, at the epic level as well", () => {
    // The same defect one rung up, and the one that would otherwise slip through: the
    // feature split is useless if the epic can still claim the criterion as delivered.
    const ui = `### Feature 1.1: Screen

- **Delivers:** (none)
- **Renders:** \`C1.1\`
- **Depends on:** (none)
- **Acceptance:** (none)
`;
    const { features } = parseFeatures("ep-ui", ui);
    const ok = lintFeatures(epic([], ["C1.1"]), features);
    expect(ok.problems, "an epic that only renders it, with a feature that only renders it").toEqual([]);

    const wrong = lintFeatures(epic(["C1.1"], []), features);
    expect(wrong.problems.join(" ")).toContain("rendering delivers nothing");
  });

  it("refuses a feature that BUILDS what its epic says it only shows", () => {
    const builds = `### Feature 1.1: Screen

- **Delivers:** \`C1.1\`
- **Renders:** (none)
- **Depends on:** (none)
- **Acceptance:** (none)
`;
    const { features } = parseFeatures("ep-ui", builds);
    expect(lintFeatures(epic([], ["C1.1"]), features).problems.join(" "))
      .toContain("which ep-ui only renders");
  });

  it("refuses an epic that claims to show something none of its features shows", () => {
    const nothing = `### Feature 1.1: Engine

- **Delivers:** \`C1.1\`
- **Renders:** (none)
- **Depends on:** (none)
- **Acceptance:** (none)
`;
    const { features } = parseFeatures("ep-ui", nothing);
    expect(lintFeatures(epic(["C1.1"], ["C2.1"]), features).problems.join(" "))
      .toContain("C2.1 is rendered by ep-ui and by none of its features");
  });
});

describe("the dependency graph runs on requirements, not on document ids", () => {
  const slice = (id: string, delivers: string[], renders: string[], dependsOn: string[] = []) =>
    ({ id, delivers, renders, dependsOn });

  it("orders a slice after everything that names what it waits on", () => {
    const order = inDependencyOrder([
      slice("categorise", ["C3.1"], [], ["C2.1"]),
      slice("harness", ["C1.1"], []),
      slice("ledger", ["C2.1"], [], ["C1.1"]),
    ]);
    expect(order.map((s) => s.id)).toEqual(["harness", "ledger", "categorise"]);
  });

  it("keeps the given order among slices with no edge between them", () => {
    const order = inDependencyOrder([slice("b", ["C2.1"], []), slice("a", ["C1.1"], []), slice("c", ["C3.1"], [])]);
    expect(order.map((s) => s.id)).toEqual(["b", "a", "c"]);
  });

  it("waits on RENDERS as well as delivers — a slice waiting on a display waits on the renderer", () => {
    // Coverage counts delivers alone; satisfaction counts both, and the two readers
    // disagreeing on purpose is the whole of ADR-0004's satisfaction note.
    const slices = [slice("screen", [], ["C1.1"]), slice("reader", ["C2.1"], [], ["C1.1"])];
    expect(inDependencyOrder(slices).map((s) => s.id)).toEqual(["screen", "reader"]);
  });

  it("satisfies a criterion only when EVERY slice naming it is done", () => {
    // A criterion split across two slices is legal and flagged. Admitting a dependent when
    // the first of them merges admits it against half of what it asked for — the same
    // composition the feature rung already paid for, where "served" meant "some intent
    // names it" and the first batch of three finished a feature holding more.
    const slices = [slice("a", ["C1.1"], []), slice("b", ["C1.1"], []), slice("c", ["C2.1"], [])];
    const done = new Set(["a", "c"]);
    const got = satisfied(slices, (s) => done.has(s.id));
    expect([...got].sort()).toEqual(["C2.1"]);
    expect(satisfied(slices, (s) => s.id !== "zzz").has("C1.1")).toBe(true);
  });

  it("a criterion nothing names is NOT satisfied — an edge that can never clear", () => {
    expect(satisfied([slice("a", ["C1.1"], [])], () => true).has("C9.9")).toBe(false);
    expect(edgeProblems([slice("a", ["C1.1"], [], ["C9.9"])], "epic").join(" "))
      .toContain("depends on C9.9, which no epic delivers or renders");
  });

  it("refuses a cycle rather than inventing a winner", () => {
    const tangle = [slice("a", ["C1.1"], [], ["C2.1"]), slice("b", ["C2.1"], [], ["C1.1"])];
    expect(edgeProblems(tangle, "epic").join(" ")).toContain("cycle among a, b");
    // ...and the order function hands them back rather than picking, which is what lets
    // the gate above explain it.
    expect(inDependencyOrder(tangle)).toHaveLength(2);
  });

  it("refuses a slice that waits on its own work", () => {
    expect(edgeProblems([slice("a", ["C1.1"], [], ["C1.1"])], "epic").join(" "))
      .toContain("depends on C1.1, which it names itself");
  });
});

const LF = String.fromCharCode(10);
const BT = String.fromCharCode(96);

describe("a feature's acceptance — the rung that owns the ratchet (ADR-0003)", () => {
  const withChecks = (checks: string): string =>
    "### Feature 1.1: Invoice push" + LF + LF
    + "- **Delivers:** " + BT + "C1.1" + BT + LF
    + "- **Renders:** (none)" + LF
    + "- **Depends on:** (none)" + LF
    + "- **Acceptance:**" + LF
    + checks;

  it("reads each sub-bullet as a command and what passing it shows", () => {
    const doc = withChecks(
      "  - " + BT + "npm run e2e -- invoice-push" + BT + " — a pushed invoice appears in the ledger" + LF
      + "  - " + BT + "npm test -- push" + BT + " — the push module's own suite passes" + LF,
    );
    const { features, problems } = parseFeatures("ep-x", doc);
    expect(problems).toEqual([]);
    // The command survives a dash inside it, because the separator is looked for AFTER the
    // closing backtick. Split on the first dash and `npm test -- push` grades as `npm test`.
    expect(features[0]!.acceptance).toEqual([
      { kind: "command", run: "npm run e2e -- invoice-push", expect: "a pushed invoice appears in the ledger" },
      { kind: "command", run: "npm test -- push", expect: "the push module's own suite passes" },
    ]);
  });

  it("refuses an omitted bullet, and takes (none) as the way to say a feature has none", () => {
    const omitted = "### Feature 1.1: T" + LF + LF
      + "- **Delivers:** " + BT + "C1.1" + BT + LF + "- **Renders:** (none)" + LF + "- **Depends on:** (none)" + LF;
    expect(parseFeatures("ep-x", omitted).problems.join(" ")).toContain('missing "- **Acceptance:**"');

    const none = "### Feature 1.1: T" + LF + LF
      + "- **Delivers:** " + BT + "C1.1" + BT + LF + "- **Renders:** (none)" + LF
      + "- **Depends on:** (none)" + LF + "- **Acceptance:** (none)" + LF;
    const r = parseFeatures("ep-x", none);
    expect(r.problems).toEqual([]);
    expect(r.features[0]!.acceptance).toEqual([]);
  });

  it("refuses (none) written above a list of checks, rather than believing one of them", () => {
    // The silent resolution is the danger: believe the list and a feature is graded
    // against checks its author disowned; believe the word and the checks vanish.
    const doc = "### Feature 1.1: T" + LF + LF
      + "- **Delivers:** " + BT + "C1.1" + BT + LF + "- **Renders:** (none)" + LF
      + "- **Depends on:** (none)" + LF + "- **Acceptance:** (none)" + LF
      + "  - " + BT + "npm test" + BT + " — it passes" + LF;
    expect(parseFeatures("ep-x", doc).problems.join(" ")).toContain("one of the two is wrong");
  });

  it("refuses a bullet with neither checks nor (none) — never nothing", () => {
    expect(parseFeatures("ep-x", withChecks("")).problems.join(" "))
      .toContain("carries no checks");
  });

  it("refuses a check on the bullet itself instead of beneath it", () => {
    const doc = "### Feature 1.1: T" + LF + LF
      + "- **Delivers:** " + BT + "C1.1" + BT + LF + "- **Renders:** (none)" + LF
      + "- **Depends on:** (none)" + LF
      + "- **Acceptance:** " + BT + "npm test" + BT + " — it passes" + LF;
    expect(parseFeatures("ep-x", doc).problems.join(" "))
      .toContain("the checks go in indented sub-bullets");
  });

  it("names a sub-bullet it cannot read rather than dropping it", () => {
    // Dropping it is the failure that matters: the feature then grades green against the
    // checks that happened to parse, and the one nobody could read is not run at all.
    const doc = withChecks("  - run the end to end suite and see that it passes" + LF);
    const problems = parseFeatures("ep-x", doc).problems.join(" ");
    expect(problems).toContain("cannot read");
    expect(problems).toContain("run the end to end suite");
  });

  it("stops the list at the next feature, so one feature's checks are never another's", () => {
    const doc = withChecks("  - " + BT + "npm test" + BT + " — it passes" + LF)
      + LF + "### Feature 1.2: Second" + LF + LF
      + "- **Delivers:** " + BT + "C1.2" + BT + LF + "- **Renders:** (none)" + LF
      + "- **Depends on:** (none)" + LF + "- **Acceptance:** (none)" + LF;
    const { features, problems } = parseFeatures("ep-x", doc);
    expect(problems).toEqual([]);
    expect(features[0]!.acceptance).toHaveLength(1);
    expect(features[1]!.acceptance).toEqual([]);
  });
});

describe("a retired epic is not asked for features", () => {
  // `status: done` means the work was completed under the previous ladder. Its coverage
  // still counts; nothing else is asked of it. Without this, a target's seven epics —
  // which predate feature headings entirely — report malformed for ever, and the malformed
  // check returns before the chain is consulted, so the loop stalls the first tick after
  // its last intent finishes. Nothing red, nothing spent, nothing happening.
  const bare = { id: "ep-old", body: "Prose narrowing the PRD, with no feature heading anywhere." };

  it("reports it as a flag, not a problem", () => {
    const r = featuresOfEpics([{ ...bare, status: "done" }]);
    expect(r.problems).toEqual([]);
    expect(r.features).toEqual([]);
    expect(r.flags.join(" ")).toContain("retired");
  });

  it("still refuses the same epic while it is active", () => {
    const r = featuresOfEpics([{ ...bare, status: "active" }]);
    expect(r.problems.join(" ")).toContain("declares no features");
  });

  it("refuses it when no status is given at all — retirement is explicit or it is not retirement", () => {
    expect(featuresOfEpics([bare]).problems.join(" ")).toContain("declares no features");
  });

  it("does not let a retired epic hide a live sibling's defect", () => {
    // The failure mode of a skip: one document's exemption quietly covering another's.
    const r = featuresOfEpics([
      { ...bare, status: "done" },
      { id: "ep-live", body: "No heading here either.", status: "active" },
    ]);
    expect(r.problems.join(" ")).toContain("ep-live");
    expect(r.problems.join(" ")).not.toContain("ep-old");
  });
});

describe("dependableSlices — one definition of what a dependency resolves against", () => {
  // Measured on a target before this was written: 18 criteria claimed by done
  // intents, three still being built (C2.7, C10.1, C10.3), and three retired epics narrowed to
  // exactly what the old ladder planned — so each retired epic names the in-flight three as
  // DONE. This fixture is that shape in miniature.
  const epic = { id: "ep-old", status: "done", delivers: ["C1.1", "C1.2"], renders: [] };
  const built = { id: "in-built", status: "done", delivers: ["C1.1"], renders: [], dependsOn: [] };
  const building = { id: "in-building", status: "decomposed", delivers: ["C1.2"], renders: [], dependsOn: [] };

  it("satisfies what the previous ladder built", () => {
    const s = satisfied(dependableSlices([epic], [built, building], []), (x) => x.done);
    expect(s.has("C1.1")).toBe(true);
  });

  it("does NOT satisfy what a retired epic claims while its intent is still being built", () => {
    // "Every, not any" — and it can only hold if the intent is IN the set. Measured on the
    // real tree: remove the intents and all three in-flight criteria read satisfied.
    const s = satisfied(dependableSlices([epic], [built, building], []), (x) => x.done);
    expect(s.has("C1.2")).toBe(false);
  });

  it("and that is exactly what goes wrong without the intents", () => {
    // Pinned so that deleting the intent dialect before the in-flight intents finish is a
    // failing test rather than a quiet admission of work against an unbuilt requirement.
    const s = satisfied(dependableSlices([epic], [], []), (x) => x.done);
    expect(s.has("C1.2")).toBe(true);
  });

  it("ignores an ACTIVE epic — its doneness is graded, not stored", () => {
    // Listing it with done: false would hold every dependent on it unsatisfied for ever;
    // its criteria are named by its own units, which is where satisfaction comes from.
    const active = { ...epic, status: "active" };
    const unit = { id: "wu-a", status: "merged", delivers: ["C1.1"], renders: [], dependsOn: [] };
    const s = satisfied(dependableSlices([active], [], [unit]), (x) => x.done);
    expect(s.has("C1.1")).toBe(true);
    expect(dependableSlices([active], [], []).length).toBe(0);
  });

  it("counts a unit only once it has merged", () => {
    const unit = { id: "wu-a", status: "ready", delivers: ["C1.1"], renders: [], dependsOn: [] };
    expect(satisfied(dependableSlices([], [], [unit]), (x) => x.done).has("C1.1")).toBe(false);
  });
});

describe("an escalated unit is not a source of anything (PR #96 review, round two)", () => {
  const u = (id: string, status: string, delivers: string[]) =>
    ({ id, status, delivers, renders: [] as string[], dependsOn: [] as string[] });

  it("a replacement that MERGED satisfies the criterion its escalated predecessor claimed", () => {
    // The ratchet's own recovery path, and it was frozen. Counted as a namer, the escalated
    // unit was never done, so "every, not any" held C9.1 unsatisfied for ever — its dependents
    // neither admissible nor stranded — after the replacement had built it.
    const s = satisfied(dependableSlices([], [], [u("wu-first", "escalated", ["C9.1"]), u("wu-replacement", "merged", ["C9.1"])]), (x) => x.done);
    expect(s.has("C9.1")).toBe(true);
  });

  it("a criterion ONLY an escalated unit claimed is absent — unsatisfied, and not on offer", () => {
    const set = dependableSlices([], [], [u("wu-first", "escalated", ["C9.1"])]);
    expect(set.length).toBe(0);
    expect(satisfied(set, (x) => x.done).has("C9.1")).toBe(false);
  });
});
