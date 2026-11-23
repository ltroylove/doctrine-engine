import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_CHECKS } from "../src/narrowing-act.js";
import { TRIAGE_CHECKS } from "../src/ticket-act.js";

/**
 * One rule, one statement — enforced.
 *
 * **Why this file exists, and it is not a style preference.** Four separate defects in
 * this engine were the same shape: a rule enforced in one place and stated in another,
 * with nothing keeping the two in step.
 *
 *  - the union rule written in a `coverage.ts` comment and absent from the judge law that
 *    was supposed to enforce it;
 *  - a verdict schema telling the judge an outstanding slice is a FAIL while the judge law
 *    two files over said it is a PASS — which would have deadlocked every feature needing
 *    a fourth intent;
 *  - a revert whose path argument was supplied at one of six call sites;
 *  - and the near miss that prompted this file: the narrowing judge's six required checks,
 *    written once in the engine and once in the prompt, agreeing today by luck.
 *
 * Each was fixed individually. The operator's question was why the cause had not been
 * fixed after the second one, and the answer is that nobody had named it: **every judge's
 * verdict contract is written twice — as prose in an agent definition, and as a validator
 * in TypeScript — with no link between them.** Five judges, ten copies of five contracts.
 *
 * The strongest fix is to render the prompt from the code, which the narrowing judge now
 * does. The rest are a larger refactor of working gates, so this file is the net under
 * them: it fails the moment a contract and its law disagree, instead of a production
 * verdict being refused at roughly nine dollars.
 */

const AGENTS = join(import.meta.dirname, "..", "..", ".claude", "agents");
const law = (name: string): string => readFileSync(join(AGENTS, `${name}.md`), "utf8");

/**
 * Does this law ask the judge for `key` — as a JSON key, not as a substring?
 *
 * The distinction is the whole test. `text.includes("nothing_dropped")` is satisfied by
 * `nothing_droppedX`, so the first version of this file could not detect a renamed key;
 * it was confirmed useless by renaming one and watching six tests pass.
 */
function asksFor(text: string, key: string): boolean {
  // Double backslash: this is a JS string literal, so a single one is eaten before the
  // RegExp sees it and the pattern becomes `"key"s*:` — which matched anyway, by the luck
  // of `s*` allowing zero. It would have reported `"verdict" :` as missing.
  return new RegExp('"' + key + '"\\s*:').test(text);
}

describe("a judge's contract is stated once", () => {
  it("the triage judge's checks live ONLY in the engine", () => {
    // Same strong form as the narrowing judge: the prompt cannot disagree because it does
    // not state them. Adding a check to TRIAGE_CHECKS changes what the judge is asked for
    // and what it is validated against in the same edit.
    const text = law("ticket-judge");
    for (const check of TRIAGE_CHECKS) {
      expect(text, `${check} is named in the prompt as well as the engine — one rule, two statements`).not.toContain(check);
    }
    expect(text).toContain("Your task names the exact verdict shape");
  });

  it("the narrowing judge's checks live ONLY in the engine", () => {
    // The strong form: the prompt cannot disagree because it does not state them. Adding
    // a check to REQUIRED_CHECKS changes what the judge is asked for and what it is
    // validated against in the same edit.
    const text = law("narrowing-judge");
    for (const check of REQUIRED_CHECKS) {
      expect(text, `${check} is named in the prompt as well as the engine — one rule, two statements`).not.toContain(check);
    }
    // And it says why, so the next author does not helpfully add them back.
    expect(text).toContain("Your task names the exact verdict shape");
  });
});

/**
 * The weaker net, for the four contracts still written twice.
 *
 * Each entry names a key the VALIDATOR requires and the law that must therefore ask for
 * it. This does not make drift impossible — it makes drift fail here rather than in
 * production. Converting these to rendered schemas is the follow-through.
 */
const STILL_DUPLICATED: Array<{ law: string; validator: string; keys: string[] }> = [
  {
    law: "code-judge", validator: "engine/src/verdict.ts",
    keys: ["verdict", "judged", "unit", "coherence", "evidence", "gates_executed", "base_sha", "head_sha", "spend_usd"],
  },
  { law: "plan-judge", validator: "engine/src/plan-judge.ts", keys: ["verdict", "judged", "units", "rival_check"] },
  {
    law: "design-judge", validator: "engine/src/design-judge.ts",
    // `screen`, `region`, `observed` and `ok` are per-FINDING and each is separately
    // required — a finding missing any one of them fails validation, so a law that never
    // asks for it produces verdicts that cannot pass.
    keys: ["verdict", "screens", "gates_executed", "findings", "screen", "region", "observed", "ok"],
  },
  // program-judge is deliberately ABSENT. Its schema is not in the agent law at all — it
  // is assembled in `program.ts` beside the validator that enforces it, which is the same
  // colocation the narrowing judge now has. Adding it here failed immediately, because
  // `program-judge.md` never mentions `"verdict"`, and that failure was correct: the test
  // was asserting a duplication that does not exist. Recorded rather than deleted, because
  // "this judge is fine" is the thing a future reader will otherwise re-derive.
];

/**
 * Judges whose contract is stated ONCE, with where — so the test above can tell "this is
 * fine" from "nobody has looked at this yet".
 */
const SINGLE_SOURCED: Array<{ law: string; why: string }> = [
  { law: "narrowing-judge", why: "the engine renders its schema from REQUIRED_CHECKS" },
  // Same shape, same reason, and it was caught HERE rather than in production: the first
  // draft of the set judge stated its four checks in the law AND in `narrowing-set-act.ts`,
  // and this file's read-from-disk test refused it. That is the guard working as designed
  // — a new judge cannot be added unwatched.
  { law: "narrowing-set-judge", why: "the engine renders its schema from narrowing-set-act's REQUIRED_CHECKS" },
  { law: "program-judge", why: "its schema is stated only in program.ts, beside the validator" },
  { law: "ticket-judge", why: "the engine renders its schema from TRIAGE_CHECKS" },
];

/**
 * The third thing a law and its prompt can disagree about: WHICH DOCUMENT IS THE SOURCE.
 *
 * This file already watched verdict keys and the bar, and both halves of the intent rung
 * still named the wrong source — `program-decomposer.md` said "Cite the PRD or the ARCH.
 * If the PRD does not say it, it is not an intent" while its own task prompt said "Do not
 * go looking for the PRD or the ARCH", and `program-judge.md` was written end to end for
 * the BRIEF, a document type deleted two days earlier, including the "the PRD or ARCH when
 * you were not [given a brief]" fallback that the one-path rule removed. 398 tests passed.
 *
 * It is the same cause one level out: a rule stated twice with nothing linking the copies.
 * The two assertions below are the link. The first is what makes the second safe — the
 * judge's trigger and the prompt's wording were coupled through the literal word "BRIEF",
 * so tidying the prompt alone would have silently restored grandparent-grading.
 */
describe("a law names the same source its prompt hands it", () => {
  it("no agent law names `brief` — the artifact was deleted, the word outlived it", () => {
    for (const f of readdirSync(AGENTS).filter((n) => n.endsWith(".md"))) {
      expect(
        law(f.replace(/\.md$/, "")),
        `${f} still names a "brief". Nothing produces one: the single narrowing rung was ` +
        "replaced by epic -> feature. A law pointing at a document that cannot exist either " +
        "does nothing or fires on a stale word in a prompt, and the second is worse.",
      ).not.toMatch(/brief/i);
    }
  });

  for (const name of ["program-decomposer", "program-judge"]) {
    it(`${name} is cut from a FEATURE, with no PRD/ARCH fallback`, () => {
      const text = law(name);
      expect(text, "the intent rung's source").toContain("feature");
      // The fallback is the defect, not the mention: both laws legitimately explain WHY
      // they must not reach past the feature, and that explanation names the PRD. What
      // may not survive is a sentence granting the PRD as a source when something is
      // absent — the two-route shape that let a judge grade against the grandparent.
      for (const fallback of [/PRD or ARCH when you were not/i, /PRD or the ARCH\.\*\* Every intent/i]) {
        expect(text, `${name} still offers the PRD as a fallback source`).not.toMatch(fallback);
      }
    });
  }
});

/** The bar section of a law: the heading through to the next `##`, whitespace-normalised. */
function barOf(name: string): string {
  const text = law(name);
  const at = text.indexOf("## The bar: buildable, not perfect");
  if (at === -1) return "";
  const rest = text.slice(at);
  const next = rest.indexOf(String.fromCharCode(10) + "## ", 1);
  return (next === -1 ? rest : rest.slice(0, next)).replace(/\s+/g, " ").trim();
}

describe("the bar is the same bar at every level", () => {
  // The bar is prose in three prompts, which is the duplication this file exists to
  // watch — and building an injection mechanism for one paragraph would be exactly the
  // over-engineering the bar itself argues against. Comparing the sections is
  // proportionate: it costs a function and fails the moment one judge is loosened or
  // tightened alone.
  //
  // It compares the WHOLE section, not marker phrases. The first version asserted two
  // strings were present — the heading and the question — which meant any prompt could
  // delete the uncertainty rule, the unpinned-property rule, or either cost-of-being-
  // wrong clause and all three tests still passed, while the file's stated purpose is to
  // detect exactly that. External review caught it on 2026-09-13; a check that cannot
  // detect its own subject is the failure mode this whole file is about.
  //
  // Why it changed. The old default was "do not soften", and plan-judge's sharpest form
  // was "when uncertain whether intent text supports a unit, it does not" — fail on doubt.
  // Six such checks ANDed produced a 48% rejection rate at the program rung: six checks at
  // 90% each pass 53% of the time. Nobody had done that arithmetic; strictness compounds,
  // and every rejection costs roughly twelve dollars and buys a document that is DIFFERENT
  // rather than better.
  // Every judge that HAS a bar, not a subset. `ticket-judge` was written with a shortened
  // version of it — which is how a bar drifts: not by anyone loosening it, but by the next
  // one being written from memory. The whole point of comparing the sections is that this
  // list grows when a judge does.
  const JUDGES = ["narrowing-judge", "program-judge", "plan-judge", "ticket-judge"] as const;

  for (const name of JUDGES) {
    it(`${name} states the bar at all`, () => {
      expect(barOf(name), `${name}.md has no "## The bar" section`).not.toBe("");
      expect(barOf(name)).toContain("Would the rung below produce WRONG WORK");
      expect(law(name), "the old fail-on-doubt default").not.toContain("Do not soften");
    });
  }

  it("and states it in the SAME WORDS as the others — every clause, not just the heading", () => {
    const [first, ...rest] = JUDGES;
    for (const other of rest) {
      expect(
        barOf(other),
        `${other}.md's bar differs from ${first}.md's. One judge has been loosened or ` +
        "tightened alone, which is how sibling gates start ruling differently on identical work.",
      ).toBe(barOf(first));
    }
  });
});

describe("...and where it is still stated twice, the two must agree", () => {
  for (const { law: name, validator, keys } of STILL_DUPLICATED) {
    it(`${name} asks for every key ${validator} requires`, () => {
      const text = law(name);
      for (const key of keys) {
        // The QUOTED key, not a substring. `toContain("nothing_dropped")` is satisfied by
        // `nothing_droppedX`, so the first version of this test did not detect a renamed
        // key at all — verified by renaming one and watching it pass. A detector that
        // cannot detect is the failure mode this whole file is about, one level in.
        expect(
          asksFor(text, key),
          `${validator} requires "${key}" but ${name}.md never asks the judge for it — ` +
          "a verdict that cannot pass, and nothing says so until one is refused in production",
        ).toBe(true);
      }
    });
  }

  it("covers every judge on disk, so a new one cannot be added unwatched", () => {
    // The first version of this compared the list above to a FIXED LITERAL of the same
    // names — a test that can only fail if someone edits both halves inconsistently, which
    // is to say it guarded nothing. It is the third time this session a guard could not
    // detect the thing it claimed to; the lesson is that a check whose input is the thing
    // being checked is not a check.
    //
    // So the judge set is read from disk. Add a sixth judge and this fails until it is
    // either single-sourced or watched.
    const onDisk = readdirSync(AGENTS)
      .filter((f) => f.endsWith("-judge.md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();

    const accounted = [...STILL_DUPLICATED.map((d) => d.law), ...SINGLE_SOURCED.map((s) => s.law)].sort();
    expect(onDisk, "a judge on disk is neither single-sourced nor watched for drift").toEqual(accounted);
  });
});
