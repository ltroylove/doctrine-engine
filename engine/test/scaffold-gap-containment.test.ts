import { describe, expect, it } from "vitest";
import { BASELINE_DENY } from "../src/containment.js";
import { REVIEW_FIX_DENY } from "../src/review.js";
import { GAP_OUT_DIR } from "../src/scaffold-gap.js";

/**
 * The scaffold-gap ACT runs in a scratch directory under REVIEW_FIX_DENY, and the deny rules are
 * RELATIVE: they resolve against the ACT's own working directory. When it wrote to `work/`, the
 * one directory it was told to use was the one directory `Write(work/)` refused, and every mint
 * was lost. This holds the output directory clear of every rule.
 */

/** The path argument of every Write/Edit rule, as a matcher for a relative path. */
function writeMatchers(rules: readonly string[]): Array<{ rule: string; test: (p: string) => boolean }> {
  return rules
    .map((rule) => ({ rule, m: /^(Write|Edit)\((.+)\)$/.exec(rule) }))
    .filter((r): r is { rule: string; m: RegExpExecArray } => r.m !== null)
    .map(({ rule, m }) => {
      const pat = m[2]!;
      const re = new RegExp("^" + pat
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, "(.*/)?")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, "[^/]*")
        + (pat.endsWith("/") ? ".*" : "") + "$");
      return { rule, test: (p: string) => re.test(p) };
    });
}

describe("the scaffold-gap output directory is clear of every deny rule it runs under", () => {
  const rules = [...BASELINE_DENY, ...REVIEW_FIX_DENY];

  it("the checker sees the old bug: `work/` is refused by REVIEW_FIX_DENY", () => {
    expect(writeMatchers(rules).some((m) => m.test("work/wu-x.md"))).toBe(true);
  });

  it(`no Write or Edit rule refuses ${GAP_OUT_DIR}/`, () => {
    const hits = writeMatchers(rules).filter((m) => m.test(`${GAP_OUT_DIR}/wu-x.md`)).map((m) => m.rule);
    expect(hits).toEqual([]);
  });
});
