import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assembleBuildOutPrompt, buildOutTimeoutMs, epicPathOf, runBuildOut, type BuildOutContext } from "../src/build-out.js";
import type { RunAgentFn } from "../src/judge.js";
import type { SpawnRunResult } from "../src/spawn.js";
import { parseWorkUnit, type WorkUnit } from "../src/work-unit.js";

const LF = String.fromCharCode(10);
/** git checks files out with CRLF on Windows, so "unchanged" is asserted on content. */
const norm = (t: string): string => t.replace(/\r\n/g, LF);
const tmp = mkdtempSync(join(tmpdir(), "doctrine-bo-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

const UNIT_PATH = "work/wu-invoice-push.md";

/**
 * The scaffold, as an epic ACT would have minted it: what it delivers, what it waits on,
 * why it exists, and nothing at all about how.
 */
const SCAFFOLD = [
  "---",
  "id: wu-invoice-push",
  "title: Invoice push",
  "tier: reversible",
  "budget_usd: 11",
  "status: scaffold",
  "parent: ep-invoicing#1.2",
  "delivers: [C3.1]",
  "renders: [C4.1]",
  "depends_on: [C1.1]",
  "---",
  "## Intent",
  "",
  "Invoices are pushed by hand today, one at a time, and the person doing it is the",
  "only record that it happened.",
  "",
].join(LF);

/** What a well-behaved ACT writes: evidence added, prose appended, status drafted. */
const BUILT = [
  "---",
  "id: wu-invoice-push",
  "title: Invoice push",
  "tier: reversible",
  "budget_usd: 11",
  "status: draft",
  "parent: ep-invoicing#1.2",
  "delivers: [C3.1]",
  "renders: [C4.1]",
  "depends_on: [C1.1]",
  "evidence:",
  "  - kind: command",
  '    run: "npx tsx -e \'require(\\"./src/push.ts\\")\'"',
  '    expect: "exit 0"',
  "---",
  "## Intent",
  "",
  "Invoices are pushed by hand today, one at a time, and the person doing it is the",
  "only record that it happened.",
  "",
  "## Spec",
  "",
  "Add `src/push.ts` exporting `pushInvoices`.",
  "",
].join(LF);

function makeArena(): string {
  const dir = mkdtempSync(join(tmp, "arena-"));
  gitIn(dir, ["init", "-b", "development"]);
  mkdirSync(join(dir, "work"), { recursive: true });
  mkdirSync(join(dir, "context"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export const x = 1;" + LF);
  writeFileSync(join(dir, "context", "contracts.md"), "# Contracts" + LF);
  writeFileSync(join(dir, UNIT_PATH), SCAFFOLD);
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-q", "-m", "seed"]);
  return dir;
}

const okSpawn = (): SpawnRunResult => ({
  spawnFailed: false, exitCode: 0, signal: null, timedOut: false, outage: false,
  logPath: "x", resultMessage: { type: "result", subtype: "success", total_cost_usd: 0.2 },
});

const AGENT_DEF = join(tmp, "build-out-law.md");
writeFileSync(AGENT_DEF, ["---", "name: build-out", "---", "Append the spec. Change nothing above it.", ""].join(LF));

function scaffoldUnit(): WorkUnit {
  const res = parseWorkUnit(SCAFFOLD);
  if (!res.ok) throw new Error(`fixture must parse: ${res.errors.join("; ")}`);
  return res.unit;
}

let n = 0;
function ctx(arenaDir: string, runAgent: RunAgentFn, extra: Partial<BuildOutContext> = {}): BuildOutContext {
  return {
    unit: scaffoldUnit(),
    arenaDir,
    unitPath: UNIT_PATH,
    logPath: join(tmp, `bo-${n++}.log`),
    agentDefinitionPath: AGENT_DEF,
    budgetUsd: 11,
    runAgent,
    ...extra,
  };
}

/** An ACT that writes `text` into the unit file and nothing else. */
const writes = (text: string): RunAgentFn => async (_p, opts) => {
  writeFileSync(join(opts.cwd, UNIT_PATH), text);
  return okSpawn();
};

describe("runBuildOut — the spec is appended, and the scaffold is not up for negotiation", () => {
  it("promotes a well-formed build-out: draft -> ready, one commit, only the unit staged", () => {
    const arena = makeArena();
    return runBuildOut(ctx(arena, writes(BUILT))).then((out) => {
      expect(out.kind).toBe("built");
      const after = readFileSync(join(arena, UNIT_PATH), "utf8");
      expect(after).toContain("status: ready");
      // The scaffold half survived the round trip intact, bytes included.
      expect(after).toContain("only record that it happened.");
      expect(after).toContain("delivers: [C3.1]");
      const staged = gitIn(arena, ["show", "--name-only", "--format=", "HEAD"]).split(LF).map((l) => l.trim()).filter((l) => l.length > 0);
      expect(staged).toContain(UNIT_PATH);
      // The engine's own ledgers live in .doctrine/ and are appended every tick; sweeping
      // them into a unit's commit is what made a later checkout of that branch refuse.
      expect(staged.some((f) => f.startsWith(".doctrine/"))).toBe(false);
      expect(gitIn(arena, ["status", "--porcelain"])).toBe("");
    });
  });

  it("REFUSES an edit above the line, and leaves the scaffold exactly as it found it", async () => {
    // The case this refusal exists for. The ACT has read the tree, decided the slice is really
    // about two criteria, and rewritten the `## Intent` to match what it is about to
    // build. Both halves of that are the ratchet running backwards.
    const arena = makeArena();
    const rewritten = BUILT
      .replace("delivers: [C3.1]", "delivers: [C3.1, C3.2]")
      .replace("Invoices are pushed by hand today, one at a time, and the person doing it is the",
        "Invoices are pushed by the new sync step, which also reconciles payments, and the");
    const out = await runBuildOut(ctx(arena, writes(rewritten)));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toContain("append contract");
    expect(out.problems.join(" ")).toContain("changed `delivers`");
    expect(out.problems.join(" ")).toContain("body is not a prefix");
    // Reverted wholesale: the scaffold on disk is byte-identical to what was committed,
    // and the tick that follows inherits nothing.
    expect(norm(readFileSync(join(arena, UNIT_PATH), "utf8"))).toBe(SCAFFOLD);
    expect(gitIn(arena, ["status", "--porcelain"])).toBe("");
    // And the spend is still reported, because it was still spent.
    expect(out.spendUsd).toBeGreaterThan(0);
  });

  it("refuses a second unit — the lane is one file, not a directory", async () => {
    // The difference from the decompose rung, and the reason the lane is built from this
    // unit's own path. A build-out that mints a sibling is planning at build time, against
    // whatever tree it happens to be looking at, with no coverage arithmetic near it.
    const arena = makeArena();
    const out = await runBuildOut(ctx(arena, async (_p, opts) => {
      writeFileSync(join(opts.cwd, UNIT_PATH), BUILT);
      writeFileSync(join(opts.cwd, "work", "wu-invented.md"), SCAFFOLD.replace("wu-invoice-push", "wu-invented"));
      return okSpawn();
    }));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toContain("outside");
    expect(out.problems.join(" ")).toContain("wu-invented");
    expect(existsSync(join(arena, "work", "wu-invented.md"))).toBe(false);
    expect(norm(readFileSync(join(arena, UNIT_PATH), "utf8"))).toBe(SCAFFOLD);
  });

  it("lets it add a contract to contracts.md, as a section — the exposure ADR-0001 names", async () => {
    const arena = makeArena();
    const out = await runBuildOut(ctx(arena, async (_p, opts) => {
      writeFileSync(join(opts.cwd, UNIT_PATH), BUILT);
      writeFileSync(join(opts.cwd, "context", "contracts.md"),
        ["# Contracts", "", "## Invoice push", "", "pushInvoices(db): Promise<void>", ""].join(LF));
      return okSpawn();
    }));
    expect(out.kind).toBe("built");
    expect(readFileSync(join(arena, "context", "contracts.md"), "utf8")).toContain("pushInvoices");
  });

  it("refuses a contract written above the first section, where nothing could protect it", async () => {
    // This test used to ACCEPT exactly this, and PR #94's second review read it as the
    // proof of the gap: an unheaded line below `# Contracts` had no representation in the
    // section comparison, so a later build-out could rewrite that interface and pass.
    const arena = makeArena();
    const out = await runBuildOut(ctx(arena, async (_p, opts) => {
      writeFileSync(join(opts.cwd, UNIT_PATH), BUILT);
      writeFileSync(join(opts.cwd, "context", "contracts.md"), "# Contracts" + LF + LF + "pushInvoices(db): Promise<void>" + LF);
      return okSpawn();
    }));
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.problems.join(" ")).toContain("as a `## <name>` section");
    expect(norm(readFileSync(join(arena, "context", "contracts.md"), "utf8"))).toBe("# Contracts" + LF);
  });

  it("refuses a build-out that rewrites a contract other units were built against", async () => {
    // `plan-judge`'s surviving clause (ADR-0001), and the half it never asked. A judge
    // looking for rivals looks at what was ADDED; an ACT that quietly changes a signature
    // adds nothing, and every unit already built against that interface is now wrong.
    const arena = makeArena();
    const owned = ["# Contracts", "", "## The actor parameter", "",
      "Every writing function takes `actor` after `db`.", ""].join(LF);
    writeFileSync(join(arena, "context", "contracts.md"), owned);
    gitIn(arena, ["add", "-A"]);
    gitIn(arena, ["commit", "-q", "-m", "an owned contract"]);

    const out = await runBuildOut(ctx(arena, async (_p, opts) => {
      writeFileSync(join(opts.cwd, UNIT_PATH), BUILT);
      writeFileSync(join(opts.cwd, "context", "contracts.md"), owned.replace("after `db`", "FIRST"));
      return okSpawn();
    }));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toContain("append-only");
    expect(out.problems.join(" ")).toContain("The actor parameter");
    // Reverted wholesale: the contract and the scaffold are both as they were committed.
    expect(norm(readFileSync(join(arena, "context", "contracts.md"), "utf8"))).toBe(owned);
    expect(norm(readFileSync(join(arena, UNIT_PATH), "utf8"))).toBe(SCAFFOLD);
  });

  it("refuses an ACT that promotes itself — the engine owns the transition", async () => {
    const arena = makeArena();
    const out = await runBuildOut(ctx(arena, writes(BUILT.replace("status: draft", "status: ready"))));
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.problems.join(" ")).toContain('left status "ready"');
    expect(norm(readFileSync(join(arena, UNIT_PATH), "utf8"))).toBe(SCAFFOLD);
  });

  it("a run that wrote nothing is a failure, not an honest empty answer", async () => {
    // The asymmetry with the decompose rung is deliberate. "Nothing to slice" is a real
    // thing for a planner to say; "this unit needs no spec" is not, because the unit
    // already exists and was scaffolded because somebody decided it had to be built.
    const arena = makeArena();
    const out = await runBuildOut(ctx(arena, async () => okSpawn()));
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toContain("wrote no spec");
  });

  it("carries an outage through as an outage, so it is retried rather than counted a defect", async () => {
    const arena = makeArena();
    const out = await runBuildOut(ctx(arena, async () => ({
      spawnFailed: false, exitCode: 1, signal: null, timedOut: false, outage: true,
      logPath: "x", resultMessage: null,
    })));
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.outage).toBe(true);
  });

  it("the timeout scales with the budget, so a big unit is not killed mid-flight", () => {
    // The budget is the money bound; the clock only catches a hang. When the clock fires
    // instead, the work is thrown away AND the killed run returns no result message, so
    // real spend is recorded as $0 and the daily gate cannot see it.
    expect(buildOutTimeoutMs(2)).toBe(15 * 60_000);
    expect(buildOutTimeoutMs(11)).toBe(44 * 60_000);
    expect(buildOutTimeoutMs(40)).toBe(60 * 60_000);
  });
});

describe("build-out is pointed at its epic (PR #97 review)", () => {
  it("names the unit's epic and feature, and says the bindings there are its to build", () => {
    // The epic's "What binds it" was read by nothing downstream: build-out got the unit's
    // scaffold, the implementer the unit's body. A binding the epic named reached no stage
    // that builds anything.
    const arena = makeArena();
    const prompt = assembleBuildOutPrompt(ctx(arena, writes(BUILT)));
    expect(prompt).toContain("docs/program/epics/ep-invoicing.md");
    expect(prompt).toContain("ep-invoicing#1.2");
    expect(prompt).toContain("What binds it");
  });

  it("derives the epic from the parent, and says nothing when there is no parent", () => {
    expect(epicPathOf({ ...scaffoldUnit(), parent: "ep-close#1.3" })).toEqual({ epicPath: "docs/program/epics/ep-close.md", feature: "ep-close#1.3" });
    const { parent: _drop, ...orphan } = scaffoldUnit();
    expect(epicPathOf(orphan)).toBeNull();
  });
});

describe("an observer's pause written mid-ACT", () => {
  it("does not fail the ACT, and survives it", async () => {
    // Exactly what happened live: the observer paused the loop to restart it while a paid ACT
    // was running. The ACT was failed as 'modifying engine-owned state' and the restore deleted
    // the pause — so the loop did not stop, and started the next paid run.
    const arena = makeArena();
    const out = await runBuildOut(ctx(arena, async (_p, opts) => {
      writeFileSync(join(opts.cwd, UNIT_PATH), BUILT);
      mkdirSync(join(opts.cwd, ".doctrine"), { recursive: true });
      writeFileSync(join(opts.cwd, ".doctrine", "pause"), "observer pause: restarting onto a fix" + LF);
      return okSpawn();
    }));
    expect(out.kind).toBe("built");
    expect(existsSync(join(arena, ".doctrine", "pause")), "the loop must still stop").toBe(true);
  });
});
