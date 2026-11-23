import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { pauseIfStalled, tick, type TickDeps } from "../src/dispatch.js";
import type { RunAgentFn } from "../src/judge.js";

/**
 * The stall guard: a loop with nothing it can do, while something is still outstanding, pauses
 * with the list instead of idling. One target idled silently for two days and
 * again overnight with escalated units and failed epic grades on disk.
 */

const LF = String.fromCharCode(10);
const tmp = mkdtempSync(join(tmpdir(), "doctrine-stall-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const AGENTS = {
  implementer: fileURLToPath(new URL("../../.claude/agents/implementer.md", import.meta.url)),
  judge: fileURLToPath(new URL("../../.claude/agents/code-judge.md", import.meta.url)),
  decomposer: fileURLToPath(new URL("../../.claude/agents/decomposer.md", import.meta.url)),
  planJudge: fileURLToPath(new URL("../../.claude/agents/plan-judge.md", import.meta.url)),
};
const refuse: RunAgentFn = async () => { throw new Error("no paid ACT may run in these fixtures"); };

function gitIn(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
}

/** An epic document the grade selectors would ask about, or (`done`) one they retired. */
function epicDoc(status: "active" | "done"): string {
  return [
    "---", "id: ep-ledger", "level: epic", "title: ep-ledger", `status: ${status}`, "delivers: [C1.1]",
    "evidence:", "  - kind: command", '    run: "exit 7"', '    expect: "exit 0"', "---", "The slice.", "",
    "### Feature 1.1: slice 1.1", "", "- **Delivers:** C1.1", "- **Renders:** (none)", "- **Depends on:** (none)",
    "- **Acceptance:**", "  - `exit 0` — it works", "",
  ].join(LF);
}

function arena(opts: { escalated?: boolean; epicGrade?: "pass" | "fail"; epicStatus?: "active" | "done" }): string {
  const dir = mkdtempSync(join(tmp, "arena-"));
  gitIn(dir, ["init", "-q", "-b", "development"]);
  mkdirSync(join(dir, ".doctrine"), { recursive: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), [".doctrine/lease/", ".doctrine/runs/", ""].join(LF));
  writeFileSync(join(dir, ".doctrine", "manifest.json"), JSON.stringify({ name: "t", base_branch: "development", doors: [] }));
  if (opts.escalated === true) {
    writeFileSync(join(dir, "work", "wu-stuck.md"), [
      "---", "id: wu-stuck", "title: wu-stuck", "tier: reversible", "status: escalated", "budget_usd: 5",
      "delivers: [C1.1]", "depends_on: []", "evidence:", "  - kind: command", '    run: "exit 0"', '    expect: "exit 0"',
      "---", "## Intent", "", "Because.", "",
    ].join(LF));
  }
  if (opts.epicGrade !== undefined) {
    mkdirSync(join(dir, "docs", "program", "epics"), { recursive: true });
    writeFileSync(join(dir, "docs", "program", "epics", "ep-ledger.md"), epicDoc(opts.epicStatus ?? "active"));
    mkdirSync(join(dir, ".doctrine", "grades", "epic"), { recursive: true });
    writeFileSync(join(dir, ".doctrine", "grades", "epic", "ep-ledger.json"), JSON.stringify({
      subject: "ep-ledger", level: "epic", verdict: opts.epicGrade, at: "2026-10-12T00:00:00Z",
      head: "x", signature: "s", runs: [],
    }));
  }
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-q", "-m", "seed", "--allow-empty"]);
  return dir;
}

const deps = (arenaDir: string): TickDeps => ({ arenaDir, agentDefs: AGENTS, runAgent: refuse });

describe("the stall guard", () => {
  it("pauses with the list when nothing can be done and a unit is escalated", async () => {
    const dir = arena({ escalated: true });
    const r = await tick(deps(dir));
    expect(r.decision).toBe("stalled");
    const pause = readFileSync(join(dir, ".doctrine", "pause"), "utf8");
    expect(pause).toContain("stalled at idle");
    expect(pause).toContain("unit wu-stuck is escalated");
  });

  it("pauses when an epic grade failed and nothing is working on it", async () => {
    const dir = arena({ epicGrade: "fail" });
    const r = await tick(deps(dir));
    expect(r.decision).toBe("stalled");
    expect(readFileSync(join(dir, ".doctrine", "pause"), "utf8")).toContain("epic ep-ledger is fail");
  });

  it("does not count a RETIRED epic's old failure: retirement is not a stall", async () => {
    const dir = arena({ epicGrade: "fail", epicStatus: "done" });
    const r = await tick(deps(dir));
    expect(r.decision).not.toBe("stalled");
    expect(existsSync(join(dir, ".doctrine", "pause"))).toBe(false);
  });

  it("never overwrites a pause an observer wrote meanwhile", () => {
    const dir = arena({ escalated: true });
    writeFileSync(join(dir, ".doctrine", "pause"), "observer: holding for the release\n");
    const r = pauseIfStalled(dir, "idle");
    expect(r?.decision).toBe("stalled");
    expect(readFileSync(join(dir, ".doctrine", "pause"), "utf8")).toBe("observer: holding for the release\n");
  });

  it("stays a quiet idle when nothing is outstanding", async () => {
    const dir = arena({ epicGrade: "pass" });
    const r = await tick(deps(dir));
    expect(r.decision).toBe("idle");
    expect(existsSync(join(dir, ".doctrine", "pause"))).toBe(false);
  });
});
