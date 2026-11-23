import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseCriteria } from "../src/coverage.js";
import { parseNarrowing, type Narrowing } from "../src/narrowing.js";
import { lintTicket, parseTicket, ticketLabels, MAX_TICKET_INTENTS } from "../src/ticket.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-ticket-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PRD = [
  "# PRD",
  "",
  "### C1. Ledger",
  "",
  "- **machine** `C1.1` Import produces the fixture's expected lines.",
  "- **machine** `C1.2` Close with one uncategorised line refuses.",
  "",
].join("\n");

function narrowing(id: string, level: string, delivers: string[], parent?: string): Narrowing {
  const doc = [
    "---",
    `id: ${id}`,
    `level: ${level}`,
    `title: ${id}`,
    "status: active",
    ...(parent !== undefined ? [`parent: ${parent}`] : []),
    `delivers: [${delivers.join(", ")}]`,
    "---",
    "the slice",
    "",
  ].join("\n");
  const res = parseNarrowing(doc, `docs/program/${level}s/${id}.md`);
  if (!res.ok) throw new Error(res.errors.join("; "));
  return res.narrowing;
}

/** A repo with two real files, so path checks have something true to find. */
function arena(): string {
  const dir = mkdtempSync(join(tmp, "arena-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "import.ts"), "export const x = 1;\n");
  writeFileSync(join(dir, "src", "close.ts"), "export const y = 2;\n");
  return dir;
}

const EPIC = narrowing("ep-ledger", "epic", ["C1.1", "C1.2"]);
const FEATURE = narrowing("ft-import", "feature", ["C1.1"], "ep-ledger");

function ctx(dir: string) {
  return { arenaDir: dir, criteria: parseCriteria(PRD), epics: [EPIC], features: [FEATURE] };
}

const TICKET = (over: Record<string, string> = {}, body = "The import drops the last line."): string => {
  const fields: Record<string, string> = {
    title: "Import drops the final line",
    kind: "repair",
    type: "bug",
    tier: "reversible",
    delivers: "[C1.1]",
    home: "ft-import",
    files: "[src/import.ts]",
    references: "[src/close.ts]",
    intents: "[repair the off-by-one in the import reader]",
    ...over,
  };
  return ["---", ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), "---", body, ""].join("\n");
};

describe("a ticket is read out of its issue", () => {
  it("parses a triaged repair, with the issue number as its identity", () => {
    const res = parseTicket(TICKET(), 445, "https://github.com/o/r/issues/445");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // `M-<issue#>`, not a slug. Every other artifact here uses a slug because it must be
    // able to name its parent before the tracker has seen it; a ticket's origin IS the
    // tracker, so the number is authoritative rather than derived.
    expect(res.ticket.id).toBe("M-445");
    expect(res.ticket.home).toEqual({ kind: "existing", feature: "ft-import" });
  });

  it("reads the three shapes of home", () => {
    const existing = parseTicket(TICKET(), 1, "i");
    const newFeature = parseTicket(TICKET({ home: "new-feature under ep-ledger" }), 2, "i");
    const newEpic = parseTicket(TICKET({ home: "new-epic" }), 3, "i");
    expect(existing.ok && existing.ticket.home).toEqual({ kind: "existing", feature: "ft-import" });
    expect(newFeature.ok && newFeature.ticket.home).toEqual({ kind: "new-feature", epic: "ep-ledger" });
    expect(newEpic.ok && newEpic.ticket.home).toEqual({ kind: "new-epic" });
  });

  it("REGRESSION: a malformed list is reported, not swallowed", () => {
    // The first version read the lists inside the object literal it was returning, so
    // `errors.length > 0` was evaluated before `parseStringList` had pushed into it. A
    // malformed `delivers:` went into an array nobody read and the ticket came back ok.
    const res = parseTicket(TICKET({ delivers: "not-a-list" }), 1, "i");
    expect(res.ok, "a parser that reports into a value it already branched on is not reporting").toBe(false);
    if (res.ok) return;
    expect(res.errors.join(" ")).toMatch(/delivers must be a list/);
  });

  it("growth is a kind AND a type, or it is a finding", () => {
    const res = parseTicket(TICKET({ kind: "growth" }), 1, "i");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join(" ")).toContain("growth is both, or neither");
  });

  it("labels are derived from the fields, so the two cannot disagree", () => {
    const res = parseTicket(TICKET(), 445, "i");
    expect(res.ok && ticketLabels(res.ticket)).toEqual(["type:bug", "kind:repair", "tier:reversible"]);
  });
});

describe("the free half: what the engine decides about a ticket without a model", () => {
  it("passes a well-formed repair", () => {
    const dir = arena();
    const res = parseTicket(TICKET(), 445, "i");
    expect(res.ok && lintTicket(res.ticket, ctx(dir))).toEqual([]);
  });

  it("refuses a path that does not resolve — triage discovers, it does not template", () => {
    const dir = arena();
    const res = parseTicket(TICKET({ files: "[src/does-not-exist.ts]" }), 445, "i");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(lintTicket(res.ticket, ctx(dir)).join(" ")).toContain("does not exist in the repository");
  });

  it("refuses placeholder text left in the body", () => {
    // This is the check that makes a ticket agent-executable rather than a wish, and it
    // is mechanical on purpose: the alternative is a checklist in the triage law that the
    // agent attests to having followed, and a self-attested checklist is a claim.
    const dir = arena();
    for (const body of ["See <path> for the reader.", "Tracked as M-XXX.", "Fixed by YYYY-MM-DD.", "TODO: work out the cause."]) {
      const res = parseTicket(TICKET({}, body), 445, "i");
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(lintTicket(res.ticket, ctx(dir)).join(" "), body).toMatch(/placeholder|TBD\/TODO/);
    }
  });

  it("refuses placeholder text in the FRONTMATTER, not just the body", () => {
    // The scan read `ticket.body` alone, so `intents: [TODO]`, a title still reading
    // `<something>` and a proposed criterion of "TBD" all passed the gate and were
    // published — and the judge's law says explicitly that placeholders were already
    // checked and must not be re-litigated, so nothing looked again before a person
    // approved it. External review caught it; break-verifying the fix caught that I had
    // written no test for it.
    const dir = arena();
    const cases: Array<Record<string, string>> = [
      { intents: "[TODO]" },
      { title: "Fix <the thing>" },
      { files: "[src/import.ts]", references: "[src/close.ts]", intents: "[repair it by YYYY-MM-DD]" },
    ];
    for (const over of cases) {
      const res = parseTicket(TICKET(over), 445, "i");
      expect(res.ok, JSON.stringify(over)).toBe(true);
      if (!res.ok) return;
      expect(lintTicket(res.ticket, ctx(dir)).join(" "), JSON.stringify(over)).toMatch(/placeholder|TBD\/TODO/);
    }
  });

  it("a repair must repair a criterion the PRD actually has", () => {
    const dir = arena();
    const res = parseTicket(TICKET({ delivers: "[C9.9]" }), 445, "i");
    expect(res.ok && lintTicket(res.ticket, ctx(dir)).join(" ")).toContain("which the PRD does not have");
  });

  it("a repair may not attach to a feature that does not carry its criteria", () => {
    // The constraint that stops a ticket smuggling in scope. `lintChildren` refuses an
    // intent covering what its feature does not, so a repair attached to the wrong
    // feature produces intents nothing can admit — caught here, for free, first.
    const dir = arena();
    const res = parseTicket(TICKET({ delivers: "[C1.2]" }), 445, "i");
    expect(res.ok && lintTicket(res.ticket, ctx(dir)).join(" ")).toContain("either this belongs to a different feature");
  });

  it("a repair that needs a new feature is not a repair", () => {
    // Behaviour with no feature is behaviour the PRD does not state, which makes it
    // growth however much it feels like a bug.
    const dir = arena();
    const res = parseTicket(TICKET({ home: "new-epic" }), 445, "i");
    expect(res.ok && lintTicket(res.ticket, ctx(dir)).join(" ")).toContain("which makes this growth");
  });

  it("growth drafts criteria the PRD lacks, and delivers nothing yet", () => {
    const dir = arena();
    const ok = parseTicket(TICKET({
      kind: "growth", type: "growth", delivers: "[]",
      home: "new-feature under ep-ledger",
      proposes: "[C1.3 | machine | Re-importing a statement twice produces no duplicate lines.]",
    }), 500, "i");
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(lintTicket(ok.ticket, ctx(dir))).toEqual([]);
    expect(ok.ticket.proposes[0]!).toEqual({
      id: "C1.3", kind: "machine",
      text: "Re-importing a statement twice produces no duplicate lines.",
    });
  });

  it("growth may not propose an id the PRD already uses", () => {
    // Reusing an id silently rewrites an existing requirement — and the coverage chain
    // would go on reporting green against text that no longer says the same thing.
    const dir = arena();
    const res = parseTicket(TICKET({
      kind: "growth", type: "growth", delivers: "[]",
      home: "new-feature under ep-ledger",
      proposes: "[C1.1 | machine | Something else entirely.]",
    }), 500, "i");
    expect(res.ok && lintTicket(res.ticket, ctx(dir)).join(" ")).toContain("which the PRD already has");
  });

  it("growth must draft something — that draft is what the operator edits", () => {
    const dir = arena();
    const res = parseTicket(TICKET({ kind: "growth", type: "growth", delivers: "[]", home: "new-epic" }), 500, "i");
    expect(res.ok && lintTicket(res.ticket, ctx(dir)).join(" ")).toContain("must draft the criteria");
  });

  it("a new feature must go under an epic that exists", () => {
    const dir = arena();
    const res = parseTicket(TICKET({
      kind: "growth", type: "growth", delivers: "[]",
      home: "new-feature under ep-nonexistent",
      proposes: "[C1.3 | machine | A thing.]",
    }), 500, "i");
    expect(res.ok && lintTicket(res.ticket, ctx(dir)).join(" ")).toContain("which does not exist");
  });

  it(`more than ${MAX_TICKET_INTENTS} intents means it is a FEATURE, and triage says so`, () => {
    // The sizing rule, reusing the ladder's own semantics rather than a parallel one: the
    // program rung's ceiling is three for the same reason, that a plan running to the end
    // is fiction. Past it the request is a slice of an epic, not a unit of work.
    const dir = arena();
    const res = parseTicket(TICKET({ intents: "[one, two, three, four]" }), 445, "i");
    const problems = (res.ok ? lintTicket(res.ticket, ctx(dir)) : []).join(" ");
    expect(problems).toContain("the request is a FEATURE");
    expect(problems).toContain("checks it against its epic in both directions");
  });

  it("a ticket that names no file has not been scanned", () => {
    const dir = arena();
    const res = parseTicket(TICKET({ files: "[]" }), 445, "i");
    expect(res.ok && lintTicket(res.ticket, ctx(dir)).join(" ")).toContain("has not been scanned against the codebase");
  });
});
