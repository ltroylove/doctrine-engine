import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **A law that names a field the engine does not parse is a rung that cannot run.**
 *
 * The sibling of `contract-drift.test.ts`, for the other half of the same failure. That
 * file catches a judge's verdict contract drifting from its validator; this one catches an
 * ACT's law drifting from the PARSER that reads what the ACT writes.
 *
 * It exists because that drift happened four times over two days, silently, and every
 * instance was introduced by an engine change landing without its prompt:
 *
 *  - one renamed `covers:` to `delivers:`/`renders:` and left **eight** laws telling
 *    their ACT to write `covers:`. A narrowing written that way parses with an empty
 *    `delivers`, and `parseNarrowing` refuses it — so every narrowing ACT on a live target
 *    would have been paid for and thrown away, on every attempt, forever;
 *  - another replaced `after:` with `depends_on`, and two laws still name `after:`;
 *  - a third made a feature a HEADING and left `narrowing-decomposer.md` describing a
 *    feature document under `docs/program/features/`;
 *  - and `decomposer.md` still instructs a sibling-unit dependency that `lintPlan` refuses.
 *
 * None of it was visible. The loop was paused, so nothing was refused in production, and
 * the engine's own suite was green throughout because fixtures write what the engine
 * parses rather than what the laws say. **A test over the prompts is the only place this
 * class of defect can surface without spending money to discover it.**
 *
 * The allowed set is DERIVED from the parsers rather than listed here, because a list here
 * is one more thing to drift.
 */

const SRC = join(import.meta.dirname, "..", "src");
const AGENTS = join(import.meta.dirname, "..", "..", ".claude", "agents");

/**
 * Every frontmatter key the engine reads, taken from the parsers themselves.
 *
 * `fm["x"]` is how all of them are read — `parseEnvelope` for the shared envelope, each
 * level parser for its own fields. Deriving it means adding a field to a parser makes it
 * legal in a law automatically, and removing one makes every law naming it fail here.
 */
function engineKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(join(SRC, file), "utf8");
    for (const m of text.matchAll(/\bfm\["([a-z_]+)"\]/g)) keys.add(m[1]!);
  }
  // A field the engine still READS for back-compat is not a field a law may TEACH.
  // `parseIntent` reads `covers` so that 33 intents written before the rename keep their
  // coverage — which put it back in this derived set, and the spot-check below caught it.
  // The answer is subtraction here, never deleting that assertion: it is the net working.
  for (const { field } of RETIRED_FIELDS) keys.delete(field);
  return keys;
}

/**
 * Keys that are legal in a law for reasons that have nothing to do with a doctrine
 * artifact: the agent definition's OWN frontmatter, and the sub-keys of an evidence entry,
 * which `parseEvidence` reads off a list item rather than off frontmatter.
 */
const NOT_ARTIFACT_FIELDS = new Set([
  "name", "description", "tools", "model", // the agent definition's own envelope
  "kind", "run", "expect", // an evidence entry's shape
  "verdict", "checks", "problems", "findings", "cite", "ok", "unit", "spec", // verdict JSON
  "base_sha", "head_sha", "spend_usd", "judged", "coverage_check", "nothing_dropped",
  "gates_executed", "evidence_executed", "command", "exit_code", "output_sha256", "log",
  "http", "note", "reason", "detail", "owner", "id_prefix", "path", "type", "value",
]);

/** Fields the engine USED to parse. Named in prose, they teach a writer a dead vocabulary. */
const RETIRED_FIELDS: Array<{ field: string; why: string }> = [
  { field: "covers", why: "renamed to `delivers` / `renders` by ADR-0005" },
  { field: "after", why: "replaced by `depends_on` naming criterion ids, ADR-0004" },
];

/**
 * Every `key:` a law presents as something to WRITE.
 *
 * Two shapes, and both are deliberately narrow, because English is full of lowercase words
 * followed by colons. A first draft counted every line-start `word:` and reported
 * `honestly`, `nothing` and `leaving` as frontmatter fields — a check that cries wolf is
 * one somebody switches off.
 *
 *   - inside a fenced block, any `key:` at line start: that is a law showing the shape;
 *   - outside one, only `` `key:` `` where the backtick closes right after the colon: that
 *     is a law NAMING the field. `` `accounts: command not found` `` is shell output and is
 *     not one, which is exactly the distinction the first draft missed.
 */
function keysNamedBy(law: string): Set<string> {
  const out = new Set<string>();
  // The law's own frontmatter is the file's first block; everything after it is content.
  const body = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(law)?.[1] ?? law;
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) {
      const m = /^\s*([a-z][a-z_]*):/.exec(line);
      if (m !== null) out.add(m[1]!);
      continue;
    }
    for (const m of line.matchAll(/`([a-z][a-z_]*):`/g)) out.add(m[1]!);
  }
  return out;
}

const laws = readdirSync(AGENTS)
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ name: f, text: readFileSync(join(AGENTS, f), "utf8") }));

describe("an agent law may not name a frontmatter field the engine does not parse", () => {
  it("finds the agent laws at all — an empty sweep passes vacuously", () => {
    expect(laws.length).toBeGreaterThan(10);
  });

  const allowed = engineKeys();

  it("derives the allowed keys from the parsers, not from a list in this file", () => {
    // A spot-check that the derivation works, so a regex that quietly matches nothing
    // cannot make every assertion below pass for the wrong reason.
    for (const key of ["delivers", "renders", "depends_on", "evidence", "budget_usd", "tier"]) {
      expect(allowed, `${key} is read by a parser`).toContain(key);
    }
    expect(allowed, "and `covers` is not, since the rename").not.toContain("covers");
  });

  for (const { name, text } of laws) {
    it(`${name} names only fields the engine reads`, () => {
      const unknown = [...keysNamedBy(text)]
        .filter((k) => !allowed.has(k) && !NOT_ARTIFACT_FIELDS.has(k))
        .sort();
      expect(unknown, `${name} tells its ACT to write ${unknown.join(", ")}`).toEqual([]);
    });
  }
});

describe("every law the loop names exists on disk", () => {
  // A rung whose law is missing does not crash — `agentDefs` entries are optional and the
  // rung simply stays OFF. That is the right behaviour for a target that has not installed
  // one, and the wrong behaviour for a path this repo ships: a typo or a renamed file turns
  // a rung off silently, and the loop just never does that thing again.
  const cli = readFileSync(join(SRC, "loop-cli.ts"), "utf8");

  const named = [...cli.matchAll(/"\.claude", "agents", "([a-z-]+\.md)"/g)].map((m) => m[1]!);

  it("names a plausible number of them — a regex matching nothing passes vacuously", () => {
    expect(named.length).toBeGreaterThan(10);
  });

  for (const file of [...new Set(named)].sort()) {
    it(`${file}`, () => {
      expect(laws.some((l) => l.name === file), `loop-cli names ${file} and it is not there`).toBe(true);
    });
  }
});

describe("no agent law teaches a retired vocabulary", () => {
  for (const { field, why } of RETIRED_FIELDS) {
    it(`no law still says "${field}" — ${why}`, () => {
      // Bare mentions too, not only `field:`. "Declare `covers`, and it is a subset of your
      // parent's" names no colon and taught the dead field for two steps.
      const pattern = new RegExp(`\`${field}\`|\\b${field}:`, "");
      const offenders = laws.filter((l) => pattern.test(l.text)).map((l) => l.name);
      expect(offenders).toEqual([]);
    });
  }
});
