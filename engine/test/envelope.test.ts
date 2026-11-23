import { describe, expect, it } from "vitest";
import { parseEnvelope, PARENT_LEVEL } from "../src/envelope.js";
import { parseNarrowing } from "../src/narrowing.js";
import { parseIntent } from "../src/intent.js";

const LF = String.fromCharCode(10);

function doc(fields: Record<string, string>, body = "the slice"): string {
  return ["---", ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), "---", body, ""].join(LF);
}

describe("the shared envelope", () => {
  it("reads identity, level, status and the link", () => {
    const { envelope, body, errors } = parseEnvelope(
      doc({ id: "ft-rules", level: "feature", title: "Rules", status: "active", parent: "ep-cat", delivers: "[C2.1, C2.3]" }),
      "issue#12",
    );
    expect(errors).toEqual([]);
    expect(envelope).toMatchObject({ id: "ft-rules", level: "feature", parent: "ep-cat", delivers: ["C2.1", "C2.3"] });
    expect(body).toBe("the slice");
  });

  it("does no I/O and does not care whether `where` is a path or an issue", () => {
    // The property that lets the same parser read a file today and an issue body
    // tomorrow: it takes a string, and `where` only ever appears in messages.
    const a = parseEnvelope(doc({ id: "x", level: "epic", title: "t", status: "active", delivers: "[C1.1]" }), "docs/program/epics/x.md");
    const b = parseEnvelope(doc({ id: "x", level: "epic", title: "t", status: "active", delivers: "[C1.1]" }), "https://github.com/o/r/issues/12");
    expect(a.envelope).toEqual(b.envelope);
    expect(a.errors).toEqual(b.errors);
  });

  it("collects every fault at once rather than stopping at the first", () => {
    // A document with four faults should cost one round to fix, not four.
    const { errors } = parseEnvelope(doc({ level: "nonsense", parent: "ep-x" }), "issue#9");
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.join(" ")).toContain("id is required");
    expect(errors.join(" ")).toContain("title is required");
    expect(errors.join(" ")).toContain("level must be one of");
  });

  it("knows which level each parent must be", () => {
    // `unit` and `intent` both hang off a feature, and both entries are load-bearing
    // during the transition: the units in flight were planned under the four-level ladder
    // and finish under it, while a newly minted one is a child of a feature HEADING.
    expect(PARENT_LEVEL).toEqual({ epic: null, feature: "epic", intent: "feature", unit: "feature" });
  });
});

describe("the link rule is enforced ONCE, for every level", () => {
  // The whole reason the envelope exists. `parent` used to be called `feature` on an
  // intent and `parent` on a narrowing — two names for one edge, which is how a check
  // gets written for one level and not its sibling.

  it("refuses a feature with no epic", () => {
    const res = parseNarrowing(doc({ id: "ft-x", level: "feature", title: "t", status: "active", delivers: "[C1.1]" }), "issue#1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("must name the epic it belongs to");
  });

  it("READS an intent with no feature, because a parser reads what exists", () => {
    // The asymmetry with a feature is deliberate and has a reason. A feature without an
    // epic cannot be checked against anything, so it is refused at the door. An intent
    // without a parent is refused at the MINT GATE instead: being strict here would make
    // every intent written before this envelope unreadable — 21 of them on one target —
    // so the coverage arithmetic could not see the work it is meant to measure.
    const res = parseIntent(doc({
      id: "in-x", level: "intent", title: "t", status: "scaffold",
      budget_usd: "20", tier_default: "reversible", delivers: "[C1.1]",
    }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.intent.parent).toBeUndefined();
  });

  it("and reads one with no `level` at all, defaulting it", () => {
    // Same reason: the artifact is being handed to the intent parser, so its kind is
    // known from context. Legacy documents stay readable.
    const res = parseIntent(doc({
      id: "in-x", title: "t", status: "done", budget_usd: "20", tier_default: "reversible",
    }));
    expect(res.ok).toBe(true);
  });

  it("refuses an epic that claims a parent, because the program is not an artifact", () => {
    const res = parseNarrowing(
      doc({ id: "ep-x", level: "epic", title: "t", status: "active", parent: "ep-y", delivers: "[C1.1]" }),
      "issue#2",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("an epic has no parent");
  });

  it("accepts each level's own valid shape", () => {
    expect(parseNarrowing(doc({ id: "ep-a", level: "epic", title: "t", status: "active", delivers: "[C1.1]" }), "i#3").ok).toBe(true);
    expect(parseNarrowing(doc({ id: "ft-a", level: "feature", title: "t", status: "active", parent: "ep-a", delivers: "[C1.1]" }), "i#4").ok).toBe(true);
    expect(parseIntent(doc({
      id: "in-a", level: "intent", title: "t", status: "scaffold", parent: "ft-a",
      budget_usd: "20", tier_default: "reversible", delivers: "[C1.1]",
    })).ok).toBe(true);
  });
});

describe("a narrowing and an intent are told apart by level, not by shape", () => {
  it("refuses an intent handed to the narrowing parser", () => {
    const res = parseNarrowing(
      doc({ id: "in-a", level: "intent", title: "t", status: "active", parent: "ft-a", delivers: "[C1.1]" }),
      "issue#5",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("is not a narrowing");
  });
});
