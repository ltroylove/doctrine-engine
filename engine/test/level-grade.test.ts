import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EvidenceSpec } from "../src/envelope.js";
import { gradeSlug, levelGradeRel, levelPassed, readLevelGrade, runLevelGrade } from "../src/grade.js";

const LF = String.fromCharCode(10);
const tmp = mkdtempSync(join(tmpdir(), "doctrine-lg-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** An arena with one committed file, so HEAD exists and the grade has something to commit onto. */
function makeArena(): string {
  const dir = mkdtempSync(join(tmp, "arena-"));
  gitIn(dir, ["init", "-b", "development"]);
  mkdirSync(join(dir, ".doctrine"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "arena" + LF);
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-q", "-m", "seed"]);
  return dir;
}

const check = (run: string): EvidenceSpec => ({ kind: "command", run, expect: "exit 0" });

describe("the feature and epic grades — the record IS the artifact (ADR-0003)", () => {
  it("commits a PASS where the next tick can read it, without a status field to flip", () => {
    // A feature is a heading and has no status; an epic no longer stores one either.
    // So the record is what says this level is closed, and an uncommitted one would make
    // the loop stateful at the one rung ADR-0003 calls the ratchet.
    const arena = makeArena();
    const head = gitIn(arena, ["rev-parse", "HEAD"]);
    const out = runLevelGrade(arena, "feature", { id: "ep-billing#1.2", evidence: [check("exit 0")] }, head);

    expect(out.kind).toBe("pass");
    expect(levelPassed(arena, "feature", "ep-billing#1.2")).toBe(true);
    // Tracked files only. The timestamped run directory beside it — the logs each command
    // printed — stays untracked, exactly as the intent grade has always left it: an
    // observer sweeps those up as housekeeping. What must be committed is the RECORD,
    // because that is the half the next tick reads rather than a human.
    expect(gitIn(arena, ["status", "--porcelain", "-uno"])).toBe("");
    const committed = gitIn(arena, ["show", "--name-only", "--format=", "HEAD"]).split(LF).map((s) => s.trim());
    expect(committed).toContain(levelGradeRel("feature", "ep-billing#1.2").split(String.fromCharCode(92)).join("/"));
  });

  it("a level carrying NO acceptance is ungraded, never a pass", () => {
    // The distinction an earlier change paid for, one field over: a criterion nothing names is absent
    // from the satisfied set, not satisfied by default. Closing a feature because its
    // Acceptance bullet said (none) would let the ratchet be switched off by omission.
    const arena = makeArena();
    const head = gitIn(arena, ["rev-parse", "HEAD"]);
    const out = runLevelGrade(arena, "feature", { id: "ep-billing#1.1", evidence: [] }, head);

    expect(out.kind).toBe("ungraded");
    expect(levelPassed(arena, "feature", "ep-billing#1.1")).toBe(false);
    // Recorded rather than thrown: the observer needs to see WHICH level cannot close, and
    // a throw over a missing bullet would take the supervisor down with it.
    const rec = readLevelGrade(arena, "feature", "ep-billing#1.1");
    expect(rec?.verdict).toBe("ungraded");
    expect(rec?.detail).toContain("carries no acceptance");
  });

  it("records a FAIL with the signature the gap ratchet re-asks on", () => {
    const arena = makeArena();
    const head = gitIn(arena, ["rev-parse", "HEAD"]);
    const out = runLevelGrade(arena, "feature", { id: "ep-billing#1.3", evidence: [check("exit 3")] }, head);

    expect(out.kind).toBe("fail");
    if (out.kind !== "fail") return;
    expect(out.failureLog).toContain("exit: 3");
    expect(levelPassed(arena, "feature", "ep-billing#1.3")).toBe(false);
    expect(out.record.signature).not.toBe("");
  });

  it("a pass is NOT keyed on HEAD — a sibling merging does not un-pass a feature", () => {
    // The difference from `intentSettled`, which answers "worth asking again at this
    // commit" and clears when anything lands. Re-running a passing suite every tick after
    // it passed makes the loop slower the more of the program is finished.
    const arena = makeArena();
    const head = gitIn(arena, ["rev-parse", "HEAD"]);
    runLevelGrade(arena, "feature", { id: "ep-billing#1.2", evidence: [check("exit 0")] }, head);
    writeFileSync(join(arena, "sibling.ts"), "export const x = 1;" + LF);
    gitIn(arena, ["add", "-A"]);
    gitIn(arena, ["commit", "-q", "-m", "a sibling slice lands"]);
    expect(gitIn(arena, ["rev-parse", "HEAD"])).not.toBe(head);
    expect(levelPassed(arena, "feature", "ep-billing#1.2")).toBe(true);
  });

  it("keeps a feature's record apart from an epic's of the same name", () => {
    const arena = makeArena();
    const head = gitIn(arena, ["rev-parse", "HEAD"]);
    runLevelGrade(arena, "epic", { id: "ep-billing", evidence: [check("exit 1")] }, head);
    runLevelGrade(arena, "feature", { id: "ep-billing", evidence: [check("exit 0")] }, head);
    expect(levelPassed(arena, "epic", "ep-billing")).toBe(false);
    expect(levelPassed(arena, "feature", "ep-billing")).toBe(true);
  });

  it("a feature id never becomes a path fragment separator", () => {
    // `ep-x#1.2` is legal as a filename and is a URL fragment everywhere a path becomes a
    // URL or a gh argument. Sanitised once, where the id becomes a name.
    expect(gradeSlug("ep-billing#1.2")).toBe("ep-billing--1.2");
    expect(levelGradeRel("feature", "ep-billing#1.2")).not.toContain("#");
    const arena = makeArena();
    runLevelGrade(arena, "feature", { id: "ep-billing#1.2", evidence: [check("exit 0")] }, gitIn(arena, ["rev-parse", "HEAD"]));
    expect(existsSync(join(arena, levelGradeRel("feature", "ep-billing#1.2")))).toBe(true);
  });

  it("re-grading overwrites in place rather than accumulating a record per run", () => {
    const arena = makeArena();
    const head = gitIn(arena, ["rev-parse", "HEAD"]);
    runLevelGrade(arena, "feature", { id: "ep-billing#1.2", evidence: [check("exit 1")] }, head);
    expect(levelPassed(arena, "feature", "ep-billing#1.2")).toBe(false);
    runLevelGrade(arena, "feature", { id: "ep-billing#1.2", evidence: [check("exit 0")] }, head);
    expect(levelPassed(arena, "feature", "ep-billing#1.2")).toBe(true);
    const body = JSON.parse(readFileSync(join(arena, levelGradeRel("feature", "ep-billing#1.2")), "utf8")) as { runs: unknown[] };
    expect(body.runs).toHaveLength(1);
  });
});
