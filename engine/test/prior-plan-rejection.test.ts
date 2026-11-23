import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { priorPlanRejectionForTest as priorPlanRejection } from "../src/dispatch.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-prior-plan-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const LF = String.fromCharCode(10);
const INTENT = "in-x";

function arena(name: string, rows: Array<Record<string, unknown>>): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, ".doctrine"), { recursive: true });
  writeFileSync(join(dir, ".doctrine", "ticks.jsonl"), rows.map((r) => JSON.stringify(r)).join(LF) + LF);
  return dir;
}
const failed = (detail: string) => ({ decision: "decompose-failed", unit: INTENT, detail });
const ok = () => ({ decision: "decompose-decomposed", unit: INTENT });

describe("priorPlanRejection — what the retry is told about the last attempt", () => {
  it("REGRESSION: a lint failure IS feedback — the retry was told nothing and repeated it", () => {
    // Observed live 2026-09-16: the same intent failed lint twice for the same reason, a
    // `title:` beginning with a backtick, in two differently-named units. $10.14 for two
    // attempts at the same attempt, because the reason never reached the second writer.
    const dir = arena("lint-only", [failed("plan lint failed: not valid YAML: reserved character")]);
    expect(priorPlanRejection(dir, INTENT)).toContain("reserved character");
  });

  it("carries an older JUDGE rejection past a newer lint failure — the judge never saw that plan", () => {
    const dir = arena("judge-then-lint", [
      failed("plan-judge rejected: unit 2 invents scope"),
      failed("plan lint failed: not valid YAML"),
    ]);
    const out = priorPlanRejection(dir, INTENT) ?? "";
    expect(out).toContain("invents scope");
    expect(out).toContain("not valid YAML");
  });

  it("DROPS an older lint failure once a newer judge rejection exists — that plan passed lint", () => {
    // External review, PR #87. Reaching the judge proves the newer plan cleared the lint
    // gate, so the older lint error belongs to a plan that no longer exists; telling the
    // retry to fix it points at a file nobody wrote.
    const dir = arena("lint-then-judge", [
      failed("plan lint failed: not valid YAML"),
      failed("plan-judge rejected: unit 2 invents scope"),
    ]);
    const out = priorPlanRejection(dir, INTENT) ?? "";
    expect(out).toContain("invents scope");
    expect(out, "the superseded plan's syntax error").not.toContain("not valid YAML");
  });

  it("a decompose that SUCCEEDED since makes all of it stale", () => {
    const dir = arena("succeeded", [failed("plan lint failed: not valid YAML"), ok()]);
    expect(priorPlanRejection(dir, INTENT)).toBeUndefined();
  });

  it("says nothing about a spawn or truncation failure — there is nothing to act on", () => {
    const dir = arena("spawn", [failed("decompose ACT timed out")]);
    expect(priorPlanRejection(dir, INTENT)).toBeUndefined();
  });
});
