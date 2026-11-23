import { parse as parseYaml } from "yaml";

/**
 * The frontmatter envelope every planning artifact carries, at every level.
 *
 * ```yaml
 * id: ft-rules-engine        # stable, human-meaningful, never a number
 * level: feature             # epic | feature | intent
 * title: Rules engine and the rule log
 * status: active             # vocabulary varies by level
 * parent: ep-categorisation  # the artifact one level up; absent only on an epic
 * delivers: [C2.1, C2.3]    # criteria this artifact IMPLEMENTS — the coverage denominator
 * renders: [C4.1]           # criteria it merely PRESENTS — recorded, satisfies no coverage
 * ```
 *
 * **One field name for "linked to", at every level.** It used to be `parent` on a
 * feature and `feature` on an intent, which is two names for one edge — and two names
 * for one edge is how a check gets written for one and not the other. Units still say
 * `intent:` because they predate all of this and have many readers; that rename is a
 * separate change with its own risk.
 *
 * **Why `id` is a slug and not the issue number.** These artifacts are becoming GitHub
 * issues, and the obvious move is to let the issue number be the identity. It is the
 * wrong move: a number is assigned by the tracker after the fact, so a document cannot
 * name its own parent until the parent exists there, and nothing survives a repo move or
 * reads meaningfully in a diff. Slugs stay; the engine keeps a slug → number index,
 * which is one list call and is derived, never authored.
 *
 * This module parses the envelope and nothing else. Level-specific fields — an intent's
 * budget and acceptance, a narrowing's body conventions — belong to their own parsers,
 * which call this one first. The point is that the SHARED half is shared: one place
 * where `parent` means what it means.
 */

/**
 * `intent` is LEGACY and outlives its rung on purpose: one target has 21 intent
 * documents in flight and they finish under the old ladder. `unit` is the
 * implementable thing ADR-0001 makes it, and it hangs off a feature.
 */
export const LEVELS = ["epic", "feature", "intent", "unit"] as const;
export type Level = (typeof LEVELS)[number];

/** The level each artifact's parent must be, or null when it has none. */
export const PARENT_LEVEL: Record<Level, Level | null> = {
  epic: null,
  feature: "epic",
  intent: "feature",
  unit: "feature",
};

export interface Envelope {
  id: string;
  level: Level;
  title: string;
  status: string;
  /** The artifact one level up. Absent on an epic, required everywhere else. */
  parent?: string;
  /**
   * Siblings that must be SERVED before this one — the dependency edge the chain schedules on.
   *
   * Optional and additive: a document with no `after` is served whenever its turn comes, so
   * every artifact written before this field existed keeps working unchanged.
   *
   * A list rather than a number because the real graph is not a line. `ep-materials` does not
   * wait on `ep-categorisation-and-judgment`; both wait on the skeleton. A `step: n` would
   * force an order the program does not actually require and would make two independent
   * slices look sequenced.
   */
  dependsOn: string[];
  /**
   * PRD criterion ids this artifact IMPLEMENTS. The only list coverage counts.
   */
  delivers: string[];
  /**
   * Criterion ids this artifact merely PRESENTS — a screen showing data another slice
   * builds. **Rendering satisfies no coverage** (ADR-0005).
   *
   * Without the split, a UI slice claiming it covers everything it displays makes the
   * coverage arithmetic pass while most of the product is unbuilt.
   *
   * It is not dead weight either: dependency satisfaction reads `delivers` ∪ `renders`,
   * because a slice waiting on a display is waiting on the renderer (ADR-0004). One
   * field pair, two readers, and they deliberately disagree.
   */
  renders: string[];
}

/**
 * The machine-checkable probes an artifact is graded against.
 *
 * **Here, and not beside one level's parser, because acceptance exists at three levels**
 * (ADR-0003): a unit's heavy implementation probes, a feature's handful of end-to-end
 * checks, an epic's functional suite. They differ in weight and in where they are
 * authored; they do not differ in meaning, and the engine executes all three the same way
 * — `exit 0` means met.
 *
 * It was written twice before it was written once: `parseWorkUnit` hand-rolled it inline
 * and `parseIntent` kept a second copy that produced subtly different messages for the
 * same defect. Adding the feature and epic rungs would have made four. That is the
 * failure this repo names in its own words, so the parser moved here with the envelope it
 * belongs to.
 */
export const EVIDENCE_KINDS = ["test", "command", "artifact"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface EvidenceSpec {
  kind: EvidenceKind;
  /** The command the engine or judge EXECUTES. Non-empty — an assertion is not evidence. */
  run: string;
  /** What the executed output must show. Prose, for a human and for the next planner. */
  expect: string;
}

/**
 * Read an `evidence:` (or legacy `acceptance:`) list out of frontmatter.
 *
 * Absent is an empty list and NOT an error: three levels carry this field, every document
 * written before ADR-0003 carries none of it, and a parser that refused them would make
 * the loop unable to read its own committed work. **An empty list is not a vacuous pass
 * either** — the gate that must refuse it is the grade, which knows whether this level is
 * owed acceptance; a parser does not.
 */
export function parseEvidence(raw: unknown, field: string, errors: string[]): EvidenceSpec[] {
  const out: EvidenceSpec[] = [];
  if (raw === undefined) return out;
  if (!Array.isArray(raw)) {
    errors.push(`${field} must be a list`);
    return out;
  }
  raw.forEach((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${field}[${i}] must be a mapping`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const kindOk = EVIDENCE_KINDS.includes(e["kind"] as EvidenceKind);
    const runOk = typeof e["run"] === "string" && e["run"].trim().length > 0;
    const expectOk = typeof e["expect"] === "string" && e["expect"].trim().length > 0;
    if (!kindOk) errors.push(`${field}[${i}].kind must be one of: ${EVIDENCE_KINDS.join(", ")}`);
    if (!runOk) errors.push(`${field}[${i}].run must be a non-empty command`);
    if (!expectOk) errors.push(`${field}[${i}].expect must be non-empty`);
    if (kindOk && runOk && expectOk) {
      out.push({ kind: e["kind"] as EvidenceKind, run: (e["run"] as string).trim(), expect: (e["expect"] as string).trim() });
    }
  });
  return out;
}

export interface EnvelopeParse {
  /** The raw frontmatter mapping, for a level-specific parser to read its own fields from. */
  frontmatter: Record<string, unknown>;
  body: string;
  envelope: Partial<Envelope>;
  errors: string[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseStringList(raw: unknown, field: string, errors: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${field} must be a list`);
    return [];
  }
  const out: string[] = [];
  raw.forEach((entry, i) => {
    if (typeof entry !== "string" || entry.trim().length === 0) errors.push(`${field}[${i}] must be a non-empty string`);
    else out.push(entry.trim());
  });
  return out;
}

/**
 * Read the shared envelope out of a document.
 *
 * `where` is the path or issue reference, used only in messages — this function does no
 * I/O and does not care which it is, which is the property that lets the same parser
 * read a file today and an issue body tomorrow.
 *
 * Returns partial results with errors rather than throwing, so a caller can add its own
 * level-specific problems and report them all at once. A document with four faults
 * should cost one round to fix, not four.
 */
export interface EnvelopeOptions {
  /**
   * Default `true`. When false, a missing `parent` and a missing `level` are not errors.
   *
   * **A parser reads what exists; a gate refuses what may be created.** Those are
   * different jobs and conflating them was about to break every artifact written before
   * this envelope: one target has 21 intents with neither field, and making the parser
   * strict would have rendered that whole program unreadable — so the coverage arithmetic
   * could not even see the work it is supposed to measure.
   *
   * The strictness lives at the mint gate instead, where it belongs: `runProgramDecompose`
   * refuses a newly minted intent whose `parent` is not the feature it was cut from. Same
   * shape as the admissibility law beside it — `parseIntent` will read a scaffold with no
   * acceptance, and promotion is what refuses one.
   */
  strictLink?: boolean;
  /** The level to assume when the document does not state one. */
  defaultLevel?: Level;
}

/**
 * The frontmatter block and the body, with no opinion about what the fields mean.
 *
 * Split out of `parseEnvelope` because a TICKET carries frontmatter and is not an
 * envelope — its identity is an issue number, not a slug, and it has no `level` or
 * `parent`. Copying these fifteen lines into `ticket.ts` was the alternative, and one
 * rule with two statements is the shape this engine has paid for seven times.
 *
 * `where` is a path or an issue URL and is only ever put into messages: this function
 * does no I/O, which is what lets the same parser read a file today and an issue body
 * tomorrow.
 */
export interface FrontmatterParse {
  frontmatter: Record<string, unknown>;
  body: string;
  /**
   * The frontmatter block EXACTLY as written, between the fences and without them.
   *
   * Returned because one gate needs the bytes rather than the mapping: the scaffold half of
   * a unit is frozen at build-out and the check is that the ACT appended below it rather
   * than rewriting it (ADR-0001). A mapping cannot answer that — re-serialising it would
   * compare a normalisation of what was written to a normalisation of what was written, and
   * every reordering, requoting and comment change would pass. Same argument
   * `narrowing.ts` makes for persisting `source` rather than re-serialising its fields.
   */
  raw: string;
  errors: string[];
}

export function parseFrontmatter(markdown: string, where: string): FrontmatterParse {
  const m = FRONTMATTER.exec(markdown);
  if (m === null) return { frontmatter: {}, body: "", raw: "", errors: [`${where}: no YAML frontmatter block found`] };
  let raw: unknown;
  try {
    raw = parseYaml(m[1]!);
  } catch (e) {
    return { frontmatter: {}, body: "", raw: m[1]!, errors: [`${where}: frontmatter is not valid YAML: ${String(e).slice(0, 120)}`] };
  }
  if (typeof raw !== "object" || raw === null) {
    return { frontmatter: {}, body: "", raw: m[1]!, errors: [`${where}: frontmatter is not a YAML mapping`] };
  }
  return { frontmatter: raw as Record<string, unknown>, body: (m[2] ?? "").trim(), raw: m[1]!, errors: [] };
}

export function parseEnvelope(markdown: string, where: string, opts: EnvelopeOptions = {}): EnvelopeParse {
  const strictLink = opts.strictLink ?? true;
  const front = parseFrontmatter(markdown, where);
  if (front.errors.length > 0) return { frontmatter: {}, body: "", envelope: {}, errors: front.errors };
  const errors: string[] = [];
  const fm = front.frontmatter;
  const envelope: Partial<Envelope> = {};

  if (typeof fm["id"] === "string" && fm["id"].length > 0) envelope.id = fm["id"];
  else errors.push(`${where}: id is required`);

  if (LEVELS.includes(fm["level"] as Level)) envelope.level = fm["level"] as Level;
  else if (fm["level"] === undefined && opts.defaultLevel !== undefined) envelope.level = opts.defaultLevel;
  else errors.push(`${where}: level must be one of: ${LEVELS.join(", ")}`);

  if (typeof fm["title"] === "string" && fm["title"].length > 0) envelope.title = fm["title"];
  else errors.push(`${where}: title is required`);

  if (typeof fm["status"] === "string" && fm["status"].length > 0) envelope.status = fm["status"];
  else errors.push(`${where}: status is required`);

  const parent = fm["parent"];
  if (parent !== undefined) {
    if (typeof parent === "string" && parent.length > 0) envelope.parent = parent;
    else errors.push(`${where}: parent must be a non-empty string when present`);
  }

  envelope.dependsOn = parseStringList(fm["depends_on"], "depends_on", errors);
  envelope.delivers = parseStringList(fm["delivers"], "delivers", errors);
  envelope.renders = parseStringList(fm["renders"], "renders", errors);
  const both = (envelope.delivers ?? []).filter((c) => (envelope.renders ?? []).includes(c));
  if (both.length > 0) {
    errors.push(`${where}: ${both.join(", ")} is in both delivers and renders — a slice either implements a criterion or presents it`);
  }

  // The edge, checked against the level rather than per-parser. An epic's parent is the
  // program, which is not an artifact and has no id; everything else names exactly one
  // thing above it. An artifact with no parent where one is required is an orphan: no
  // coverage check can reach it, so it answers to nobody and is counted toward the
  // program by nobody.
  if (envelope.level !== undefined) {
    const expected = PARENT_LEVEL[envelope.level];
    if (expected === null && envelope.parent !== undefined) {
      errors.push(`${where}: an epic has no parent — it narrows the program itself, which is not an artifact`);
    }
    if (expected !== null && envelope.parent === undefined && strictLink) {
      errors.push(`${where}: a ${envelope.level} must name the ${expected} it belongs to (\`parent:\`)`);
    }
  }

  return { frontmatter: fm, body: front.body, envelope, errors };
}
