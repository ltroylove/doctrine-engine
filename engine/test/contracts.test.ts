import { describe, expect, it } from "vitest";
import { lintContractAdditions, parseContracts } from "../src/contracts.js";

const LF = String.fromCharCode(10);
const BT = String.fromCharCode(96);

const BEFORE = [
  "# Contracts (interfaces shared between work units)",
  "",
  "## The actor parameter",
  "",
  "Every writing function takes `actor` after `db`.",
  "",
  "## Design tokens",
  "",
  "Owner: the operator.",
  "",
].join(LF);

describe("parseContracts — the file's own furniture is not a contract", () => {
  it("reads `##` sections and ignores the title and any deeper heading", () => {
    const sections = parseContracts(BEFORE + "### A sub-heading inside the last one" + LF);
    expect(sections.map((s) => s.title)).toEqual(["The actor parameter", "Design tokens"]);
  });
});

describe("lintContractAdditions — build-out inherits plan-judge's surviving clause", () => {
  it("allows a genuine addition", () => {
    const after = BEFORE + ["## Invoice push", "", "`pushInvoices(db, actor)`.", ""].join(LF);
    expect(lintContractAdditions(BEFORE, after)).toEqual([]);
  });

  it("refuses an addition that already exists under different formatting", () => {
    // Comparing raw text would let a rival be minted by capitalising a word, which is the
    // failure this check is for rather than an edge case of it.
    const after = BEFORE + ["## the " + BT + "actor" + BT + " Parameter!", "", "Rival wording.", ""].join(LF);
    const problems = lintContractAdditions(BEFORE, after);
    expect(problems.join(" ")).toContain("rewrote the existing contract");
  });

  it("refuses a REWRITE of an existing contract, which is the half plan-judge never asked", () => {
    // A judge asked about rivals looks at what was added. A build-out that quietly changes
    // a signature other units were already built against adds nothing at all, and every
    // one of those units is now wrong about an interface it was handed.
    const after = BEFORE.replace("takes `actor` after `db`", "takes `actor` FIRST");
    expect(lintContractAdditions(BEFORE, after).join(" ")).toContain("append-only");
  });

  it("refuses a deletion", () => {
    const after = BEFORE.replace(["## Design tokens", "", "Owner: the operator.", ""].join(LF), "");
    expect(lintContractAdditions(BEFORE, after).join(" ")).toContain("removed the existing contract");
  });

  it("refuses the same contract added twice in one run", () => {
    const after = BEFORE
      + ["## Invoice push", "", "One.", "", "## invoice push", "", "Two.", ""].join(LF);
    expect(lintContractAdditions(BEFORE, after).join(" ")).toContain("twice");
  });

  it("treats a file that did not exist as an empty one — everything in it is an addition", () => {
    expect(lintContractAdditions("", BEFORE)).toEqual([]);
  });

  it("is indifferent to line endings, because the scaffold arrives from a git checkout", () => {
    const crlf = BEFORE.split(LF).join(String.fromCharCode(13) + LF);
    expect(lintContractAdditions(BEFORE, crlf)).toEqual([]);
  });
});

describe("the preamble is part of the append-only comparison (PR #94 second review)", () => {
  const WITH_PREAMBLE = [
    "# Contracts", "", "Owner rules: the owner builds it, everyone else consumes it unchanged.", "",
    "## The actor parameter", "", "Every writing function takes `actor` after `db`.", "",
  ].join(LF);

  it("refuses a rewrite of the text above the first section", () => {
    const after = WITH_PREAMBLE.replace("consumes it unchanged", "may edit it freely");
    expect(lintContractAdditions(WITH_PREAMBLE, after).join(" ")).toContain("above the first contract section");
  });

  it("refuses a contract smuggled into the preamble instead of added as a section", () => {
    const after = WITH_PREAMBLE.replace("## The actor parameter", "pushInvoices(db)" + LF + LF + "## The actor parameter");
    expect(lintContractAdditions(WITH_PREAMBLE, after).join(" ")).toContain("as a `## <name>` section");
  });

  it("protects a file that has NO sections at all — its whole body is preamble", () => {
    const flat = "# Contracts" + LF + LF + "pushInvoices(db): Promise<void>" + LF;
    const rewritten = "# Contracts" + LF + LF + "pushInvoices(db, actor): Promise<void>" + LF;
    expect(lintContractAdditions(flat, rewritten).length).toBeGreaterThan(0);
  });

  it("still allows an addition as a section below an unchanged preamble", () => {
    const after = WITH_PREAMBLE + ["## Invoice push", "", "pushInvoices(db, actor).", ""].join(LF);
    expect(lintContractAdditions(WITH_PREAMBLE, after)).toEqual([]);
  });

  it("is indifferent to line endings in the preamble, because the file arrives from a checkout", () => {
    const crlf = WITH_PREAMBLE.split(LF).join(String.fromCharCode(13) + LF);
    expect(lintContractAdditions(WITH_PREAMBLE, crlf)).toEqual([]);
  });
});
