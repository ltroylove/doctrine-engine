import { describe, expect, it } from "vitest";
import { parseIntent } from "../src/intent.js";
import { isAdmissible, lintBuildOut, parseWorkUnit } from "../src/work-unit.js";

const VALID = `---
id: wu-2026-08-20-fix-rounding
title: Fix macro rounding in the summary card
tier: reversible
status: ready
budget_usd: 5
depends_on: [wu-2026-08-19-schema]
evidence:
  - kind: test
    run: "pnpm vitest run test/rounding.test.ts"
    expect: "fails on base, passes on head"
  - kind: command
    run: "pnpm lint && pnpm build"
    expect: "exit 0 on head"
---
Round to one decimal in the summary card only. Out of scope: the CSV export.
`;

const NO_EVIDENCE = `---
id: wu-2026-08-20-vibes
title: Make the dashboard nicer
tier: reversible
status: ready
budget_usd: 5
---
Just improve it.
`;

const DRAFT = `---
id: wu-2026-08-20-draft
title: Persist swaps
tier: irreversible
status: draft
budget_usd: 10
evidence:
  - kind: test
    run: "pnpm vitest run test/swaps.test.ts"
    expect: "insert path covered"
---
Waiting on decompose.
`;

const LF = String.fromCharCode(10);

/** A unit document from a list of frontmatter lines, so no fixture needs an escaped newline. */
function unitDoc(fields: string[], body = "b"): string {
  return ["---", "id: wu-x", "title: t", "tier: reversible", "budget_usd: 5", ...fields, "---", body, ""].join(LF);
}

const EVIDENCE = ['evidence:', '  - kind: command', '    run: "pnpm test"', '    expect: "exit 0"'];

describe("a unit declares its own coverage", () => {
  // The collapse ADR-0001 makes possible. Until now only an INTENT said what it delivered,
  // so a unit's `depends_on` had to resolve one level up: a criterion was satisfied when
  // every intent naming it was done. The thing that declares `delivers` and the thing that
  // gets built are becoming one, and this is the half of it the parser can see.

  it("reads delivers, renders, depends_on and the feature it belongs to", () => {
    const res = parseWorkUnit(unitDoc([
      "status: ready", "parent: ep-invoicing#1.2",
      "delivers: [C3.1, C3.2]", "renders: [C4.1]", "depends_on: [C1.1]",
      ...EVIDENCE,
    ]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.unit.delivers).toEqual(["C3.1", "C3.2"]);
    expect(res.unit.renders).toEqual(["C4.1"]);
    expect(res.unit.dependsOn).toEqual(["C1.1"]);
    expect(res.unit.parent).toBe("ep-invoicing#1.2");
  });

  it("refuses a criterion claimed as both delivered and rendered", () => {
    const res = parseWorkUnit(unitDoc(["status: ready", "delivers: [C3.1]", "renders: [C3.1]", ...EVIDENCE]));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join(" ")).toContain("is in both delivers and renders");
  });

  it("still reads a unit written before any of these fields existed", () => {
    // ~90 merged units on one target have no level, no parent, no delivers. A parser
    // reads what exists; a MINT GATE refuses what may be created. Strictness here would
    // leave the loop unable to read its own merged work.
    const res = parseWorkUnit(VALID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.unit.delivers).toEqual([]);
    expect(res.unit.renders).toEqual([]);
    expect(res.unit.parent).toBeUndefined();
  });

  it("refuses a level that is not a unit, so an intent handed to this parser is caught", () => {
    const res = parseWorkUnit(unitDoc(["status: ready", "level: intent", "delivers: [C3.1]", ...EVIDENCE]));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join(" ")).toContain('level "intent" is not a unit');
  });
});

describe("one status vocabulary, gated by dialect", () => {
  // The claim the single enum rests on. `WORK_STATUSES` holds the union because one type
  // cannot have two enums; UNIT_STATUSES and INTENT_STATUSES are what keep the two
  // spellings apart. Asserted rather than argued: the argument lives in a commit message
  // and a comment, and neither of those fails when somebody widens the wrong list.

  it("refuses an intent-only status on a unit document", () => {
    for (const legacy of ["proposed", "decomposed", "done"]) {
      const res = parseWorkUnit(unitDoc([`status: ${legacy}`, ...EVIDENCE]));
      expect(res.ok, legacy).toBe(false);
      if (res.ok) continue;
      expect(res.errors.join(" ")).toContain("status must be one of");
    }
  });

  it("and the intent dialect refuses a unit-only status", () => {
    for (const unitOnly of ["draft", "in-progress", "verified", "in-review", "merged", "escalated"]) {
      const res = parseIntent([
        "---", "id: in-x", "title: t", `status: ${unitOnly}`,
        "budget_usd: 10", "tier_default: reversible", "---", "b", "",
      ].join(LF));
      expect(res.ok, unitOnly).toBe(false);
      if (res.ok) continue;
      expect(res.errors.join(" ")).toContain("status must be one of");
    }
  });

  it("and `scaffold` is the one status both dialects share, because it means the same thing", () => {
    expect(parseWorkUnit(unitDoc(["status: scaffold"])).ok).toBe(true);
    expect(parseIntent([
      "---", "id: in-x", "title: t", "status: scaffold",
      "budget_usd: 10", "tier_default: reversible", "---", "b", "",
    ].join(LF)).ok).toBe(true);
  });
});

describe("the scaffold half of a unit", () => {
  const scaffold = (extra: string[] = []) =>
    parseWorkUnit(unitDoc(["status: scaffold", "parent: ep-invoicing#1.2", "delivers: [C3.1]", ...extra], "Why this slice exists."));

  it("is a status a unit may hold, carrying coverage and no evidence", () => {
    const res = scaffold();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.unit.status).toBe("scaffold");
    expect(res.unit.delivers).toEqual(["C3.1"]);
  });

  it("refuses evidence, because a probe written before the tree exists is a guess", () => {
    const res = scaffold(EVIDENCE);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join(" ")).toContain("must carry no evidence");
  });

  it("is not admissible: the loop takes ready units, and a scaffold has nothing to check", () => {
    const res = scaffold();
    if (!res.ok) throw new Error("fixture");
    const verdict = isAdmissible(res.unit, new Set());
    expect(verdict.admissible).toBe(false);
    if (verdict.admissible) return;
    expect(verdict.reasons.join(" ")).toContain('status is "scaffold"');
  });
});
describe("the append contract — build-out writes below the scaffold", () => {
  // ADR-0001. A unit is minted with its epic as a scaffold and built out just-in-time;
  // the freeze is what keeps the two halves meaning different things. An `## Intent`
  // rewritten to match what was built is the ratchet running backwards.
  const SCAFFOLD = [
    "---", "id: wu-x", "title: Invoice push", "tier: reversible", "budget_usd: 11",
    "status: scaffold", "parent: ep-invoicing#1.2",
    "delivers: [C3.1]", "renders: [C4.1]", "depends_on: [C1.1]",
    "---", "## Intent", "", "Invoices are pushed by hand today.", "",
  ].join(LF);

  /** What a well-behaved ACT produces: `evidence` added, prose appended, status drafted. */
  const built = (fields: string[] = [], body: string[] = ["## Spec", "", "Add the push."]) => [
    "---", "id: wu-x", "title: Invoice push", "tier: reversible", "budget_usd: 11",
    "status: draft", "parent: ep-invoicing#1.2",
    "delivers: [C3.1]", "renders: [C4.1]", "depends_on: [C1.1]",
    ...fields,
    "evidence:", "  - kind: command", '    run: "pnpm test"', '    expect: "exit 0"',
    "---", "## Intent", "", "Invoices are pushed by hand today.", "", ...body, "",
  ].join(LF);

  it("accepts a spec appended below both halves", () => {
    const lint = lintBuildOut(SCAFFOLD, built());
    expect(lint.problems).toEqual([]);
    expect(lint.ok).toBe(true);
  });

  it("refuses a rewritten `## Intent`, which is the ratchet running backwards", () => {
    const rewritten = built().replace("Invoices are pushed by hand today.", "Invoices are pushed by the new sync step.");
    const lint = lintBuildOut(SCAFFOLD, rewritten);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(" ")).toContain("body is not a prefix");
  });

  it("refuses a widened `delivers`, which no additions-only diff rule would catch", () => {
    // The case that makes the VALUE rule load-bearing rather than decorative: a line
    // slipped into a block list is an addition, and it silently widens coverage.
    const widened = built().replace("delivers: [C3.1]", ["delivers:", "  - C3.1", "  - C3.2"].join(LF));
    const lint = lintBuildOut(SCAFFOLD, widened);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(" ")).toContain("changed `delivers` from [C3.1] to [C3.1, C3.2]");
  });

  it("refuses a narrowed `depends_on` — dropping an edge is as much a rewrite as adding one", () => {
    const lint = lintBuildOut(SCAFFOLD, built().replace("depends_on: [C1.1]", "depends_on: []"));
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(" ")).toContain("changed `depends_on`");
  });

  it("refuses a field the scaffold declared and the build-out deleted", () => {
    // What a frontmatter-PREFIX rule cannot see: nothing before the deletion moved.
    const lint = lintBuildOut(SCAFFOLD, built().replace("renders: [C4.1]" + LF, ""));
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(" ")).toContain("dropped `renders`");
  });

  it("refuses a field the build-out invented, because only `evidence` is spec", () => {
    const lint = lintBuildOut(SCAFFOLD, built(["landing: pr"]));
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(" ")).toContain("added `landing`");
  });

  it("does not care where in the frontmatter `evidence` was written", () => {
    // A formatting opinion, not a violation. The rules are about keys and values, which is
    // why this passes and the deletion above does not.
    const reordered = [
      "---", "evidence:", "  - kind: command", '    run: "pnpm test"', '    expect: "exit 0"',
      "id: wu-x", "title: Invoice push", "tier: reversible", "budget_usd: 11",
      "status: draft", "parent: ep-invoicing#1.2",
      "delivers: [C3.1]", "renders: [C4.1]", "depends_on: [C1.1]",
      "---", "## Intent", "", "Invoices are pushed by hand today.", "", "## Spec", "",
    ].join(LF);
    expect(lintBuildOut(SCAFFOLD, reordered).problems).toEqual([]);
  });

  it("does not read a line ending as a rewrite, which on Windows is every build-out", () => {
    // The two sides cross a boundary: the scaffold is read back from a git checkout and
    // the built-out half was written by the ACT, so one can be CRLF and the other LF with
    // nothing else different at all. Refusing that would refuse every honest build-out on
    // the operator's machine -- the same shape as the acceptance failures a .gitattributes
    // change did not fix, because it does not touch files already checked out.
    const crlf = (t: string) => t.split(LF).join(String.fromCharCode(13) + LF);
    expect(lintBuildOut(crlf(SCAFFOLD), built()).problems).toEqual([]);
    expect(lintBuildOut(SCAFFOLD, crlf(built())).problems).toEqual([]);
  });

  it("refuses an ACT that promotes itself — the engine owns the transition after this gate", () => {
    const lint = lintBuildOut(SCAFFOLD, built().replace("status: draft", "status: ready"));
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(" ")).toContain('left status "ready"');
  });

  it("refuses a build-out that appended no evidence — the spec is what it exists to write", () => {
    const noSpec = SCAFFOLD.replace("status: scaffold", "status: draft") + LF + "## Spec" + LF;
    const lint = lintBuildOut(SCAFFOLD, noSpec);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(" ")).toContain("added no evidence");
  });

  it("refuses being handed something that was never a scaffold", () => {
    const lint = lintBuildOut(built(), built());
    expect(lint.ok).toBe(false);
    expect(lint.problems.join(" ")).toContain("not a scaffold");
  });

  it("reports every fault at once, so one round fixes them all", () => {
    const mangled = built()
      .replace("title: Invoice push", "title: Invoice PUSH")
      .replace("delivers: [C3.1]", "delivers: [C3.1, C9.9]")
      .replace("Invoices are pushed by hand today.", "Something else entirely.");
    const lint = lintBuildOut(SCAFFOLD, mangled);
    expect(lint.ok).toBe(false);
    expect(lint.problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("parseWorkUnit", () => {
  it("parses a valid unit", () => {
    const res = parseWorkUnit(VALID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.unit.id).toBe("wu-2026-08-20-fix-rounding");
    expect(res.unit.tier).toBe("reversible");
    expect(res.unit.evidence).toHaveLength(2);
    expect(res.unit.evidence[0]?.run).toContain("vitest");
    expect(res.unit.dependsOn).toEqual(["wu-2026-08-19-schema"]);
    expect(res.unit.body).toContain("Out of scope");
  });

  it("reports every contract violation at once, with reasons", () => {
    const res = parseWorkUnit(`---\nid: x\ntier: sideways\nstatus: someday\nbudget_usd: -1\n---\nbody`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("title is required");
    expect(res.errors.join("\n")).toContain("tier must be one of");
    expect(res.errors.join("\n")).toContain("status must be one of");
    expect(res.errors.join("\n")).toContain("budget_usd must be a positive number");
  });

  it("rejects evidence entries with empty run commands", () => {
    const res = parseWorkUnit(`---
id: x
title: t
tier: reversible
status: ready
budget_usd: 1
evidence:
  - kind: test
    run: "   "
    expect: "green"
---
b`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("evidence[0].run must be a non-empty command");
  });

  it("rejects files without frontmatter", () => {
    const res = parseWorkUnit("just prose, no contract");
    expect(res.ok).toBe(false);
  });
});

describe("isAdmissible (the hard gate)", () => {
  const merged = new Set(["wu-2026-08-19-schema"]);

  it("admits a ready unit with evidence and merged deps", () => {
    const res = parseWorkUnit(VALID);
    if (!res.ok) throw new Error("fixture must parse");
    expect(isAdmissible(res.unit, merged)).toEqual({ admissible: true });
  });

  it("rejects a unit without evidence — the whole point of the rule", () => {
    const res = parseWorkUnit(NO_EVIDENCE);
    if (!res.ok) throw new Error("fixture must parse");
    const verdict = isAdmissible(res.unit, merged);
    expect(verdict.admissible).toBe(false);
    if (verdict.admissible) return;
    expect(verdict.reasons.join("\n")).toContain("no machine-checkable evidence");
  });

  it("rejects drafts", () => {
    const res = parseWorkUnit(DRAFT);
    if (!res.ok) throw new Error("fixture must parse");
    const verdict = isAdmissible(res.unit, merged);
    expect(verdict.admissible).toBe(false);
    if (verdict.admissible) return;
    expect(verdict.reasons.join("\n")).toContain('status is "draft"');
  });

  it("rejects units whose REQUIREMENTS are not satisfied", () => {
    const res = parseWorkUnit(VALID);
    if (!res.ok) throw new Error("fixture must parse");
    // The set is the SATISFIED CRITERIA, not the merged unit ids (ADR-0004): a unit
    // waits on a requirement, and a requirement is satisfied when every slice that
    // delivers or renders it has landed.
    const verdict = isAdmissible(res.unit, new Set<string>());
    expect(verdict.admissible).toBe(false);
    if (verdict.admissible) return;
    expect(verdict.reasons.join("\n")).toContain("requirement not satisfied: wu-2026-08-19-schema");
  });
});
