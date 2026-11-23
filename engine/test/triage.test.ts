import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseCriteria } from "../src/coverage.js";
import { parseNarrowing, type Narrowing } from "../src/narrowing.js";
import { runTriageAct, TRIAGE_CHECKS } from "../src/ticket-act.js";
import { MemoryTicketStore, TICKET_ACT_DENY, type RawIssue } from "../src/ticket-store.js";
import { APPROVED_LABEL, NEEDS_TRIAGE_LABEL } from "../src/ticket.js";
import type { SpawnRunResult } from "../src/spawn.js";

/**
 * Triage, end to end and offline: raw issue in, published ticket out.
 *
 * The same shape as every other rung by now — write, free checks, judge once, one
 * correction pass, publish — so what these cover is what is DIFFERENT about this one: the
 * repair/growth split, the mechanical checks standing in for a self-attested checklist,
 * and the approval gate no agent may satisfy.
 */

const tmp = mkdtempSync(join(tmpdir(), "doctrine-triage-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PRD = [
  "# PRD", "", "### C1. Ledger", "",
  "- **machine** `C1.1` Import produces the fixture's expected lines.",
  "- **machine** `C1.2` Close with one uncategorised line refuses.",
  "",
].join("\n");

function narrowing(id: string, level: string, delivers: string[], parent?: string): Narrowing {
  const res = parseNarrowing([
    "---", `id: ${id}`, `level: ${level}`, `title: ${id}`, "status: active",
    ...(parent !== undefined ? [`parent: ${parent}`] : []),
    `delivers: [${delivers.join(", ")}]`, "---", "the slice", "",
  ].join("\n"), `docs/program/${level}s/${id}.md`);
  if (!res.ok) throw new Error(res.errors.join("; "));
  return res.narrowing;
}

const EPIC = narrowing("ep-ledger", "epic", ["C1.1", "C1.2"]);
const FEATURE = narrowing("ft-import", "feature", ["C1.1"], "ep-ledger");

function arena(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "docs", "program"), { recursive: true });
  mkdirSync(join(dir, ".doctrine", "runs"), { recursive: true });
  writeFileSync(join(dir, "docs", "program", "PRD.md"), PRD);
  writeFileSync(join(dir, "docs", "program", "ARCH.md"), "# ARCH\nSQLite.\n");
  writeFileSync(join(dir, "src", "import.ts"), "export const read = () => 1;\n");
  writeFileSync(join(dir, "law.md"), "---\nname: tt\n---\ntriage law\n");
  writeFileSync(join(dir, "judge-law.md"), "---\nname: tj\n---\njudge law\n");
  writeFileSync(join(dir, "fixer-law.md"), "---\nname: tf\n---\nfixer law\n");
  // A real repository, because the containment tripwire asks git what changed. The arena
  // always is one; the first version of this file was not, and the tripwire failed on the
  // harness rather than on anything an ACT did.
  execFileSync("git", ["init", "-q", "-b", "development"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

const ISSUE: RawIssue = {
  number: 445,
  title: "Import drops the final line",
  body: "Importing the March statement gives 41 lines; the file has 42.",
  url: "https://github.com/o/r/issues/445",
  labels: [NEEDS_TRIAGE_LABEL],
};

const TICKET = (over: Record<string, string> = {}): string => {
  const fields: Record<string, string> = {
    title: "Import drops the final line",
    kind: "repair", type: "bug", tier: "reversible",
    delivers: "[C1.1]", home: "ft-import",
    files: "[src/import.ts]", references: "[src/import.ts]",
    intents: "[repair the off-by-one in the reader]",
    ...over,
  };
  return ["---", ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), "---", "The reader stops one line early.", ""].join("\n");
};

const okSpawn = (cost = 0.5): SpawnRunResult => ({
  spawnFailed: false, exitCode: 0, signal: null, timedOut: false, outage: false,
  logPath: "x", resultMessage: { type: "result", subtype: "success", total_cost_usd: cost },
} as unknown as SpawnRunResult);

const PASS = { verdict: "pass", checks: TRIAGE_CHECKS.map((c) => ({ check: c, ok: true, cite: "read it" })), problems: [] };

let fixPrompts: string[] = [];
beforeEach(() => { fixPrompts = []; });

function agents(ticket: string | undefined, verdict: unknown, fix?: string, reachInto?: { dir: string; rel: string }) {
  return async (prompt: string, opts: { cwd: string; logPath: string }): Promise<SpawnRunResult> => {
    writeFileSync(opts.logPath, "");
    // The containment failure, on purpose: `Write` accepts an absolute path, so an ACT
    // pointed at a scratch directory can still reach into the repository.
    if (reachInto !== undefined && !prompt.includes("Write your verdict JSON to EXACTLY:")) {
      writeFileSync(join(reachInto.dir, reachInto.rel), "rewritten by an ACT" + String.fromCharCode(10));
    }
    const m = /Write your verdict JSON to EXACTLY: (.+)/.exec(prompt);
    if (prompt.includes("# The ticket to correct")) {
      fixPrompts.push(prompt);
      if (fix !== undefined) writeFileSync(join(opts.cwd, "ticket.md"), fix);
      return okSpawn(0.3);
    }
    if (m) {
      writeFileSync(m[1]!.trim(), JSON.stringify(verdict));
      return okSpawn(0.2);
    }
    if (ticket !== undefined) writeFileSync(join(opts.cwd, "ticket.md"), ticket);
    return okSpawn();
  };
}

function ctx(dir: string, store: MemoryTicketStore, runAgent: ReturnType<typeof agents>) {
  return {
    arenaDir: dir,
    issue: ISSUE,
    store,
    lint: { criteria: parseCriteria(PRD), epics: [EPIC], features: [FEATURE] },
    prdPath: "docs/program/PRD.md",
    archPath: "docs/program/ARCH.md",
    logPath: join(dir, ".doctrine", "runs", "t.log"),
    agentDefinitionPath: join(dir, "law.md"),
    judgeAgentPath: join(dir, "judge-law.md"),
    fixerAgentPath: join(dir, "fixer-law.md"),
    budgetUsd: 8,
    runAgent,
  };
}

describe("triage: a raw issue becomes a ticket somebody can build from", () => {
  it("publishes the triaged ticket to its own issue and drops needs-triage", async () => {
    const dir = arena("publishes");
    const store = new MemoryTicketStore([ISSUE]);
    const out = await runTriageAct(ctx(dir, store, agents(TICKET(), PASS)));

    expect(out.kind).toBe("triaged");
    if (out.kind !== "triaged") return;
    // The issue IS the ticket. No file, nothing to keep in step.
    expect(out.id).toBe("M-445");
    expect(store.published.get(445)).toContain("kind: repair");
    const issue = store.read(445)!;
    expect(issue.labels).toContain("type:bug");
    expect(issue.labels).toContain("tier:reversible");
    expect(issue.labels, "triage is what closes out needs-triage, for every source").not.toContain(NEEDS_TRIAGE_LABEL);
  });

  it("the labels are DERIVED, so they cannot disagree with the fields", async () => {
    const dir = arena("labels");
    const store = new MemoryTicketStore([{ ...ISSUE, labels: [NEEDS_TRIAGE_LABEL, "kind:growth", "type:perf"] }]);
    await runTriageAct(ctx(dir, store, agents(TICKET(), PASS)));

    // The stale classification is REMOVED, not merely added to. A ticket re-triaged after
    // its classification changed would otherwise carry both, and every reader would pick
    // whichever it saw first.
    const labels = store.read(445)!.labels;
    expect(labels).toContain("kind:repair");
    expect(labels).not.toContain("kind:growth");
    expect(labels).not.toContain("type:perf");
  });

  it("a mechanical finding reaches the correction pass, and the fix publishes", async () => {
    // The path does not resolve — decided for free, before any judge is paid.
    const dir = arena("mechanical");
    const store = new MemoryTicketStore([ISSUE]);
    const out = await runTriageAct(ctx(dir, store,
      agents(TICKET({ files: "[src/nope.ts]" }), PASS, TICKET())));

    expect(out.kind).toBe("triaged");
    if (out.kind !== "triaged") return;
    expect(out.findingsFixed).toBe(1);
    expect(fixPrompts[0]!).toContain("does not exist in the repository");
    expect(fixPrompts[0]!).toContain("this is the complete list");
  });

  it("a mechanical finding that SURVIVES the correction is refused", async () => {
    const dir = arena("survives");
    const store = new MemoryTicketStore([ISSUE]);
    const out = await runTriageAct(ctx(dir, store,
      // It edited the body and left the bad path alone.
      agents(TICKET({ files: "[src/nope.ts]" }), PASS, TICKET({ files: "[src/nope.ts]", title: "Reworded" }))));

    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toContain("survived the correction pass");
    expect(store.published.has(445), "a refused ticket never reaches the issue").toBe(false);
  });

  it("a correction pass that changed nothing is refused", async () => {
    const dir = arena("noop");
    const store = new MemoryTicketStore([ISSUE]);
    const judgeFound = { ...PASS, verdict: "fail", checks: [{ check: TRIAGE_CHECKS[0], ok: false, cite: "the PRD has no criterion for CSV — this is growth" }, ...PASS.checks.slice(1)] };
    const out = await runTriageAct(ctx(dir, store, agents(TICKET(), judgeFound, TICKET())));

    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toContain("changed nothing");
  });

  it("the judge is asked ONCE", async () => {
    const dir = arena("once");
    const store = new MemoryTicketStore([ISSUE]);
    let judgeSpawns = 0;
    const inner = agents(TICKET({ files: "[src/nope.ts]" }), PASS, TICKET());
    const out = await runTriageAct(ctx(dir, store, async (prompt, opts) => {
      if (/Write your verdict JSON to EXACTLY:/.test(prompt)) judgeSpawns += 1;
      return inner(prompt, opts);
    }));

    expect(out.kind).toBe("triaged");
    expect(judgeSpawns).toBe(1);
    expect(fixPrompts).toHaveLength(1);
  });

  it("a judge that skipped a check fails the RUN, and pays no fixer", async () => {
    const dir = arena("skipped");
    const store = new MemoryTicketStore([ISSUE]);
    const out = await runTriageAct(ctx(dir, store,
      agents(TICKET(), { ...PASS, checks: PASS.checks.slice(0, 1) })));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.problems.join(" ")).toMatch(/reported no result for/);
    expect(fixPrompts).toHaveLength(0);
  });

  it("a refusal that names nothing fails the RUN", async () => {
    // The same rule, in the same words, as every other rung: a finding that names nothing
    // cannot be acted on, so it is not a finding.
    const dir = arena("empty-refusal");
    const store = new MemoryTicketStore([ISSUE]);
    const out = await runTriageAct(ctx(dir, store, agents(TICKET(), { ...PASS, verdict: "fail" })));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.problems.join(" ")).toMatch(/without saying what is wrong/);
  });

  it("a ticket that does not parse is the one hard refusal", async () => {
    const dir = arena("unparseable");
    const store = new MemoryTicketStore([ISSUE]);
    const out = await runTriageAct(ctx(dir, store, agents("no frontmatter here", PASS)));

    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toContain("no YAML frontmatter");
  });
});

describe("the triage ACTs are contained", () => {
  it("an ACT that rewrites the PRD fails the run and is reverted", async () => {
    // Both passes hold `Bash` and `Write` with the repository in `addDirs` — the triager
    // to grep the codebase, the fixer to verify a path before naming it. The prompts say
    // the run writes only its scratch ticket, and a prompt is not a boundary: a `sed -i`
    // against the PRD would persist into the target's uncommitted state and the NEXT tick
    // would plan against it.
    //
    // The narrowing rung has had this guard since it was built. This one copied that
    // rung's shape without copying its guard, and external review caught it.
    const dir = arena("reaches-in");
    const store = new MemoryTicketStore([ISSUE]);
    const out = await runTriageAct(ctx(dir, store,
      agents(TICKET(), PASS, undefined, { dir, rel: "docs/program/PRD.md" })));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toMatch(/wrote into the repository/);
    // Reverted, not merely reported. Line endings normalised: the revert is a git
    // checkout, and on Windows that restores through autocrlf.
    const lf = (x: string): string => x.split(String.fromCharCode(13)).join("");
    expect(lf(readFileSync(join(dir, "docs", "program", "PRD.md"), "utf8"))).toBe(lf(PRD));
    expect(store.published.has(445)).toBe(false);
  });
});

describe("the approval gate is one no agent can satisfy", () => {
  it("the engine's own publish never applies `approved`", async () => {
    // A gate the loop can satisfy on its own is not a gate. The engine writes only the
    // derived labels, and `approved` is not among them.
    const dir = arena("no-self-approve");
    const store = new MemoryTicketStore([ISSUE]);
    await runTriageAct(ctx(dir, store, agents(TICKET(), PASS)));
    expect(store.read(445)!.labels).not.toContain(APPROVED_LABEL);
  });

  it("the deny list removes the CAPABILITY, not a list of spellings", () => {
    // The first version of this list denied `--add-label approved` in three spellings and
    // four `gh issue` verbs. That reads like a boundary and is not one: `gh api -X PATCH
    // repos/o/r/issues/445 -f labels[]=approved` sets the label without matching any of
    // them. A deny list built from spellings is a list of the ways somebody thought of.
    //
    // So `gh` goes entirely. These ACTs have no business calling the tracker: the triager
    // is handed the issue text in its prompt, writes to a scratch file, and the ENGINE
    // publishes. External review caught it, 2026-09-13.
    const joined = TICKET_ACT_DENY.join(" ");
    expect(joined).toContain("gh api");
    expect(joined).toContain("Bash(gh:*)");
    // And the raw route underneath the CLI, which is the same request without it.
    expect(joined).toContain("api.github.com");
    // The label name is deliberately NOT what this is built on any more.
    expect(APPROVED_LABEL).toBe("approved");
  });

  it("only an approved issue is offered for planning", () => {
    const store = new MemoryTicketStore([
      { ...ISSUE, number: 1, labels: ["type:bug"] },
      { ...ISSUE, number: 2, labels: ["type:bug", APPROVED_LABEL] },
      { ...ISSUE, number: 3, labels: [NEEDS_TRIAGE_LABEL] },
    ]);
    expect(store.approved().map((i) => i.number)).toEqual([2]);
    expect(store.needingTriage().map((i) => i.number)).toEqual([3]);
  });
});
