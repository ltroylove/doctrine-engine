import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeDenySettings } from "../src/containment.js";
import { describeBreaches, guardrailBreaches } from "../src/guardrails.js";
import { REVIEW_FIX_DENY } from "../src/review.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-guardrails-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * Two layers, because one of them provably cannot be enough. Deny rules match command
 * TEXT; a path is not resolved until the shell runs it, so `cd .doctrine && sed -i
 * manifest.json` names no denied string and no pattern can catch it (doctrine#11
 * review). The diff check is the layer that does not care how the file was reached.
 */
describe("guardrails — the diff decides, whatever route the agent took", () => {
  it("catches a guarded file however it was edited, because it reads the result", () => {
    // Every one of these is a route around command-text matching.
    for (const path of [
      ".doctrine/manifest.json",
      ".doctrine/claude-deny-settings.json",
      ".doctrine/claude-deny-review-fix.json",
      ".doctrine/pause",
      ".doctrine/ticks.jsonl",
    ]) {
      const breaches = guardrailBreaches([path, "src/app.ts"]);
      expect(breaches.map((b) => b.path)).toEqual([path]);
    }
  });

  it("lets ordinary work through, including the judge's own verdict directory", () => {
    expect(guardrailBreaches([
      "src/app.ts",
      "test/unit/app.test.ts",
      ".doctrine/runs/wu-x/verdict.json",
      ".doctrine/grades/in-y/grade.json",
      "context/decisions.md",
      "work/wu-x.md",
    ])).toEqual([]);
  });

  it("the refused-plan shelf is engine-owned — an ACT cannot soften its own objections", () => {
    // Added with the shelf itself and nearly missed: a new engine-owned state directory
    // that no guarded entry covered. The list was exact-path only, so it took a
    // directory form to express — which is why `matches` now handles both.
    const breaches = guardrailBreaches([
      "src/billing/push.ts",
      ".doctrine/rejected/objections.md",
      ".doctrine/rejected/in-2026-09-05-invoice-push-paid.md",
    ]);
    expect(breaches.map((b) => b.path)).toEqual([
      ".doctrine/rejected/objections.md",
      ".doctrine/rejected/in-2026-09-05-invoice-push-paid.md",
    ]);
    // And under a worktree prefix, where the tracked copy is the same artefact.
    expect(guardrailBreaches([".doctrine/runs/wu-x/impl/.doctrine/rejected/objections.md"]))
      .toHaveLength(1);
  });

  it("the review-fix rules answer about the review-fix delta, not the whole branch", () => {
    // The two rule sets are about different diffs, and conflating them parked the first
    // application unit on a target. Engine-owned paths are forbidden to everyone, so
    // they are asked of the whole branch. The review-fix rules are about what the fixer
    // did — and the branch also carries what the IMPLEMENTER legitimately wrote first: a
    // contract addition and the unit's own status flip. Judged branch-wide, ordinary
    // implementer work reads as a review-fix breach, and essentially every unit touches
    // contracts.md, so the loop loses each one the moment a finding is addressed.
    const wholeBranch = ["src/core/money.ts", "context/contracts.md", "work/u-x.md"];
    const fixDelta = ["src/core/ids.ts", "test/unit/core/ids.test.ts"];

    // The old behaviour, kept here as the thing that must not happen again.
    expect(guardrailBreaches(wholeBranch, { reviewFix: true }).map((b) => b.path))
      .toEqual(["context/contracts.md", "work/u-x.md"]);

    // Asked properly: the fixer touched no planning input, so nothing is a breach.
    expect(guardrailBreaches(fixDelta, { reviewFix: true, engineOwned: false })).toEqual([]);

    // And it still catches a fixer that DOES re-plan.
    expect(guardrailBreaches([...fixDelta, "work/u-x.md"], { reviewFix: true, engineOwned: false })
      .map((b) => b.path)).toEqual(["work/u-x.md"]);

    // engineOwned: false drops only the engine list — a fixer editing a ledger is still
    // caught by the branch-wide pass, which is the one that carries those rules.
    expect(guardrailBreaches([".doctrine/ticks.jsonl"], { reviewFix: true, engineOwned: false })).toEqual([]);
    expect(guardrailBreaches([".doctrine/ticks.jsonl"]).map((b) => b.path)).toEqual([".doctrine/ticks.jsonl"]);
  });

  it("the review-fix ACT additionally may not touch the plan", () => {
    const changed = ["src/app.ts", "work/wu-x.md", "context/contracts.md", "docs/program/ARCH.md"];
    // An implementer legitimately never writes these either, but the decomposer does,
    // so only the review-fix pass is held to it.
    expect(guardrailBreaches(changed)).toEqual([]);
    const breaches = guardrailBreaches(changed, { reviewFix: true });
    expect(breaches.map((b) => b.path).sort()).toEqual(["context/contracts.md", "docs/program/ARCH.md", "work/wu-x.md"]);
    expect(describeBreaches(breaches)).toContain("review findings never re-plan");
  });

  it("normalises separators, so a Windows path cannot slip past", () => {
    expect(guardrailBreaches([".doctrine\\manifest.json"]).length).toBe(1);
    expect(guardrailBreaches(["work\\wu-x.md"], { reviewFix: true }).length).toBe(1);
  });
});

describe("deny rules — the cheap layer, and its own boundaries", () => {
  it("a guarded directory denies its own name, not only its contents", () => {
    // Every content rule requires the trailing slash, so `rm -rf work` and
    // `mv docs/program /tmp/x` name the directory itself and matched nothing.
    expect(REVIEW_FIX_DENY).toContain("Edit(work)");
    expect(REVIEW_FIX_DENY).toContain("Bash(rm* work)");
    expect(REVIEW_FIX_DENY).toContain("Bash(* mv* docs/program *)");
  });

  it("still keeps ordinary words out: framework/ and network/ contain 'work/'", () => {
    expect(REVIEW_FIX_DENY).not.toContain("Bash(*work/*)");
    expect(REVIEW_FIX_DENY.some((r) => r === "Bash(*work*)")).toBe(false);
  });

  it("the engine's guardrail files are denied to the shell as well as the tools", () => {
    const arena = mkdtempSync(join(tmp, "arena-"));
    const path = writeDenySettings(arena, { doors: [] });
    const deny = (JSON.parse(readFileSync(path, "utf8")) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).toContain("Bash(*.doctrine/manifest.json*)");
    expect(deny).toContain("Bash(*.doctrine/claude-deny-review-fix.json*)");
    expect(deny.some((d) => d.includes(".doctrine/runs"))).toBe(false);
  });
});

describe("the fixer may not author what the re-judge stops looking at", () => {
  it("names the engine's bookkeeping paths as forbidden to a review fix", () => {
    // These are excluded from the diff a RE-judge grades, because openUnitPr writes them on the
    // unit's branch and the judge correctly reads them as changes the unit did not author. That
    // exclusion would be a blind spot if the fixer could author them instead — so it may not.
    for (const path of ["context/decisions.md", "context/defects/2026-09-07-wu-x.md", "context/review-findings/wu-x.md"]) {
      const breaches = guardrailBreaches([path], { reviewFix: true, engineOwned: false });
      expect(breaches.map((b) => b.path)).toContain(path);
    }
  });

  it("still lets the implementer's own work through that same check", () => {
    // The review-fix rules are checked against the FIXER's delta, not the branch, so ordinary unit
    // work is untouched by them.
    const breaches = guardrailBreaches(["src/billing/index.ts", "test/unit/billing/draft.test.ts"], { reviewFix: true, engineOwned: false });
    expect(breaches).toHaveLength(0);
  });
});
