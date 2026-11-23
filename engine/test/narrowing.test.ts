import { describe, expect, it } from "vitest";
import { parseCriteria } from "../src/coverage.js";
import type { Feature } from "../src/feature.js";
import {
  inServeOrder,
  lintChildren,
  lintEpics,
  nextChainNeed,
  parseNarrowing,
  servedFeatures,
  type Narrowing,
} from "../src/narrowing.js";

const PRD = `# PRD

### C1. Ledger

- **machine** \`C1.1\` Import produces the fixture's expected lines.
- **machine** \`C1.2\` Close with one uncategorized line refuses.

### C2. Categorization

- **machine** \`C2.1\` Rule replay assigns every approved category.
- **machine** \`C2.2\` An unmatched transaction lands in Attention.
`;

function doc(
  id: string,
  opts: { level?: string; parent?: string; delivers?: string[]; status?: string; dependsOn?: string[] } = {},
): Narrowing {
  const lines = [
    "---",
    `id: ${id}`,
    `level: ${opts.level ?? "epic"}`,
    `title: ${id}`,
    `status: ${opts.status ?? "active"}`,
    ...(opts.parent !== undefined ? [`parent: ${opts.parent}`] : []),
    ...(opts.dependsOn !== undefined ? [`depends_on: [${opts.dependsOn.join(", ")}]`] : []),
    `delivers: [${(opts.delivers ?? ["C1.1"]).join(", ")}]`,
    "---",
    "body",
  ];
  const res = parseNarrowing(lines.join("\n"), `docs/program/${id}.md`);
  if (!res.ok) throw new Error(`fixture must parse: ${res.errors.join("; ")}`);
  return res.narrowing;
}

describe("parseNarrowing — one artifact, two levels", () => {
  it("reads an epic", () => {
    const e = doc("ep-ledger", { delivers: ["C1.1", "C1.2"] });
    expect(e.level).toBe("epic");
    expect(e.parent).toBeUndefined();
    expect(e.delivers).toEqual(["C1.1", "C1.2"]);
  });

  it("reads an epic's own acceptance — the functional suite, one rung above the feature's", () => {
    const src = [
      "---", "id: ep-ledger", "level: epic", "title: Ledger", "status: active",
      "delivers: [C1.1]",
      "evidence:",
      "  - kind: command",
      '    run: "npm run e2e -- close"', '    expect: "a month closes end to end"',
      "---", "body",
    ].join(String.fromCharCode(10));
    const res = parseNarrowing(src, "docs/program/epics/ep-ledger.md");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.narrowing.evidence).toEqual([
      { kind: "command", run: "npm run e2e -- close", expect: "a month closes end to end" },
    ]);
  });

  it("reads an epic with no acceptance at all, because every epic written before ADR-0003 has none", () => {
    // Not a parse error and not a vacuous pass. The grade is what refuses to close an
    // epic with nothing to run; a parser cannot know which levels are owed acceptance.
    expect(doc("ep-old").evidence).toEqual([]);
  });

  it("refuses acceptance that is malformed rather than reading past it", () => {
    const src = [
      "---", "id: ep-ledger", "level: epic", "title: Ledger", "status: active",
      "delivers: [C1.1]",
      "evidence:",
      "  - kind: incantation",
      '    run: ""', '    expect: "something"',
      "---", "body",
    ].join(String.fromCharCode(10));
    const res = parseNarrowing(src, "docs/program/epics/ep-ledger.md");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join(" ")).toContain("kind must be one of");
    expect(res.errors.join(" ")).toContain("run must be a non-empty command");
  });

  it("reads a feature and its parent", () => {
    const f = doc("ft-import", { level: "feature", parent: "ep-ledger" });
    expect(f.level).toBe("feature");
    expect(f.parent).toBe("ep-ledger");
  });

  it("refuses a feature with no epic — an orphan no coverage check can reach", () => {
    const res = parseNarrowing(
      ["---", "id: ft-x", "level: feature", "title: t", "status: active", "delivers: [C1.1]", "---", "b"].join("\n"),
      "docs/program/ft-x.md",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("must name the epic it belongs to");
  });

  it("refuses an epic that claims a parent — it narrows the program, which has no id", () => {
    const res = parseNarrowing(
      ["---", "id: ep-x", "level: epic", "title: t", "status: active", "parent: ep-y", "delivers: [C1.1]", "---", "b"].join("\n"),
      "docs/program/ep-x.md",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("an epic has no parent");
  });

  it("refuses a narrowing that delivers nothing — unlike an intent, it has no structural case", () => {
    const res = parseNarrowing(
      ["---", "id: ep-x", "level: epic", "title: t", "status: active", "---", "b"].join("\n"),
      "docs/program/ep-x.md",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("criterion ids it delivers");
  });
});

describe("hop 1 — epics against the program", () => {
  const parse = parseCriteria(PRD);

  it("passes when the epics account for every criterion", () => {
    const lint = lintEpics(parse, [doc("ep-a", { delivers: ["C1.1", "C1.2"] }), doc("ep-b", { delivers: ["C2.1", "C2.2"] })]);
    expect(lint.problems).toEqual([]);
    expect(lint.ok).toBe(true);
  });

  it("fails a criterion no epic takes", () => {
    const lint = lintEpics(parse, [doc("ep-a", { delivers: ["C1.1", "C1.2", "C2.1"] })]);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(" ")).toContain("C2.2");
  });

  it("fails an epic claiming a criterion the PRD does not contain", () => {
    const lint = lintEpics(parse, [doc("ep-a", { delivers: ["C1.1", "C1.2", "C2.1", "C2.2", "C9.9"] })]);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(" ")).toContain("C9.9");
  });
});


describe("hop 3 — children against their feature", () => {
  // `lintChildren` takes a shape, not a document — the same reason `items` is a shape.
  const feature = { id: "ft-import", delivers: ["C1.1", "C1.2"] };

  it("passes when the children account for the whole feature", () => {
    const lint = lintChildren(feature, [
      { id: "in-a", delivers: ["C1.1"] },
      { id: "in-b", delivers: ["C1.2"] },
    ]);
    expect(lint.ok).toBe(true);
  });

  it("fails a criterion no child takes", () => {
    const lint = lintChildren(feature, [{ id: "in-a", delivers: ["C1.1"] }]);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(" ")).toContain("C1.2");
  });

  it("fails scope from outside the feature", () => {
    const lint = lintChildren(feature, [
      { id: "in-a", delivers: ["C1.1"] },
      { id: "in-b", delivers: ["C1.2", "C2.1"] },
    ]);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(" ")).toContain("outside the feature");
  });

  it("reports a structural child rather than refusing it — unlike a narrowing", () => {
    // An intent can be real work that grades no criterion (a test harness, a table the
    // categories point at). Forcing it to name one is coverage typed into existence.
    const lint = lintChildren(feature, [
      { id: "in-a", delivers: ["C1.1"] },
      { id: "in-b", delivers: ["C1.2"] },
      { id: "in-harness", delivers: [] },
    ]);
    expect(lint.ok).toBe(true);
    expect(lint.flags.join(" ")).toContain("in-harness delivers no criterion");
  });

  it("does not let a structural child excuse an uncovered criterion", () => {
    const lint = lintChildren(feature, [{ id: "in-a", delivers: ["C1.1"] }, { id: "in-harness", delivers: [] }]);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(" ")).toContain("C1.2");
  });
});

describe("serve order — the chain builds the ladder, not the alphabet", () => {
  // The defect this exists for, measured on a target. `nextChainNeed` walked
  // epics in store order, which is `readdir`, which is alphabetical — so it began at
  // `ep-categorisation-and-judgment` (PRD §5 step 3) while `ep-hours-to-invoice` (steps 0-1,
  // the harness) and `ep-ledger-and-close` (step 2) had not been started. The first intent it
  // cut needed a `matches` table the step-2 slice owns; three units were built and merged and
  // the intent still could not pass, because three of the eight modules its acceptance
  // imports belonged to slices that did not exist.
  it("serves a slice AFTER everything it waits on, whatever the alphabet says", () => {
    // The edges name REQUIREMENTS, not documents: categorisation waits on what the ledger
    // slice delivers, and the ledger on what the harness delivers. Nothing names an id.
    const order = inServeOrder([
      doc("ep-categorisation", { delivers: ["C2.1"], dependsOn: ["C1.2"] }),
      doc("ep-hours", { delivers: ["C1.1"] }),
      doc("ep-ledger", { delivers: ["C1.2"], dependsOn: ["C1.1"] }),
    ]);
    expect(order.map((d) => d.id)).toEqual(["ep-hours", "ep-ledger", "ep-categorisation"]);
  });

  it("keeps store order among slices with no edge between them — one `depends_on:` moves one thing", () => {
    const order = inServeOrder([doc("ep-a"), doc("ep-b"), doc("ep-c")]);
    expect(order.map((d) => d.id)).toEqual(["ep-a", "ep-b", "ep-c"]);
  });

  it("hands a CYCLE back rather than inventing a winner", () => {
    // Resolving it here would schedule a program whose own graph is impossible and report
    // nothing. `reviewEpicSet` refuses it instead, with the members named.
    const order = inServeOrder([doc("ep-a", { dependsOn: ["ep-b"] }), doc("ep-b", { dependsOn: ["ep-a"] })]);
    expect(order.map((d) => d.id)).toEqual(["ep-a", "ep-b"]);
  });

  it("treats an edge to a document that is not here as satisfied, and does not stall", () => {
    // Also not this function's to judge: the set review says so with the whole set in hand.
    const order = inServeOrder([doc("ep-a", { dependsOn: ["ep-gone"] }), doc("ep-b")]);
    expect(order.map((d) => d.id)).toEqual(["ep-a", "ep-b"]);
  });


  it("...and orders FEATURES by where their author wrote them, not by name", () => {
    // Features carry no `after:` because they need none: they are headings in one
    // document, and their order in it IS the order they were written in. That is what
    // puts the scaffold first — it is feature 1 of epic 1, where its author put it.
    const epic = doc("ep-a", { delivers: ["C1.1", "C1.2"] });
    const need = nextChainNeed({
      criteria: ["C1.1", "C1.2"],
      epics: [epic],
      features: [feat("ft-queue", "ep-a", ["C1.2"], 1), feat("ft-alias", "ep-a", ["C1.1"], 2)],
      servedFeatures: new Set<string>(),
    });
    expect(need.kind).toBe("children");
    if (need.kind === "children") expect(need.feature.id, "declared first, served first").toBe("ft-queue");
  });
});


/**
 * A feature, as the chain sees one: parsed out of an epic, so it carries the epic it came
 * from and its position in that document rather than a `parent` and a `depends_on`.
 */
const feat = (id: string, epic: string, delivers: string[], position = 1): Feature => ({
  id, epic, number: `1.${position}`, title: id, delivers, renders: [], dependsOn: [], acceptance: [], position,
});

describe("nextChainNeed — what the chain owes, computed not decided", () => {
  const st = (o: Partial<Parameters<typeof nextChainNeed>[0]>) => nextChainNeed({
    criteria: ["C1.1", "C1.2", "C2.1", "C2.2"],
    epics: [], features: [], servedFeatures: new Set<string>(), ...o,
  });

  it("asks for an epic while any criterion is unclaimed", () => {
    const need = st({ epics: [doc("ep-a", { delivers: ["C1.1", "C1.2"] })] });
    expect(need.kind).toBe("epic");
    if (need.kind === "epic") expect(need.covered.sort()).toEqual(["C1.1", "C1.2"]);
  });

  it("finishes the epic layer before cutting any feature", () => {
    // A feature cut from a half-drawn epic layer is cut from a document still moving:
    // the slice boundaries shift underneath work already done.
    const need = st({
      epics: [doc("ep-a", { delivers: ["C1.1", "C1.2"] })],
      features: [feat("ft-a", "ep-a", ["C1.1"])],
    });
    expect(need.kind).toBe("epic");
  });



  it("asks for children only when every epic's features are complete", () => {
    const need = st({
      epics: [doc("ep-a", { delivers: ["C1.1", "C1.2"] }), doc("ep-b", { delivers: ["C2.1", "C2.2"] })],
      features: [
        feat("ft-a", "ep-a", ["C1.1", "C1.2"]),
        feat("ft-b", "ep-b", ["C2.1", "C2.2"]),
      ],
    });
    expect(need.kind).toBe("children");
    if (need.kind === "children") expect(need.feature.id).toBe("ft-a");
  });

  it("moves to the next unserved feature, and reports complete when none is left", () => {
    const features = [
      feat("ft-a", "ep-a", ["C1.1", "C1.2"]),
      feat("ft-b", "ep-b", ["C2.1", "C2.2"]),
    ];
    const epics = [doc("ep-a", { delivers: ["C1.1", "C1.2"] }), doc("ep-b", { delivers: ["C2.1", "C2.2"] })];
    const one = st({ epics, features, servedFeatures: new Set(["ft-a"]) });
    expect(one.kind).toBe("children");
    if (one.kind === "children") expect(one.feature.id).toBe("ft-b");
    expect(st({ epics, features, servedFeatures: new Set(["ft-a", "ft-b"]) }).kind).toBe("complete");
  });
});

describe("an unmeasurable program is loud, not complete", () => {
  it("refuses to call a criterion-less program finished", () => {
    // Caught by the tick tests rather than by design: coverage over an empty set is
    // vacuously satisfied at EVERY hop, so a PRD whose criteria carry no ids reported the
    // chain complete, skipped every rung beneath it, and idled with the program unbuilt.
    // The silent no-op is the worst failure available to an unattended loop.
    const need = nextChainNeed({ criteria: [], epics: [], features: [], servedFeatures: new Set() });
    expect(need.kind).toBe("unmeasurable");
    if (need.kind === "unmeasurable") expect(need.detail).toContain("no identified criteria");
  });
});

describe("servedFeatures — served means COVERED, not merely touched", () => {
  const feature = feat("ft-big", "ep-a", ["C1.1", "C1.2", "C2.1"]);

  it("does NOT count a feature served because one intent names it", () => {
    // The hole external review found, and neither half looked wrong alone. The intent
    // ceiling is three, so a feature holding more criteria legitimately takes several
    // ACTs — which is why a judge reporting outstanding slices is a PASS. Compose that
    // with "served = some intent names it" and the first batch finishes the feature:
    // the chain never returns, the rest reach no intent, and it reports complete.
    const served = servedFeatures([feature], [{ id: "in-a", parent: "ft-big", delivers: ["C1.1"] }]);
    expect(served.has("ft-big")).toBe(false);
  });

  it("counts it served once its intents cover all of it", () => {
    const served = servedFeatures([feature], [
      { id: "in-a", parent: "ft-big", delivers: ["C1.1", "C1.2"] },
      { id: "in-b", parent: "ft-big", delivers: ["C2.1"] },
    ]);
    expect(served.has("ft-big")).toBe(true);
  });

  it("has no status to short-circuit it — served is computed, or it is not served", () => {
    // A feature is part of its epic and carries no status of its own, so there is no
    // `done` flag to set and nothing to forget to set. A feature with no children is not
    // served, however finished it looks.
    expect(servedFeatures([feat("ft-done", "ep-a", ["C1.1"])], []).has("ft-done")).toBe(false);
  });

  it("ignores intents belonging to a different feature", () => {
    const served = servedFeatures([feature], [{ id: "in-x", parent: "ft-other", delivers: ["C1.1", "C1.2", "C2.1"] }]);
    expect(served.has("ft-big")).toBe(false);
  });

  it("so the chain keeps returning to a partly-planned feature", () => {
    const epic = doc("ep-a", { delivers: ["C1.1", "C1.2", "C2.1"] });
    const kids = [{ id: "in-a", parent: "ft-big", delivers: ["C1.1"] }];
    const need = nextChainNeed({
      criteria: ["C1.1", "C1.2", "C2.1"],
      epics: [epic],
      features: [feature],
      servedFeatures: servedFeatures([feature], kids),
    });
    expect(need.kind).toBe("children");
    if (need.kind === "children") expect(need.feature.id).toBe("ft-big");
  });
});
