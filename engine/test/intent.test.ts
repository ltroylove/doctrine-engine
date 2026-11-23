import { describe, expect, it } from "vitest";
import { lintPlan, parseIntent } from "../src/intent.js";
import type { Slice } from "../src/depends.js";
import { parseWorkUnit, type WorkUnit } from "../src/work-unit.js";

const INTENT = `---
id: in-2026-08-20-csv-export
title: CSV export for the ledger
status: ready
budget_usd: 20
tier_default: reversible
acceptance:
  - kind: test
    run: "pnpm vitest run test/e2e/export.e2e.ts"
    expect: "exit 0 after all children merge"
---
Users need to pull their ledger into a spreadsheet. Add \`ledger export\` producing
CSV with headers. Out of scope: XLSX, imports.
`;

function unit(id: string, opts: { deps?: string[]; budget?: number; tier?: string; intent?: string; evidence?: boolean } = {}): WorkUnit {
  const evidence =
    opts.evidence === false
      ? ""
      : `evidence:
  - kind: command
    run: "pnpm test"
    expect: "exit 0"`;
  const res = parseWorkUnit(`---
id: ${id}
title: t
tier: ${opts.tier ?? "reversible"}
status: draft
budget_usd: ${opts.budget ?? 5}
intent: ${opts.intent ?? "in-2026-08-20-csv-export"}
depends_on: [${(opts.deps ?? []).join(", ")}]
${evidence}
---
b`);
  if (!res.ok) throw new Error(`fixture must parse: ${res.errors.join("; ")}`);
  return res.unit;
}

describe("parseIntent", () => {
  it("parses a valid intent", () => {
    const res = parseIntent(INTENT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.intent.id).toBe("in-2026-08-20-csv-export");
    expect(res.intent.evidence).toHaveLength(1);
    expect(res.intent.tier).toBe("reversible");
  });

  it("the admissibility law one level up: no acceptance evidence, no ready", () => {
    const res = parseIntent(`---
id: in-x
title: t
status: ready
budget_usd: 10
tier_default: reversible
---
b`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain('cannot be "ready" without acceptance evidence');
  });

  it("a proposed intent may still lack acceptance (it cannot be promoted)", () => {
    const res = parseIntent(`---
id: in-x
title: t
status: proposed
budget_usd: 10
tier_default: reversible
---
b`);
    expect(res.ok).toBe(true);
  });
});

describe("lintPlan — mechanical, not an LLM", () => {
  const intent = (() => {
    const r = parseIntent(INTENT);
    if (!r.ok) throw new Error("fixture");
    return r.intent;
  })();
  /** No sibling slice declares coverage, so no criterion is dependable. */
  const none: Slice[] = [];
  /** One other intent delivers C1.1 and renders C1.2 — both legal to wait on. */
  const elsewhere: Slice[] = [{ id: "in-other", delivers: ["C1.1"], renders: ["C1.2"] }];

  it("passes a well-formed plan and flags irreversible children without failing them", () => {
    const lint = lintPlan(
      intent,
      [unit("wu-a"), unit("wu-b", { deps: ["C1.1"] }), unit("wu-c", { deps: ["C1.2"], tier: "irreversible" })],
      elsewhere,
    );
    expect(lint.ok).toBe(true);
    expect(lint.flags.join("\n")).toContain("wu-c: irreversible tier");
  });

  it("rejects evidence-less children", () => {
    const lint = lintPlan(intent, [unit("wu-a", { evidence: false })], none);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join("\n")).toContain("wu-a: no machine-checkable evidence");
  });

  it("rejects a wrong or missing intent backlink", () => {
    const lint = lintPlan(intent, [unit("wu-a", { intent: "in-somebody-else" })], none);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join("\n")).toContain("intent backlink");
  });

  it("rejects budget overrun", () => {
    const lint = lintPlan(intent, [unit("wu-a", { budget: 15 }), unit("wu-b", { budget: 10 })], none);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join("\n")).toContain("exceeding the intent's $20");
  });

  it("refuses a criterion no slice delivers or renders — an edge that can never clear", () => {
    const lint = lintPlan(intent, [unit("wu-a", { deps: ["C9.9"] })], elsewhere);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join("\n")).toContain("depends on C9.9, which no intent delivers or renders");
  });

  it("accepts a criterion another slice delivers, and one it merely renders", () => {
    expect(lintPlan(intent, [unit("wu-a", { deps: ["C1.1"] })], elsewhere).ok).toBe(true);
    expect(lintPlan(intent, [unit("wu-a", { deps: ["C1.2"] })], elsewhere).ok).toBe(true);
  });

  it("refuses a unit waiting on its OWN intent — a deadlock with itself", () => {
    const mine = { ...intent, delivers: ["C3.1"] };
    const lint = lintPlan(mine, [unit("wu-a", { deps: ["C3.1"] })], [...elsewhere, { id: mine.id, delivers: ["C3.1"], renders: [] }]);
    expect(lint.ok).toBe(false);
    expect(lint.problems.join("\n")).toContain("which its own intent in-2026-08-20-csv-export delivers");
  });

  it("no longer walks a unit-id graph: a unit cannot name a unit, so there is no cycle to find", () => {
    const lint = lintPlan(intent, [unit("wu-a", { deps: ["wu-b"] }), unit("wu-b", { deps: ["wu-a"] })], elsewhere);
    expect(lint.ok).toBe(false);
    // Refused as unsatisfiable edges, not as a cycle — "wu-b" is not a criterion.
    expect(lint.problems.join("\n")).toContain("depends on wu-b, which no intent delivers or renders");
    expect(lint.problems.join("\n")).not.toContain("cycle");
  });
});

describe("the dialect's third renaming — `covers` is read as `delivers`", () => {
  // The field was renamed and nothing read the old spelling, so every intent on
  // a target parsed with `delivers: []` and `satisfiedCriteria` was empty there from
  // then on. It was invisible until found only because the loop was paused.
  const doc = (fields: string[]): string => [
    "---", "id: in-x", "title: X", "status: done", "budget_usd: 20", "tier_default: reversible",
    ...fields,
    "acceptance:", "  - kind: command", '    run: "true"', '    expect: "exit 0"',
    "---", "body", "",
  ].join(String.fromCharCode(10));

  it("reads the old spelling", () => {
    const r = parseIntent(doc(["covers: [C1.1, C1.2]"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.delivers).toEqual(["C1.1", "C1.2"]);
  });

  it("prefers nothing when both are written — it refuses", () => {
    // The silent resolution, believing one, is how a claim quietly changes what it covers.
    const r = parseIntent(doc(["covers: [C1.1]", "delivers: [C1.2]"]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toContain("carries both");
  });

  it("still reads the new spelling unchanged", () => {
    const r = parseIntent(doc(["delivers: [C3.1]"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.delivers).toEqual(["C3.1"]);
  });
});
