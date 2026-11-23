import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseCriteria } from "../src/coverage.js";
import { parseNarrowing, type Narrowing } from "../src/narrowing.js";
import { crossEpicCandidates, reviewableSets, reviewEpicSet } from "../src/narrowing-set.js";
import { reviewedHash, writeSetReport, type SetJudgeRun } from "../src/narrowing-set-act.js";

const PRD = [
  "# PRD",
  "",
  "### C1. Ledger",
  "",
  "- **machine** `C1.1` Import produces the fixture's expected lines.",
  "- **machine** `C1.2` Close with one uncategorized line refuses.",
  "",
].join("\n");

const criteria = parseCriteria(PRD);

function doc(id: string, delivers: string[], opts: { level?: string; parent?: string; body?: string; dependsOn?: string[] } = {}): Narrowing {
  const src = [
    "---",
    `id: ${id}`,
    `level: ${opts.level ?? "epic"}`,
    `title: ${id}`,
    "status: active",
    ...(opts.parent !== undefined ? [`parent: ${opts.parent}`] : []),
    ...(opts.dependsOn !== undefined ? [`depends_on: [${opts.dependsOn.join(", ")}]`] : []),
    `delivers: [${delivers.join(", ")}]`,
    "---",
    opts.body ?? "the slice",
    "",
  ].join("\n");
  const p = parseNarrowing(src, `docs/program/${opts.level === "feature" ? "features" : "epics"}/${id}.md`);
  if (!p.ok) throw new Error(p.errors.join("; "));
  return p.narrowing;
}

describe("set coherence — one COMPLETE level against itself", () => {
  it("a clean partition is clean", () => {
    const r = reviewEpicSet(criteria, [doc("ep-a", ["C1.1"]), doc("ep-b", ["C1.2"])]);
    expect(r.problems).toEqual([]);
    expect(r.members).toEqual(["ep-a", "ep-b"]);
  });

  it("BLOCKS a criterion claimed by two epics — the thing no gate looked at", () => {
    // The arithmetic already computed this and threw it away: `lintCoverage` pushes it to
    // `flags`, and every reader of `ChainLint` at the narrowing rung reads `problems` only.
    // Two epics claiming one criterion means the feature rung narrows it twice and two
    // implementers build it.
    const r = reviewEpicSet(criteria, [doc("ep-a", ["C1.1", "C1.2"]), doc("ep-b", ["C1.2"])]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]!).toContain("C1.2 is claimed by 2 epics (ep-a, ep-b)");
  });


  it("carries through what the existing lint already refuses, rather than restating it", () => {
    // `reviewEpicSet` calls `lintEpics`; it does not reimplement coverage. A criterion no
    // epic claims is that function's problem and arrives here unchanged.
    const r = reviewEpicSet(criteria, [doc("ep-a", ["C1.1"])]);
    expect(r.problems.join(" ")).toContain("C1.2");
  });

  it("the hash is over the PROSE, because the collision it guards is prose", () => {
    // An epic that quietly takes over its sibling's work changes no id and no `delivers`
    // list. A key built from those would call the set unchanged and skip the review that
    // exists to catch exactly that.
    const a = reviewEpicSet(criteria, [doc("ep-a", ["C1.1"]), doc("ep-b", ["C1.2"])]);
    const b = reviewEpicSet(criteria, [
      doc("ep-a", ["C1.1"], { body: "this epic also builds the queue" }),
      doc("ep-b", ["C1.2"]),
    ]);
    expect(b.hash).not.toBe(a.hash);
  });


  it("REGRESSION: a PRD criterion reworded under the same id changes the epic set's key", () => {
    // The ids drive the arithmetic and the TEXT is what a faithful epic quotes, so a
    // criterion rewritten under its old id makes every epic's quotation suspect. Nothing
    // in the documents changed; the parent did.
    const epics = [doc("ep-a", ["C1.1"]), doc("ep-b", ["C1.2"])];
    const reworded = parseCriteria(PRD.replace("Import produces the fixture's expected lines.", "Import produces the fixture's expected lines, to the penny."));
    expect(reviewEpicSet(reworded, epics).hash).not.toBe(reviewEpicSet(criteria, epics).hash);
  });

  it("the hash does not depend on the order the store returned them in", () => {
    const one = doc("ep-a", ["C1.1"]);
    const two = doc("ep-b", ["C1.2"]);
    expect(reviewEpicSet(criteria, [two, one]).hash).toBe(reviewEpicSet(criteria, [one, two]).hash);
  });

  describe("the declared order, checked — the half that was prose until `depends_on:` existed", () => {
    it("BLOCKS an edge on a requirement nothing in the set delivers", () => {
      // The quiet kind of stuck: an edge that can never clear reads as "not ready yet"
      // forever — nothing red, nothing spent, nothing ever happening.
      const r = reviewEpicSet(criteria, [doc("ep-a", ["C1.1"], { dependsOn: ["C9.9"] }), doc("ep-b", ["C1.2"])]);
      expect(r.problems.join(" ")).toContain("depends on C9.9, which no epic delivers or renders");
    });

    it("BLOCKS a slice that waits on its own work", () => {
      const r = reviewEpicSet(criteria, [doc("ep-a", ["C1.1"], { dependsOn: ["C1.1"] }), doc("ep-b", ["C1.2"])]);
      expect(r.problems.join(" ")).toContain("depends on C1.1, which it names itself");
    });

    it("BLOCKS a cycle — no order satisfies it, so nothing can be scheduled", () => {
      // `inServeOrder` hands the tangle back rather than picking a winner; this is where it
      // is refused, because scheduling a program whose graph is impossible reports nothing.
      const r = reviewEpicSet(criteria, [
        doc("ep-a", ["C1.1"], { dependsOn: ["C1.2"] }),
        doc("ep-b", ["C1.2"], { dependsOn: ["C1.1"] }),
      ]);
      expect(r.problems.join(" ")).toContain("has a cycle among ep-a, ep-b");
    });

    it("a sound graph is clean, and no `depends_on:` at all is still clean", () => {
      expect(reviewEpicSet(criteria, [doc("ep-a", ["C1.1"], { dependsOn: ["C1.2"] }), doc("ep-b", ["C1.2"])]).problems).toEqual([]);
      expect(reviewEpicSet(criteria, [doc("ep-a", ["C1.1"]), doc("ep-b", ["C1.2"])]).problems).toEqual([]);
    });



  });


  describe("which sets are owed — one rule, because two disagreed", () => {
    // External review, PR #83. The dispatch hook waited for `nextChainNeed` to stop asking
    // for a feature; the CLI asked only whether every EXISTING epic had complete coverage.
    // On a program still growing epics the second is true long before the feature level is
    // finished, so the sweep would buy a judge for a partial set, label the report "every
    // feature in the program", commit it, and have the next epic invalidate it.
    const PRD3 = [
      "# PRD", "", "### C1. Ledger", "",
      "- **machine** `C1.1` One.", "- **machine** `C1.2` Two.", "- **machine** `C1.3` Three.", "",
    ].join(String.fromCharCode(10));
    const three = parseCriteria(PRD3);
    const ft = (id: string, parent: string, delivers: string[]) => doc(id, delivers, { level: "feature", parent });

    it("the epic set is the only reviewable set, and only once every criterion reaches an epic", () => {
      // There is no feature-set review because there is no feature SET: features are written
      // with their epic, in the same document, so reviewing them IS reviewing that epic.
      const short = [doc("ep-a", ["C1.1", "C1.2"])];
      expect(reviewableSets(three, short, []).map((r) => r.review.scope), "C1.3 reaches nobody").toEqual([]);

      const whole = [doc("ep-a", ["C1.1", "C1.2"]), doc("ep-b", ["C1.3"])];
      const sets = reviewableSets(three, whole, []);
      expect(sets.map((r) => r.review.scope)).toEqual(["epics"]);
      expect(sets[0]!.parentIsProgram).toBe(true);
    });
  });

  describe("the worklist that makes a thirty-document set readable", () => {
    const epics = [doc("ep-a", ["C1.1"]), doc("ep-b", ["C1.2"])];
    const ft = (id: string, parent: string, delivers: string[], body: string) =>
      doc(id, delivers, { level: "feature", parent, body });

    it("surfaces an artifact two EPICS' features both claim", () => {
      const r = crossEpicCandidates(epics, [
        ft("ft-1", "ep-a", ["C1.1"], "This slice creates the `categorisations` migration."),
        ft("ft-2", "ep-b", ["C1.2"], "The `categorisations` log belongs to the other epic; this feature does not create it."),
      ]);
      expect(r.map((c) => c.name)).toContain("categorisations");
    });

    it("ignores an artifact only one epic's features discuss", () => {
      // One epic's children are already read against each other by the per-epic review;
      // repeating that here spends the judge's turn on settled ground.
      const r = crossEpicCandidates(epics, [
        ft("ft-1", "ep-a", ["C1.1"], "This slice creates the `proposals` migration."),
        ft("ft-2", "ep-b", ["C1.2"], "Nothing to say here."),
      ]);
      expect(r.map((c) => c.name)).not.toContain("proposals");
    });

    it("MENTION is not a claim — the signal is ownership language, not co-occurrence", () => {
      // The first version of this ranked by rarity on the theory that a specific shared
      // artifact is named by few documents. Measured on a target it put
      // `categorisations` — the collision this rung exists for — at rank 199, behind
      // `accountId` and `description`. Rarity is backwards: an artifact two slices fight
      // over is one that many slices discuss. So the signal is the verb.
      const r = crossEpicCandidates(epics, [
        ft("ft-1", "ep-a", ["C1.1"], "Figures are read through `decodeRefs` on every screen."),
        ft("ft-2", "ep-b", ["C1.2"], "The trace calls `decodeRefs` as well."),
      ]);
      expect(r.map((c) => c.name)).not.toContain("decodeRefs");
    });

    it("ranks the most contested first — by epics, then by features", () => {
      const r = crossEpicCandidates(epics, [
        ft("ft-1", "ep-a", ["C1.1"], "This slice creates the `hot_table` migration. It also creates `cool_table`."),
        ft("ft-2", "ep-b", ["C1.2"], "`hot_table` belongs to the sibling; this feature does not create it."),
        ft("ft-3", "ep-b", ["C1.2"], "This slice owns `hot_table` too."),
      ]);
      expect(r[0]!.name).toBe("hot_table");
      expect(r.find((c) => c.name === "cool_table"), "one epic only, so not a candidate").toBeUndefined();
    });
  });

  describe("the report is the key, so what it records has to be true", () => {
    const tmp = mkdtempSync(join(tmpdir(), "doctrine-setreport-"));
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));
    const arena = (n: string): string => { const d = join(tmp, n); mkdirSync(d, { recursive: true }); return d; };
    const set = [doc("ep-a", ["C1.1"]), doc("ep-b", ["C1.2"])];
    const judged = (findings: number): SetJudgeRun => ({
      ok: true,
      findings: Array.from({ length: findings }, (_, i) => ({ documents: ["ep-a", "ep-b"], text: `finding ${i}`, quotes: [] })),
      spendUsd: 1,
    });

    it("a judged report stamps the hash, so the same set is not bought twice", () => {
      const dir = arena("stamped");
      const r = reviewEpicSet(criteria, set);
      writeSetReport(dir, r, judged(2));
      expect(reviewedHash(dir, r)).toBe(r.hash);
    });

    it("a report written with NO judge stamps no hash — a free sweep may not suppress the paid half", () => {
      // `--free` writes a real report and did not do the expensive work. Stamping the hash
      // there would turn the gate off with the cheap command that reports on it.
      const dir = arena("free");
      const r = reviewEpicSet(criteria, set);
      writeSetReport(dir, r, null);
      expect(reviewedHash(dir, r)).toBe("none");
      expect(readFileSync(join(dir, "docs/program/coherence/epics.md"), "utf8")).toContain("the set judge did not run");
    });

    it("a judge that could not REPORT stamps no hash either", () => {
      const dir = arena("judge-failed");
      const r = reviewEpicSet(criteria, set);
      writeSetReport(dir, r, { ok: false, problems: ["narrowing-set-judge timed out"], outage: false, spendUsd: 1 });
      expect(reviewedHash(dir, r)).toBe("none");
    });

    it("REGRESSION: a `--free` sweep may not erase a judged report either", () => {
      // The twin of the review finding on #81, and it fired for real: the guard was put in
      // the CLI's `fresh` branch, and `--free` — the other way to reach `writeSetReport`
      // with no judge — walked past it and erased four real reports on a target,
      // hash and findings both. One rule stated in one caller's control flow, and the
      // path nobody wrote it on is the path that ran.
      //
      // So the rule lives in `writeSetReport`: an unjudged write never downgrades a
      // judged report of the SAME set.
      const dir = arena("no-downgrade");
      const r = reviewEpicSet(criteria, set);
      writeSetReport(dir, r, judged(3));

      writeSetReport(dir, r, null);                                             // --free
      writeSetReport(dir, r, { ok: false, problems: ["timed out"], outage: false, spendUsd: 1 }); // judge failed

      expect(reviewedHash(dir, r), "the hash survives both").toBe(r.hash);
      expect(readFileSync(join(dir, "docs/program/coherence/epics.md"), "utf8")).toContain("finding 0");
    });

    it("...but a set whose PROSE changed IS rewritten, because the old findings are about documents that are gone", () => {
      const dir = arena("changed-rewritten");
      const before = reviewEpicSet(criteria, set);
      writeSetReport(dir, before, judged(3));

      const after = reviewEpicSet(criteria, [doc("ep-a", ["C1.1"], { body: "now it also builds the queue" }), doc("ep-b", ["C1.2"])]);
      expect(after.hash).not.toBe(before.hash);
      writeSetReport(dir, after, null);

      expect(reviewedHash(dir, after)).toBe("none");
      expect(readFileSync(join(dir, "docs/program/coherence/epics.md"), "utf8")).not.toContain("finding 0");
    });

    it("REGRESSION: a fresh set's report is not overwritten by a run that skipped the judge", () => {
      // External review, PR #81. The CLI wrote the report unconditionally, so the path that
      // SKIPS the judge stamped `hash: none` over a good report and threw its findings
      // away — and the next run then called the unchanged set stale and bought the judge
      // again. A cache that destroyed itself on read, defeating the skip it was protecting.
      //
      // This asserts the property the CLI's `continue` now preserves: once stamped, the
      // recorded hash and findings survive, so `reviewedHash` keeps matching.
      const dir = arena("fresh-kept");
      const r = reviewEpicSet(criteria, set);
      writeSetReport(dir, r, judged(3));
      expect(reviewedHash(dir, r)).toBe(r.hash);

      const body = readFileSync(join(dir, "docs/program/coherence/epics.md"), "utf8");
      expect(body).toContain("finding 0");
      // The set is unchanged, so a later run must find it fresh and leave all of this be.
      expect(reviewEpicSet(criteria, set).hash).toBe(r.hash);
    });
  });
});
