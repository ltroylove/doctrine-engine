import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseCriteria } from "../src/coverage.js";
import { runNarrowingAct, type NarrowingContext } from "../src/narrowing-act.js";
import { MemoryNarrowingStore } from "../src/narrowing-store.js";
import { parseNarrowing, type Narrowing } from "../src/narrowing.js";
import type { SpawnRunResult } from "../src/spawn.js";
import { parseWorkUnit } from "../src/work-unit.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-narrowing-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PRD = [
  "# PRD",
  "",
  "### C1. Ledger",
  "",
  "- **machine** `C1.1` Import produces the fixture's expected lines.",
  "- **machine** `C1.2` Close with one uncategorized line refuses.",
  "",
].join("\n");

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function arena(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "docs", "program", "epics"), { recursive: true });
  mkdirSync(join(dir, "docs", "program", "features"), { recursive: true });
  mkdirSync(join(dir, ".doctrine", "runs"), { recursive: true });
  writeFileSync(join(dir, "docs", "program", "PRD.md"), PRD);
  writeFileSync(join(dir, "law.md"), ["---", "name: nd", "---", "narrowing law", ""].join("\n"));
  writeFileSync(join(dir, "judge-law.md"), ["---", "name: nj", "---", "judge law", ""].join("\n"));
  writeFileSync(join(dir, "fixer-law.md"), ["---", "name: nf", "---", "fixer law", ""].join("\n"));
  gitIn(dir, ["init", "-q", "-b", "development"]);
  gitIn(dir, ["add", "-A"]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

const DOC = (id: string, delivers: string[], opts: { level?: string; parent?: string; body?: string } = {}) =>
  [
    "---",
    `id: ${id}`,
    `level: ${opts.level ?? "epic"}`,
    `title: ${id}`,
    "status: active",
    ...(opts.parent !== undefined ? [`parent: ${opts.parent}`] : []),
    `delivers: [${delivers.join(", ")}]`,
    "---",
    // An epic carries its features; one delivering the whole slice is the smallest valid
    // shape, because `parseFeatures` refuses an epic without any. Feature-level fixtures
    // keep a bare body — nothing reads features out of one.
    epicBody(opts.body ?? "the slice", delivers, opts.level ?? "epic"),
    "",
  ].join("\n");


/**
 * Every epic fixture ends with a feature block, because `parseFeatures` refuses an epic
 * that declares none — features are part of their epic now. A test supplying its own body
 * is testing something else (spacing, a correction, length), so the block is APPENDED
 * rather than substituted, unless that body already declares features itself.
 */
const epicBody = (body: string, delivers: string[], level: string): string => {
  if (level !== "epic" || body.includes("### Feature ")) return body;
  return [
    body,
    "",
    "### Feature 1.1: the whole slice",
    "",
    "- **Delivers:** " + delivers.join(", "),
    "- **Renders:** (none)",
    "- **Depends on:** (none)",
    "- **Acceptance:** (none)",
  ].join(String.fromCharCode(10));
};

const SCAFFOLD_DIR = "work";

const PASS = {
  verdict: "pass",
  checks: [
    { check: "quotes-are-real", ok: true, cite: "PRD C1.1" },
    { check: "nothing-invented", ok: true, cite: "every line quoted" },
    { check: "nothing-binding-missing", ok: true, cite: "ARCH §3 pointed at" },
    { check: "right-size", ok: true, cite: "names 2 children" },
    { check: "points-not-copies", ok: true, cite: "no quoted ARCH prose" },
    { check: "dependencies-declared", ok: true, cite: "none outside" },
  ],
  problems: [],
};

/**
 * Fake ACT: writes `files` into its OWN working directory, then answers the judge.
 *
 * Writing to `opts.cwd` rather than to the arena is the behaviour under test: the ACT is
 * pointed at a scratch directory, so a refused document never reaches the store and there
 * is nothing to revert. A key prefixed `REPO:` writes into the arena instead, to exercise
 * the containment tripwire.
 */
function agents(
  dir: string,
  files: Record<string, string>,
  verdict: unknown,
  /**
   * What the CORRECTION pass writes back, keyed by the same filename the writer used.
   *
   * Omitted means the fixer changed nothing — which is a real case and must be caught:
   * a mechanical finding that survives the pass is the one thing the engine still
   * refuses, because re-running the arithmetic is free.
   */
  fixes?: Record<string, string>,
) {
  return async (prompt: string, opts: { cwd: string; logPath: string }): Promise<SpawnRunResult> => {
    writeFileSync(opts.logPath, "");
    const m = /Write your verdict JSON to EXACTLY: (.+)/.exec(prompt);
    if (prompt.includes("# The document to correct")) {
      fixerPrompts.push(prompt);
      for (const [rel, body] of Object.entries(fixes ?? {})) {
        // `REPO:` here too: the correction pass holds the same `Write` the writer does,
        // so it can reach into the repository the same way and needs the same tripwire.
        const into = rel.startsWith("REPO:") ? join(dir, rel.slice(5)) : join(opts.cwd, rel);
        mkdirSync(join(into, ".."), { recursive: true });
        writeFileSync(into, body);
      }
      // The correction pass owns the units too — the prompt tells it so. A fixer that
      // renames the epic has to carry their `parent` with it, and regenerating from the
      // CORRECTED epic is how this fixture does what a real one is asked to do.
      scaffoldDefaults(opts.cwd, fixes ?? {});
    } else if (m) {
      writeFileSync(m[1]!.trim(), JSON.stringify(verdict));
    } else {
      for (const [rel, body] of Object.entries(files)) {
        const into = rel.startsWith("REPO:") ? join(dir, rel.slice(5)) : join(opts.cwd, rel);
        mkdirSync(join(into, ".."), { recursive: true });
        writeFileSync(into, body);
      }
      scaffoldDefaults(opts.cwd, files);
    }
    return {
      spawnFailed: false, exitCode: 0, signal: null, timedOut: false, outage: false,
      logPath: opts.logPath, resultMessage: { type: "result", subtype: "success", total_cost_usd: 0.5 },
    } as unknown as SpawnRunResult;
  };
}

/**
 * Give an epic fixture the units ADR-0006 now requires, unless the test supplied its own.
 *
 * An epic that scaffolds nothing is refused, so without this every fixture in this file
 * would be testing that refusal instead of what it was written for. The default is derived
 * from what the epic itself declares — one unit under its first feature, covering exactly
 * what that feature delivers — so a test that changes the epic's coverage does not have to
 * remember to change a unit to match.
 *
 * A test about the SCAFFOLD supplies a `work/...` key and this stands aside.
 */
function scaffoldDefaults(cwd: string, files: Record<string, string>): void {
  if (Object.keys(files).some((k) => k.startsWith(`${SCAFFOLD_DIR}/`))) return;
  if (!Object.entries(files).some(([rel, body]) => !rel.startsWith("REPO:") && rel.endsWith(".md") && /^level:\s*epic/m.test(body))) return;
  // Wiped rather than added to: a corrected epic with a new id leaves the old unit behind,
  // pointing at a feature of a document that no longer exists.
  rmSync(join(cwd, SCAFFOLD_DIR), { recursive: true, force: true });
  for (const [rel, body] of Object.entries(files)) {
    if (rel.startsWith("REPO:") || !rel.endsWith(".md")) continue;
    const id = /^id:\s*(\S+)/m.exec(body)?.[1];
    const level = /^level:\s*(\S+)/m.exec(body)?.[1];
    if (id === undefined || level !== "epic") continue;
    const heading = /^###\s+Feature\s+(\d+\.\d+)\s*:/m.exec(body)?.[1];
    const delivers = /^-\s+\*\*Delivers:\*\*\s*(.*)$/m.exec(body)?.[1]?.trim();
    if (heading === undefined || delivers === undefined || delivers === "(none)") continue;
    mkdirSync(join(cwd, SCAFFOLD_DIR), { recursive: true });
    writeFileSync(join(cwd, SCAFFOLD_DIR, `wu-${id}-1.md`), [
      "---", `id: wu-${id}-1`, `title: ${id} unit 1`, "tier: reversible", "budget_usd: 12",
      "status: scaffold", `parent: ${id}#${heading}`,
      `delivers: [${delivers.replace(/`/g, "")}]`, "renders: []", "depends_on: []",
      "---", "## Intent", "", "Because the slice needs building.", "",
    ].join(String.fromCharCode(10)));
  }
}

/** Every prompt the correction pass was given this test, for asserting what it was told. */
let fixerPrompts: string[] = [];
beforeEach(() => { fixerPrompts = []; });

function epicDoc(id: string, delivers: string[]): Narrowing {
  const res = parseNarrowing(DOC(id, delivers), `docs/program/epics/${id}.md`);
  if (!res.ok) throw new Error(res.errors.join("; "));
  return res.narrowing;
}

function ctx(
  dir: string,
  runAgent: NarrowingContext["runAgent"],
  over: Partial<NarrowingContext> = {},
  store: MemoryNarrowingStore = new MemoryNarrowingStore(),
): NarrowingContext {
  return {
    arenaDir: dir,
    level: "epic",
    store,
    parent: { label: "the PRD and the ARCH", paths: ["docs/program/PRD.md"] },
    criteria: parseCriteria(PRD),
    existing: [],
    logPath: join(dir, ".doctrine", "runs", "n.log"),
    agentDefinitionPath: join(dir, "law.md"),
    judgeAgentPath: join(dir, "judge-law.md"),
    fixerAgentPath: join(dir, "fixer-law.md"),
    budgetUsd: 10,
    ...(runAgent !== undefined ? { runAgent } : {}),
    ...over,
  };
}

describe("the narrowing ACT — write, judge, correct, publish", () => {
  it("mints an epic, judges it, and publishes it through the store", async () => {
    const dir = arena("mint-epic");
    const store = new MemoryNarrowingStore();
    const out = await runNarrowingAct(ctx(dir, agents(dir, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"]),
    }, PASS), {}, store));

    expect(out.kind).toBe("minted");
    if (out.kind !== "minted") return;
    expect(out.id).toBe("ep-ledger");
    expect(store.load("epic").narrowings.map((n) => n.id)).toEqual(["ep-ledger"]);
    // The repository is untouched by the ACT. `.doctrine/` is excluded because the
    // scheduler writes run logs there around the ACT, which is not the ACT's doing —
    // counting them made every run look like a containment failure.
    expect(gitIn(dir, ["status", "--porcelain", "-uall", "--", ":(exclude).doctrine"])).toBe("");
  });

  it("publishes the document byte-for-byte as the judge read it", async () => {
    // Round-tripping through a serialiser would let the published artifact differ from
    // the judged one — key order, comment formatting, anything — and the gate's whole
    // claim is that it ruled on what shipped.
    const dir = arena("byte-for-byte");
    const store = new MemoryNarrowingStore();
    const source = DOC("ep-ledger", ["C1.1", "C1.2"], { body: "the slice, with  odd   spacing" });
    await runNarrowingAct(ctx(dir, agents(dir, { "ep-ledger.md": source }, PASS), {}, store));
    expect(store.load("epic").narrowings[0]!.source).toBe(source);
  });

  it("a mechanical finding that SURVIVES the correction is refused", async () => {
    // The asymmetry that makes one round safe. The paid judge ran once and is not asked
    // again — but the arithmetic is free, so it is re-run, and it is the half that
    // protects the coverage chain: a wrong `delivers` list means a criterion silently
    // reaches no child while every gate reports green.
    const dir = arena("bloat-survives");
    const store = new MemoryNarrowingStore();
    // C9.9 is in no PRD, so `lintEpics` calls it invented at both passes.
    const bad = DOC("ep-ledger", ["C1.1", "C1.2", "C9.9"]);
    const out = await runNarrowingAct(ctx(dir, agents(dir, { "ep-ledger.md": bad }, PASS, {
      // It DID edit the document — reworded the body — and left the `delivers` list alone.
      // That is the realistic shape of this failure, and the reason the free arithmetic
      // is re-run rather than trusted: a pass that visibly did something is exactly the
      // one nothing else would question.
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2", "C9.9"], { body: "reworded, but still claiming C9.9" }),
    }), {}, store));

    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toContain("C9.9");
    expect(store.load("epic").narrowings, "nothing is published").toHaveLength(0);
  });

  it("the tripwire covers the CORRECTION pass too, not just the writer", async () => {
    // The fixer holds `Write` with the repository in `addDirs`, exactly as the writer
    // does — and it has a motive the writer does not. A finding says this document
    // disagrees with its parent, and editing the PARENT resolves it just as well. That
    // edit would then be swept into the publish commit by `stagePaths`, which is how a
    // correction pass could quietly rewrite the PRD to agree with a document that was
    // wrong. The writer has had this guard since the rung was built; the fixer was added
    // without it, which is the same sibling divergence this whole change is about.
    const dir = arena("fix-touched-repo");
    const store = new MemoryNarrowingStore();
    const out = await runNarrowingAct(ctx(dir, agents(dir, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"]),
    }, { ...PASS, verdict: "fail", problems: ["quotes-are-real: not in the PRD"] }, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"], { body: "corrected" }),
      "REPO:docs/program/PRD.md": "# a PRD that now agrees with the document",
    }), {}, store));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toMatch(/correction pass wrote into the repository/);
    expect(store.load("epic").narrowings).toHaveLength(0);
    // Reverted, not merely reported. Compared with line endings normalised: the revert is
    // a `git checkout`, and on Windows that restores the file through autocrlf, so an
    // exact comparison fails on the newlines rather than on the content.
    const lf = (x: string): string => x.split(String.fromCharCode(13)).join("");
    expect(lf(readFileSync(join(dir, "docs", "program", "PRD.md"), "utf8"))).toBe(lf(PRD));
  });

  it("a correction pass that writes a SECOND file is refused", async () => {
    // The silent false success, and the worst outcome available on this rung. The
    // "wrote more than one" check runs before the fix, and the re-read afterwards is BY
    // NAME — so a pass that writes `ep-ledger-v2.md` and leaves the original alone
    // produces a clean re-check of an UNCORRECTED document, which then publishes
    // reporting its findings as addressed. Nothing downstream could tell it from real
    // work.
    const dir = arena("fix-second-file");
    const store = new MemoryNarrowingStore();
    const out = await runNarrowingAct(ctx(dir, agents(dir, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"]),
    }, { ...PASS, verdict: "fail", problems: ["nothing-invented: §4 has no source"] }, {
      "ep-ledger-v2.md": DOC("ep-ledger", ["C1.1", "C1.2"], { body: "corrected, in the wrong file" }),
    }), {}, store));

    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toMatch(/it corrects that file, it does not write another/);
    expect(store.load("epic").narrowings).toHaveLength(0);
  });

  it("a correction pass that changed NOTHING is refused, with the findings named", async () => {
    // Byte-identical, with findings outstanding. Publishing it would report every one of
    // them as addressed when none was — and unlike a mechanical finding, a judge's
    // finding has nothing free to re-check it with, so this comparison is the only thing
    // standing between an ignored finding and a published document.
    const dir = arena("fix-noop");
    const store = new MemoryNarrowingStore();
    const doc = DOC("ep-ledger", ["C1.1", "C1.2"]);
    const out = await runNarrowingAct(ctx(dir, agents(dir, { "ep-ledger.md": doc }, {
      ...PASS, verdict: "fail", problems: ["quotes-are-real: 'tie-out' is not in the PRD"],
    }, { "ep-ledger.md": doc }), {}, store));

    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toContain("changed nothing");
    expect(out.problems.join(" ")).toContain("'tie-out' is not in the PRD");
    expect(store.load("epic").narrowings).toHaveLength(0);
  });

  it("a correction pass that renames the document is refused", async () => {
    // Identity is not a finding to be fixed; it is the thing findings are ABOUT. A
    // renamed document is a different one, and publishing it would mean the judge's
    // reading applies to no artifact that exists.
    const dir = arena("fix-renamed");
    const store = new MemoryNarrowingStore();
    const out = await runNarrowingAct(ctx(dir, agents(dir, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"]),
    }, { ...PASS, verdict: "fail", problems: ["nothing-invented: §4 has no source"] }, {
      "ep-ledger.md": DOC("ep-something-else", ["C1.1", "C1.2"]),
    }), {}, store));

    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toContain("a correction is not a new document");
    expect(store.load("epic").narrowings).toHaveLength(0);
  });

  it("does NOT reject a document merely because the level is still incomplete", async () => {
    // A level is only complete when the last narrowing lands, so an incomplete SET is not
    // this document's fault. Only what it gets wrong itself counts.
    const dir = arena("partial-level");
    const out = await runNarrowingAct(ctx(dir, agents(dir, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1"]),
    }, PASS)));

    expect(out.kind).toBe("minted");
  });

  it("a LONG narrowing is minted, and its size is reported rather than refused", async () => {
    // There was a 12,000-character ceiling here and it is gone, on the operator's call,
    // with better reasoning than the ceiling had: a stated limit is a target. A model told
    // a document may run to 12,000 characters writes one near 12,000, and the number stops
    // measuring what the model would produce and starts producing it.
    //
    // The bloat it was aimed at is a SHAPE — copying the architecture instead of pointing
    // at it — and the checks for that shape are `points-not-copies` and `right-size`, which
    // a reader performs on the document rather than on its length. So the engine measures
    // and says nothing, and what these runs actually write becomes answerable from the
    // ledger instead of guessed at from a number we chose.
    const dir = arena("long-doc");
    const store = new MemoryNarrowingStore();
    const long = "x".repeat(20_000);
    const source = DOC("ep-ledger", ["C1.1", "C1.2"], { body: long });
    const out = await runNarrowingAct(ctx(dir, agents(dir, { "ep-ledger.md": source }, PASS), {}, store));

    expect(out.kind).toBe("minted");
    if (out.kind !== "minted") return;
    // The fixture appends a feature block, so the measure is the body as written, not the
    // filler alone — which is the point: the engine reports what the ACT produced.
    expect(out.bodyChars).toBeGreaterThanOrEqual(long.length);
    expect(out.bodyChars).toBeLessThan(long.length + 500);
    expect(fixerPrompts, "nothing about length is a finding any more").toHaveLength(0);
    expect(store.load("epic").narrowings).toHaveLength(1);
  });

  it("REGRESSION: an epic written with a `parent:` is CORRECTED, not discarded", async () => {
    // The first real run of this rung, 2026-09-14. The writer produced an epic that quoted
    // the PRD, argued why two ladder steps were one slice, cited the ARCH's decision
    // record and covered thirteen criteria — carrying `parent: prd`. An epic has no
    // parent, so the parse failed, the draft was discarded, and $2.77 bought nothing.
    // Deleting one line would have fixed it.
    //
    // Two causes, both fixed. The law's only frontmatter example was a FEATURE, which has
    // a parent, so a writer minting an epic copied the shape it was shown. And the engine
    // treated "one field is wrong" as "cannot be read" — the re-roll shape removed from
    // every other rung, surviving here behind reasoning that is true of an unreadable
    // document and false of this one.
    const dir = arena("epic-with-parent");
    const store = new MemoryNarrowingStore();
    const withParent = DOC("ep-ledger", ["C1.1", "C1.2"]).replace("level: epic", "level: epic" + String.fromCharCode(10) + "parent: prd");
    const out = await runNarrowingAct(ctx(dir, agents(dir, { "ep-ledger.md": withParent }, PASS, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"]),
    }), {}, store));

    expect(out.kind).toBe("minted");
    if (out.kind !== "minted") return;
    expect(out.findingsFixed).toBe(1);
    expect(fixerPrompts[0]!).toContain("an epic has no parent");
    expect(store.load("epic").narrowings).toHaveLength(1);
  });

  it("a `depends_on:` edge on a requirement nothing delivers is caught at MINT", async () => {
    // The chain SCHEDULES on this field, so an edge that can never clear is not a
    // cosmetic error: it reads as "not ready yet" forever, which is the quiet kind of
    // stuck — nothing red, nothing spent, nothing ever happening. Caught here so the
    // correction pass fixes it in the same round as everything else, rather than a set
    // review refusing the whole level much later.
    const dir = arena("dangling-edge");
    const store = new MemoryNarrowingStore();
    const withEdge = DOC("ep-ledger", ["C1.1", "C1.2"]).replace("status: active", "status: active" + String.fromCharCode(10) + "depends_on: [C9.9]");
    const out = await runNarrowingAct(ctx(dir, agents(dir, { "ep-ledger.md": withEdge }, PASS, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"]),
    }), {}, store));

    expect(out.kind).toBe("minted");
    if (out.kind !== "minted") return;
    expect(fixerPrompts[0]!).toContain("depends on C9.9");
  });

  it("REGRESSION: an id another narrowing already holds is caught BEFORE publish", async () => {
    // External review, PR #83. `FileNarrowingStore.publish` writes `<dir>/<id>.md`, so a
    // second document minted with an existing id does not produce two records that
    // disagree — it OVERWRITES the first and leaves one. Every check downstream then sees
    // a single document with that id and reports nothing.
    //
    // That is why the level-wide review's duplicate-id check could never fire for anything
    // the loop itself minted: by the time it loaded the set, the evidence was gone. The
    // guard has to run before publish, and it does — as a finding, so the correction pass
    // can rename rather than the draft being thrown away.
    //
    // Asserted through the ACT rather than over two hand-built objects, because the earlier
    // version of this check passed against two in-memory narrowings the store can never
    // produce. A check whose input is not the thing being checked is not a check.
    const dir = arena("id-already-taken");
    const store = new MemoryNarrowingStore([epicDoc("ep-ledger", ["C1.1"])]);
    const out = await runNarrowingAct(ctx(dir, agents(dir, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.2"]),
    }, PASS, {
      "ep-ledger.md": DOC("ep-fresh", ["C1.2"]),
    }), { existing: [epicDoc("ep-ledger", ["C1.1"])] }, store));

    // The fixer renamed it, so it lands — and the original is still there beside it.
    expect(out.kind).toBe("minted");
    if (out.kind !== "minted") return;
    expect(out.id).toBe("ep-fresh");
    expect(fixerPrompts[0]!).toContain('already exists');
    expect(store.load("epic").narrowings.map((n) => n.id).sort()).toEqual(["ep-fresh", "ep-ledger"]);
  });

  it("...but frontmatter that cannot be PARSED is still the one hard refusal", async () => {
    // The distinction the regression above turns on. No frontmatter block means no id, no
    // level and no `delivers` — there is nothing to point a judge or a fixer at, so refusing
    // costs one writer spawn and no judge.
    const dir = arena("no-frontmatter");
    const store = new MemoryNarrowingStore();
    const out = await runNarrowingAct(ctx(dir, agents(dir, { "ep-ledger.md": "just prose, no envelope" }, PASS), {}, store));

    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toContain("no YAML frontmatter block found");
    expect(fixerPrompts, "no judge and no fixer is paid for an unreadable document").toHaveLength(0);
  });

  it("a bad field AND a bad criterion reach the fixer TOGETHER, in one pass", async () => {
    // External review, PR #80. The first version of the change above computed the free
    // arithmetic only when the envelope parsed cleanly, so a draft carrying both faults
    // sent the fixer the field error alone — and then the free re-check, which is a gate,
    // found the coverage error nobody had been told about and rejected the document.
    // The paid re-roll this change exists to remove, rebuilt one layer down.
    //
    // So the arithmetic runs on whatever is READABLE, not on what is valid.
    const dir = arena("both-faults");
    const store = new MemoryNarrowingStore();
    const both = DOC("ep-ledger", ["C1.1", "C1.2", "C9.9"], { parent: "prd" });
    const out = await runNarrowingAct(ctx(dir, agents(dir, { "ep-ledger.md": both }, PASS, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"]),
    }), {}, store));

    expect(out.kind).toBe("minted");
    if (out.kind !== "minted") return;
    // Three now, not two, and the third is the same defect one rung down: the epic's
    // invented criterion reaches the unit scaffolded under its feature, so the scaffold
    // arithmetic names it too. That is the property this test is really about — every
    // fault reachable by a free check is in the ONE list the fixer is given.
    expect(out.findingsFixed).toBe(3);
    expect(fixerPrompts).toHaveLength(1);
    expect(fixerPrompts[0]!, "the field rule").toContain("an epic has no parent");
    expect(fixerPrompts[0]!, "the arithmetic, in the SAME list").toContain("C9.9, which is not a criterion in the PRD");
    expect(fixerPrompts[0]!, "and the unit that inherited it").toContain("wu-ep-ledger-1");
  });

  it("a document that failed a field rule still cannot be RENAMED by its correction", async () => {
    // The same review's second finding. Identity was compared only when the first parse
    // was clean, which turned the guard off for exactly the drafts the change above
    // added: `parent: prd` never touched `id: ep-skeleton`, so there was always an
    // identity to hold the fixer to. Without it a correction pass could publish a
    // different document under an id the judge never read.
    const dir = arena("renamed-by-fix");
    const store = new MemoryNarrowingStore();
    const out = await runNarrowingAct(ctx(dir, agents(dir, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"], { parent: "prd" }),
    }, PASS, {
      "ep-ledger.md": DOC("ep-ledger-v2", ["C1.1", "C1.2"]),
    }), {}, store));

    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems[0]!).toContain('changed the id from "ep-ledger" to "ep-ledger-v2"');
    expect(store.load("epic").narrowings, "nothing published under an unjudged id").toHaveLength(0);
  });

  it("the tripwire: an ACT that reaches into the repository fails and is cleaned up", async () => {
    // Normally impossible to hit — the ACT is pointed at a scratch directory. But `Write`
    // accepts an absolute path, so reaching in anyway is a containment failure, and a
    // silent one is worse than a loud one.
    const dir = arena("wrote-code");
    const out = await runNarrowingAct(ctx(dir, agents(dir, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"]),
      "REPO:src/app.ts": "export const x = 1;",
    }, PASS)));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toMatch(/wrote into the repository/);
    // Cleaned, not merely reported — a clean scoped to one directory once left a stray
    // file on disk after a run that was reported as reverted wholesale.
    expect(existsSync(join(dir, "src", "app.ts"))).toBe(false);
  });

  it("refuses an ACT that wrote two narrowings at once", async () => {
    const dir = arena("two-docs");
    const out = await runNarrowingAct(ctx(dir, agents(dir, {
      "ep-a.md": DOC("ep-a", ["C1.1"]),
      "ep-b.md": DOC("ep-b", ["C1.2"]),
    }, PASS)));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toMatch(/more than one/);
  });

  it("an honest empty answer is `empty`, not a failure", async () => {
    const dir = arena("nothing-owed");
    const out = await runNarrowingAct(ctx(dir, agents(dir, {}, PASS)));
    expect(out.kind).toBe("empty");
  });

  it("a judge that skipped a check fails the RUN — it cannot become a finding", async () => {
    // Inspecting only what is present is how a gate becomes optional: the checks it
    // omitted were being reported as satisfied rather than as unperformed.
    //
    // And it is a `failed`, not a `rejected`, which is the distinction this rung now
    // turns on. A finding is something a correction pass can act on. "The judge did not
    // look at this" is not: there is nothing in the document to change, so handing it to
    // a fixer would launder an unperformed check into a corrected one.
    const dir = arena("partial-verdict");
    const out = await runNarrowingAct(ctx(dir, agents(dir, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"]),
    }, { ...PASS, checks: PASS.checks.slice(0, 3) })));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.problems.join(" ")).toMatch(/reported no result for/);
    expect(fixerPrompts).toHaveLength(0);
  });

  it("a check marked not-ok with NO citation fails the run, never the document", async () => {
    // "quotes-are-real: no reason given" tells a fixer that something is wrong and
    // nothing about where. It cannot act — and any unrelated byte it changes then
    // satisfies the "changed something" guard, the paid checks are never re-run, and the
    // original defect publishes. The verdict is model-generated JSON cast to a type, so
    // an uncited failure is an incomplete report, not a finding.
    const dir = arena("uncited-failure");
    const store = new MemoryNarrowingStore();
    const out = await runNarrowingAct(ctx(dir, agents(dir, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"]),
    }, {
      ...PASS,
      checks: [{ check: "quotes-are-real", ok: false }, ...PASS.checks.slice(1)],
    }), {}, store));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.problems.join(" ")).toContain("a finding that names nothing cannot be acted on");
    expect(fixerPrompts).toHaveLength(0);
    expect(store.load("epic").narrowings).toHaveLength(0);
  });

  it("a refusal that says nothing at all fails the run", async () => {
    // `verdict: "fail"` with every check ok and no problems. There is no finding to act
    // on, so a correction pass would have nothing to do and the document would publish on
    // the strength of a report that refused it.
    //
    // The intent rung refused this from the start and this one did not — the sibling
    // divergence between the two correction passes that their own pull request warned
    // about, found by external review the same day. Both refuse it now.
    const dir = arena("empty-refusal");
    const store = new MemoryNarrowingStore();
    const out = await runNarrowingAct(ctx(dir, agents(dir, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"]),
    }, { ...PASS, verdict: "fail" }), {}, store));

    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.problems.join(" ")).toMatch(/without saying what is wrong/);
    expect(fixerPrompts).toHaveLength(0);
    expect(store.load("epic").narrowings).toHaveLength(0);
  });

  it("a judge's findings are ADDRESSED on the document, and it publishes", async () => {
    // The change this rung exists for, stated as plainly as it can be. The judge says
    // what is wrong; one pass corrects it; the document lands. Nothing is discarded and
    // nothing is re-judged.
    const dir = arena("judge-finds");
    const store = new MemoryNarrowingStore();
    const out = await runNarrowingAct(ctx(dir, agents(dir, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"], { body: "quotes 'tie-out'" }),
    }, { verdict: "fail", checks: PASS.checks, problems: ["quotes-are-real: 'tie-out' is not in the PRD"] }, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"], { body: "quotes the PRD's actual words" }),
    }), {}, store));

    expect(out.kind).toBe("minted");
    if (out.kind !== "minted") return;
    expect(out.findingsFixed).toBe(1);
    expect(store.load("epic").narrowings).toHaveLength(1);
    expect(store.load("epic").narrowings[0]!.body).toContain("actual words");

    // The fixer was handed the finding VERBATIM, and pointed at the parent that settles
    // it. A correction pass told only that something is wrong writes a rewrite.
    expect(fixerPrompts[0]!).toContain("'tie-out' is not in the PRD");
    expect(fixerPrompts[0]!).toContain("the document it must conform to");
  });

  it("a passing judge costs no correction pass at all", async () => {
    // Two spawns, not three. A rung that paid a fixer to change nothing would have made
    // the common case the expensive one.
    const dir = arena("nothing-to-fix");
    const out = await runNarrowingAct(ctx(dir, agents(dir, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"]),
    }, PASS)));

    expect(out.kind).toBe("minted");
    if (out.kind !== "minted") return;
    expect(out.findingsFixed).toBe(0);
    expect(fixerPrompts).toHaveLength(0);
  });

  it("the judge is never asked twice — the cost of a document is bounded", async () => {
    // The property the whole change is for. Under the old shape a refusal deleted the
    // document and the next tick wrote a DIFFERENT one for the same judge to find
    // different faults in, bounded only by the three-consecutive-failure halt, which
    // stops the whole loop rather than finishing this document. Measured at the program
    // rung, that refused 47.8% of what it was given.
    //
    // Exactly one judge spawn per document, findings or no findings.
    const dir = arena("judged-once");
    let judgeSpawns = 0;
    const inner = agents(dir, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"]),
    }, { verdict: "fail", checks: PASS.checks, problems: ["a", "b", "c"] }, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"], { body: "corrected" }),
    });
    const out = await runNarrowingAct(ctx(dir, async (prompt, opts) => {
      if (/Write your verdict JSON to EXACTLY:/.test(prompt)) judgeSpawns += 1;
      return inner(prompt, opts);
    }));

    expect(out.kind).toBe("minted");
    expect(judgeSpawns).toBe(1);
    // Three findings, one pass. Not three passes, and not one pass per round.
    expect(fixerPrompts).toHaveLength(1);
  });

  it("bills the ACT and the judge together", async () => {
    const dir = arena("billing");
    const out = await runNarrowingAct(ctx(dir, agents(dir, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"]),
    }, PASS)));
    // Two spawns at $0.50 each. A rung that reported only the ACT's cost spends the
    // judge's money outside every budget.
    expect(out.spendUsd).toBeCloseTo(1.0, 5);
  });

  it("bills the correction pass too", async () => {
    // Three spawns when there is something to correct. The fix is real money and the
    // daily spend gate reads these numbers; a pass billed at nothing is a pass that
    // spends outside every budget, which this rung has already been caught doing once.
    const dir = arena("billing-fix");
    const out = await runNarrowingAct(ctx(dir, agents(dir, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"]),
    }, { ...PASS, verdict: "fail", problems: ["nothing-invented: §4 has no source"] }, {
      "ep-ledger.md": DOC("ep-ledger", ["C1.1", "C1.2"], { body: "corrected" }),
    })));

    expect(out.kind).toBe("minted");
    expect(out.spendUsd).toBeCloseTo(1.5, 5);
  });

  it("hands the judge the document and its parent, and tells it not to reach past", async () => {
    const dir = arena("judge-source");
    let judgePrompt = "";
    const epic = epicDoc("ep-ledger", ["C1.1", "C1.2"]);
    const inner = agents(dir, {
      "ft-import.md": DOC("ft-import", ["C1.1", "C1.2"], { level: "feature", parent: "ep-ledger" }),
    }, PASS);
    await runNarrowingAct(ctx(dir, async (prompt, opts) => {
      if (prompt.includes("What you are judging")) judgePrompt = prompt;
      return inner(prompt, opts);
    }, { level: "feature", epic, parent: { label: "its epic", paths: [epic.path] } }));

    expect(judgePrompt).toContain("ft-import.md");
    expect(judgePrompt).toContain("ep-ledger.md");
    expect(judgePrompt).toContain("Do not reach past the parent");
    // The grandparent is not offered: that hop was checked by the run before.
    expect(judgePrompt).not.toContain("PRD.md");
  });
});

describe("the epic ACT scaffolds its own units (ADR-0006)", () => {
  const LF = String.fromCharCode(10);

  /** An epic with two features, so a unit can be parented to the wrong one. */
  const TWO = [
    "---", "id: ep-ledger", "level: epic", "title: Ledger", "status: active",
    "delivers: [C1.1, C1.2]", "---", "the slice", "",
    "### Feature 1.1: import", "",
    "- **Delivers:** C1.1", "- **Renders:** (none)", "- **Depends on:** (none)",
    "- **Acceptance:** (none)", "",
    "### Feature 1.2: close", "",
    "- **Delivers:** C1.2", "- **Renders:** (none)", "- **Depends on:** (none)",
    "- **Acceptance:** (none)", "",
  ].join(LF);

  const unit = (
    id: string,
    parent: string,
    delivers: string[],
    over: { dependsOn?: string[]; status?: string; evidence?: boolean } = {},
  ): string => [
    "---", `id: ${id}`, `title: ${id}`, "tier: reversible", "budget_usd: 12",
    `status: ${over.status ?? "scaffold"}`, `parent: ${parent}`,
    `delivers: [${delivers.join(", ")}]`, "renders: []",
    `depends_on: [${(over.dependsOn ?? []).join(", ")}]`,
    ...(over.evidence === true
      ? ["evidence:", "  - kind: command", '    run: "npm test"', '    expect: "exit 0"']
      : []),
    "---", "## Intent", "", "Because the ledger cannot import today.", "",
  ].join(LF);

  const both = (): Record<string, string> => ({
    "ep-ledger.md": TWO,
    "work/wu-import.md": unit("wu-import", "ep-ledger#1.1", ["C1.1"]),
    "work/wu-close.md": unit("wu-close", "ep-ledger#1.2", ["C1.2"]),
  });

  it("publishes the units WITH the epic, in one artifact", async () => {
    const dir = arena("scaffolds-land");
    const store = new MemoryNarrowingStore();
    const out = await runNarrowingAct(ctx(dir, agents(dir, both(), PASS), {}, store));

    expect(out.kind).toBe("minted");
    if (out.kind !== "minted") return;
    expect(out.units.sort()).toEqual(["wu-close", "wu-import"]);
    expect(readFileSync(join(dir, "work", "wu-import.md"), "utf8")).toContain("status: scaffold");
    // One artifact, so one landing: an epic committed without its units is a window in
    // which every reader sees features that nothing implements.
    expect(gitIn(dir, ["status", "--porcelain", "-uno"])).toBe("");
  });

  it("refuses an epic that scaffolds nothing", async () => {
    const dir = arena("scaffolds-none");
    // The `work/` key is what tells the fixture not to supply the default unit every
    // other epic fixture here gets — this test is about the ACT writing none.
    const out = await runNarrowingAct(ctx(dir, agents(dir, { "ep-ledger.md": TWO, "work/.keep": "" }, PASS)));
    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toContain("scaffolded no units");
  });

  it("refuses a unit parented to a feature this epic does not have", async () => {
    const dir = arena("scaffolds-parent");
    const files = both();
    files["work/wu-close.md"] = unit("wu-close", "ep-ledger#9.9", ["C1.2"]);
    const out = await runNarrowingAct(ctx(dir, agents(dir, files, PASS)));
    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toContain('parent "ep-ledger#9.9" is not a feature');
  });

  it("refuses a unit claiming what its own feature does not", async () => {
    // `lintScaffold` cannot see this: the epic's coverage still balances, because the
    // criterion IS delivered by one of its units — just not by a unit of the feature that
    // owns it. The feature grade is run per feature, so it would be run against units
    // that are not its own.
    const dir = arena("scaffolds-stray");
    const files = both();
    files["work/wu-import.md"] = unit("wu-import", "ep-ledger#1.1", ["C1.1", "C1.2"]);
    const out = await runNarrowingAct(ctx(dir, agents(dir, files, PASS)));
    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toContain("which its own feature ep-ledger#1.1 neither delivers nor renders");
  });

  it("refuses an id a unit somewhere else already holds", async () => {
    // Only possible because minting is per epic (ADR-0006) — a whole-program scaffold had
    // nothing to collide with. The store writes one file per id, so publishing the second
    // would leave one document where there were two.
    const dir = arena("scaffolds-collide");
    const existing = parseWorkUnit(unit("wu-import", "ep-other#1.1", ["C9.1"]));
    if (!existing.ok) throw new Error(existing.errors.join("; "));
    const out = await runNarrowingAct(ctx(dir, agents(dir, both(), PASS), { existingUnits: [existing.unit] }));
    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toContain("duplicate unit id wu-import");
  });

  it("accepts an edge on a criterion an EARLIER epic's units deliver — open-world", async () => {
    // What ADR-0006 costs, and the reason `lintScaffold` takes `elsewhere`. Closed-world
    // this reads as an edge that can never clear: the quiet kind of stuck, inside the gate
    // built to prevent it.
    const dir = arena("scaffolds-openworld");
    const earlier = parseWorkUnit(unit("wu-earlier", "ep-other#1.1", ["C9.1"]));
    if (!earlier.ok) throw new Error(earlier.errors.join("; "));
    const files = both();
    files["work/wu-import.md"] = unit("wu-import", "ep-ledger#1.1", ["C1.1"], { dependsOn: ["C9.1"] });
    const out = await runNarrowingAct(ctx(dir, agents(dir, files, PASS), { existingUnits: [earlier.unit] }));
    expect(out.kind).toBe("minted");
  });

  it("refuses a scaffold that carries evidence — the parser's law, not a new one", async () => {
    // Evidence written at scaffold time is a guess about an interface nobody has built,
    // and it is load-bearing by the time a judge executes it.
    const dir = arena("scaffolds-evidence");
    const files = both();
    files["work/wu-import.md"] = unit("wu-import", "ep-ledger#1.1", ["C1.1"], { evidence: true });
    const out = await runNarrowingAct(ctx(dir, agents(dir, files, PASS)));
    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toContain("must carry no evidence");
  });
});

describe("a newly minted epic may not retire itself", () => {
  it("refuses status: done, because it is the one word that switches every gate off", async () => {
    // `status: done` excludes an epic from the feature parse, the chain and both grades
    // while its `delivers` still counts toward coverage. That is right for work built under
    // the previous ladder and catastrophic if an ACT can award it: coverage satisfied, no
    // features, no acceptance, no units, nothing built.
    const dir = arena("self-retire");
    const done = DOC("ep-ledger", ["C1.1", "C1.2"]).replace("status: active", "status: done");
    const out = await runNarrowingAct(ctx(dir, agents(dir, { "ep-ledger.md": done, "work/.keep": "" }, PASS)));
    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toContain("nothing may award it to itself");
  });
});

describe("the mint gate refuses a criterion another epic already delivers (PR #94 second review)", () => {
  it("names the epic that already delivers it, and the way out", async () => {
    // Before this, only the set review asked — and the set review lives in rung 3, which a
    // program whose scaffolds are all buildable may never reach before its last epic passes.
    const dir = arena("dup-claim");
    const existing = epicDoc("ep-first", ["C1.1"]);
    const out = await runNarrowingAct(ctx(dir, agents(dir, { "ep-second.md": DOC("ep-second", ["C1.1", "C1.2"]) }, PASS), { existing: [existing] }));
    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    const all = out.problems.join(" ");
    expect(all).toContain("delivers C1.1, which ep-first already delivers");
    expect(all).toContain("`renders` it");
  });
});

describe("a criterion a feature presents must reach one of its units (PR #97 review)", () => {
  it("refuses a feature Renders no unit claims — a screen nobody is told to build", async () => {
    const LF = String.fromCharCode(10);
    const epic = [
      "---", "id: ep-ledger", "level: epic", "title: Ledger", "status: active",
      "delivers: [C1.1]", "renders: [C1.2]", "---", "the slice", "",
      "### Feature 1.1: import and its screen", "",
      "- **Delivers:** C1.1", "- **Renders:** C1.2", "- **Depends on:** (none)", "- **Acceptance:** (none)", "",
    ].join(LF);
    const unitOnly = [
      "---", "id: wu-import", "title: import", "tier: reversible", "budget_usd: 12", "status: scaffold",
      "parent: ep-ledger#1.1", "delivers: [C1.1]", "renders: []", "depends_on: []",
      "---", "## Intent", "", "Why.", "",
    ].join(LF);
    const dir = arena("renders-orphan");
    const out = await runNarrowingAct(ctx(dir, agents(dir, { "ep-ledger.md": epic, "work/wu-import.md": unitOnly }, PASS)));
    expect(out.kind).toBe("rejected");
    if (out.kind !== "rejected") return;
    expect(out.problems.join(" ")).toContain("renders C1.2, which none of its units claims");
  });
});
