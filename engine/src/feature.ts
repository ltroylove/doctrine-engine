import { type EvidenceSpec } from "./envelope.js";

/**
 * A **feature**: a slice of an epic's requirements, written as a heading inside the
 * epic document rather than as a document of its own (ADR-0001).
 *
 * ```
 * ### Feature 1.2: Invoice push
 *
 * - **Delivers:** `C3.1`, `C3.2`
 * - **Renders:** `C4.1`
 * - **Depends on:** `C1.1`
 * - **Acceptance:**
 *   - `npm run e2e -- invoice-push` — a pushed invoice appears in the ledger
 * ```
 *
 * **Why a heading and not a document.** Measured on a target: 30 feature
 * documents produced 33 intents — a fan-out of 1.1, which is a rename rather than a
 * narrowing — and those documents ran to a median of 19,111 characters of restated
 * requirement detail. Folding them in as written would have put ~78,000 characters into
 * each epic, nearly twice the 44,516-character "brief" this repo deleted once already.
 * This form is what makes the fold safe: it names ids, it restates nothing.
 *
 * **`Delivers` vs `Renders`** is the one rule adopted whole from earlier work, for the
 * reason that work gives: without the split, a UI slice claiming it delivers
 * everything it merely displays makes any coverage check pass trivially while most of the
 * product is unbuilt. Only `Delivers` counts toward coverage (ADR-0005).
 *
 * **Where this deliberately diverges from that work.** Its rule is that *nothing* outside
 * these bullets may carry a requirement id, enforced as a hard failure. Doctrine's epics
 * quote the criteria they narrow — that is the narrowing law — so an id outside a feature
 * bullet is normal here and is reported as a flag, never refused. What is refused is an
 * id inside a bullet that is *trying* to be a feature bullet and is malformed: that is the
 * case where a parser and a reader disagree, which is the failure the split exists to stop.
 */

/** `### Feature <n>.<m>: <title>` — the heading that opens one. */
const FEATURE_HEADING = /^###\s+Feature\s+(\d+\.\d+)\s*:\s*(.+?)\s*$/;

/** Any heading at `##`/`###` depth, used to find where a feature block ends. */
const ANY_HEADING = /^#{1,3}\s+\S/;

/** One of the three feature bullets. Captured loosely so a misspelling is a finding, not a silent skip. */
const TRACE_BULLET = /^[-*]\s+\*\*([^:*]+):\*\*\s*(.*)$/;

/** A PRD criterion id, with or without backticks. Same shape `coverage.ts` parses. */
const CRITERION_ID = /`?(C\d+\.\d+)`?/g;

/** The four bullets a feature must carry, in the spelling the parser accepts. */
const DELIVERS = "Delivers";
const RENDERS = "Renders";
const DEPENDS = "Depends on";
const ACCEPTANCE = "Acceptance";
const REQUIRED_BULLETS = [DELIVERS, RENDERS, DEPENDS, ACCEPTANCE] as const;

/**
 * One acceptance check: an indented sub-bullet holding a backticked command and, after a
 * dash, what passing it shows.
 *
 * ```
 * - **Acceptance:**
 *   - `npm run e2e -- invoice-push` — a pushed invoice appears in the ledger
 * ```
 *
 * **A sub-bullet rather than a fourth id list, because this is the one bullet that is not
 * ids.** The command goes in backticks so the separator is looked for AFTER the closing
 * one — `npm test -- push` is a command containing a dash, and a parser that split on the
 * first dash would cut it in half and grade the wrong thing.
 */
const ACCEPTANCE_CHECK = /^\s+[-*]\s+`([^`]+)`\s*[—–-]+\s*(.+?)\s*$/;

/** Any bullet at column 0 — where an acceptance sub-bullet list ends. */
const TOP_BULLET = /^[-*]\s+\S/;

/** Written when a list is deliberately empty. An omitted bullet is a finding; this is not. */
const NONE = "(none)";

/** A range is unparseable by construction — see `parseIdList`. */
const RANGE_MARKERS = /\bthrough\b|–|—|\.\.|C\d+\.\d+`?\s*-\s*`?C\d+\.\d+/i;

export interface Feature {
  /** `<epic id>#<n.m>` — derived, never authored, so it cannot drift from its position. */
  id: string;
  /** The epic this feature slices. */
  epic: string;
  /** `<n>.<m>` as written in the heading. */
  number: string;
  title: string;
  /** Criteria this slice IMPLEMENTS. The only list that counts toward coverage. */
  delivers: string[];
  /** Criteria this slice merely PRESENTS. Recorded, reported, satisfies no coverage. */
  renders: string[];
  /** Criterion ids that must be satisfied before this slice can be built (ADR-0004). */
  dependsOn: string[];
  /**
   * The end-to-end checks the ENGINE runs, with no LLM, once every unit under this feature
   * has merged (ADR-0003). **This rung owns the ratchet**: a failure keys a signature and
   * mints additional units under this feature, which is the intent-grade one rung up.
   *
   * Lighter than a unit's evidence by design. A unit's probes are implementation-specific
   * and written just-in-time against a tree that exists; these ask whether the traced
   * behaviour works, and if they are written as probes the epic grows and ADR-0001's
   * heading rule is broken from the inside.
   *
   * May be empty — the bullet is required, `(none)` is how you write an empty one, and it
   * is the grade that refuses to close a feature with nothing to run. A parser cannot know
   * which levels are owed acceptance; a grade can.
   */
  acceptance: EvidenceSpec[];
  /** 1-based declaration order within the epic. */
  position: number;
}

export interface FeatureParse {
  features: Feature[];
  /** Blocking. A malformed feature is not a feature. */
  problems: string[];
  /** Non-blocking observations for the observer. */
  flags: string[];
}

/**
 * Read one id list — `C3.1, C3.2`, backticked or not, or `(none)`.
 *
 * **Ranges are refused rather than expanded.** A range forces the parser to assume the
 * numbering is dense, and ranges written by hand drift into several formats (`through`,
 * an en-dash, prose). Verbose and unambiguous beats compact and guessed.
 */
function parseIdList(raw: string, where: string, problems: string[]): string[] {
  const text = raw.trim();
  if (text === "") {
    problems.push(`${where}: empty — write "${NONE}" when the list is deliberately empty, never nothing`);
    return [];
  }
  if (text === NONE) return [];
  if (RANGE_MARKERS.test(text)) {
    problems.push(`${where}: looks like a range ("${text.slice(0, 40)}") — list every id explicitly, a range makes the parser guess`);
    return [];
  }
  const ids = [...text.matchAll(CRITERION_ID)].map((m) => m[1]!);
  if (ids.length === 0) {
    problems.push(`${where}: carries no criterion id and is not "${NONE}" — "${text.slice(0, 40)}"`);
    return [];
  }
  // The residue check: anything left after removing the ids and their separators is prose
  // that a reader will believe and the parser has thrown away. That gap is a known failure
  // one rung up — a section complete as prose and wrong as data.
  const residue = text.replace(CRITERION_ID, "").replace(/[\s,;]+/g, "");
  if (residue !== "") {
    problems.push(`${where}: carries text the parser ignores ("${residue.slice(0, 30)}") — ids and commas only`);
  }
  const seen = new Set<string>();
  const dupes = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  if (dupes.length > 0) problems.push(`${where}: repeats ${[...new Set(dupes)].join(", ")}`);
  return [...seen];
}

/**
 * Read a feature's acceptance out of the sub-bullets beneath its `- **Acceptance:**`.
 *
 * `kind` is always `command` and is not authorable, which is the one place this diverges
 * from the unit dialect on purpose. A unit's `kind` tells a JUDGE how to verify a probe;
 * a feature grade has no judge — the engine executes the line and `exit 0` means met
 * (`grade.ts`). A field nothing reads is a field that drifts, and an author choosing
 * between three values none of which changes anything is being asked a question with no
 * answer.
 */
function parseAcceptance(
  inline: string,
  lines: readonly string[],
  from: number,
  end: number,
  where: string,
  problems: string[],
): EvidenceSpec[] {
  const raw: string[] = [];
  for (let i = from; i < end; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    // A bullet at column 0 is the next feature bullet; a heading is the next block. Either
    // ends this list. Anything else that is not an indented bullet is prose, and stopping
    // at it is what keeps a paragraph below the checks from being read as a broken one.
    if (TOP_BULLET.test(line) || ANY_HEADING.test(line)) break;
    if (!/^\s+[-*]\s/.test(line)) break;
    raw.push(line);
  }

  const stated = inline.trim();
  if (stated === NONE) {
    // Both halves written is a contradiction, and the silent resolution — believe one —
    // is how a feature comes to be graded against checks its author had disowned.
    if (raw.length > 0) problems.push(`${where}: says "${NONE}" and then lists ${raw.length} check(s) — one of the two is wrong`);
    return [];
  }
  if (stated !== "") {
    problems.push(`${where}: the checks go in indented sub-bullets beneath this one, not on it ("${stated.slice(0, 40)}")`);
  }
  if (raw.length === 0) {
    problems.push(`${where}: carries no checks — write "${NONE}" when a feature deliberately has none, never nothing`);
    return [];
  }

  const out: EvidenceSpec[] = [];
  for (const line of raw) {
    const m = ACCEPTANCE_CHECK.exec(line);
    if (m === null) {
      problems.push(`${where}: cannot read "${line.trim().slice(0, 50)}" — write it as "- \`command\` — what passing it shows"`);
      continue;
    }
    out.push({ kind: "command", run: m[1]!.trim(), expect: m[2]!.trim() });
  }
  return out;
}

/**
 * Parse every feature out of one epic document.
 *
 * `epicBody` is the epic's body — frontmatter already stripped — and `epicId` is the
 * parent every feature is attributed to.
 */
export function parseFeatures(epicId: string, epicBody: string): FeatureParse {
  const lines = epicBody.split(/\r?\n/);
  const features: Feature[] = [];
  const problems: string[] = [];
  const flags: string[] = [];

  // Where each feature block starts, so a block runs to the next heading of any depth.
  const starts: number[] = [];
  lines.forEach((line, i) => { if (FEATURE_HEADING.test(line)) starts.push(i); });

  if (starts.length === 0) {
    problems.push(`${epicId}: declares no features — an epic slices its requirements into at least one "### Feature <n>.<m>:"`);
    return { features, problems, flags };
  }

  const seenNumbers = new Set<string>();

  starts.forEach((start, idx) => {
    const m = FEATURE_HEADING.exec(lines[start]!)!;
    const number = m[1]!;
    const title = m[2]!;
    const where = `${epicId} feature ${number}`;

    if (seenNumbers.has(number)) problems.push(`${where}: declared twice — feature numbers are unique within an epic`);
    seenNumbers.add(number);

    // The block ends at the next heading of any depth, not just the next feature: a
    // trailing `## Something else` must not swallow the rest of the document into it.
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (ANY_HEADING.test(lines[i]!)) { end = i; break; }
    }

    const found = new Map<string, string>();
    /** Where each bullet was, because `Acceptance` owns the indented lines beneath it. */
    const foundAt = new Map<string, number>();
    for (let i = start + 1; i < end; i++) {
      const b = TRACE_BULLET.exec(lines[i]!);
      if (!b) continue;
      const label = b[1]!.trim();
      if (!REQUIRED_BULLETS.includes(label as (typeof REQUIRED_BULLETS)[number])) {
        // A bullet shaped like a feature bullet but labelled something else. If it carries
        // ids it is almost certainly a misspelling of one of the three, and a silent skip
        // would lose them — so it is a finding rather than ignored.
        if (new RegExp(CRITERION_ID.source).test(b[2]!)) {
          problems.push(`${where}: bullet "**${label}:**" carries criterion ids but is not one of ${REQUIRED_BULLETS.join(", ")}`);
        }
        continue;
      }
      if (found.has(label)) problems.push(`${where}: "**${label}:**" appears twice`);
      else { found.set(label, b[2]!); foundAt.set(label, i); }
    }

    for (const label of REQUIRED_BULLETS) {
      if (!found.has(label)) problems.push(`${where}: missing "- **${label}:**" — write "${NONE}" if the list is empty, never omit the bullet`);
    }

    const delivers = found.has(DELIVERS) ? parseIdList(found.get(DELIVERS)!, `${where} Delivers`, problems) : [];
    const renders = found.has(RENDERS) ? parseIdList(found.get(RENDERS)!, `${where} Renders`, problems) : [];
    const dependsOn = found.has(DEPENDS) ? parseIdList(found.get(DEPENDS)!, `${where} Depends on`, problems) : [];

    const both = delivers.filter((id) => renders.includes(id));
    if (both.length > 0) problems.push(`${where}: ${both.join(", ")} is in both Delivers and Renders — a slice either implements a criterion or presents it`);

    const selfDep = dependsOn.filter((id) => delivers.includes(id));
    if (selfDep.length > 0) problems.push(`${where}: depends on ${selfDep.join(", ")}, which it delivers itself`);

    const acceptance = found.has(ACCEPTANCE)
      ? parseAcceptance(found.get(ACCEPTANCE)!, lines, foundAt.get(ACCEPTANCE)! + 1, end, `${where} Acceptance`, problems)
      : [];

    features.push({ id: `${epicId}#${number}`, epic: epicId, number, title, delivers, renders, dependsOn, acceptance, position: idx + 1 });
  });

  // Ids outside every feature block. Normal here — an epic quotes the criteria it narrows —
  // so this is reported and never refused. See the divergence note at the top of the file.
  const inBlocks = new Set<number>();
  starts.forEach((start) => {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) if (ANY_HEADING.test(lines[i]!)) { end = i; break; }
    for (let i = start; i < end; i++) inBlocks.add(i);
  });
  const outside = new Set<string>();
  lines.forEach((line, i) => {
    if (inBlocks.has(i)) return;
    for (const mm of line.matchAll(CRITERION_ID)) outside.add(mm[1]!);
  });
  if (outside.size > 0) {
    flags.push(`${epicId}: ${[...outside].sort().join(", ")} appear outside every feature block — quoted prose, which is legal; only the feature bullets are read as data`);
  }

  return { features, problems, flags };
}

/** Every criterion the features claim to IMPLEMENT — the coverage denominator's input (ADR-0005). */
export function delivered(features: readonly Feature[]): string[] {
  return [...new Set(features.flatMap((t) => t.delivers))];
}

/**
 * Every feature in a whole epic layer, in (epic serve order, declaration order).
 *
 * Features have no serve order of their own and deliberately do not get one: they are read
 * out of a document, and their order in that document IS the order the epic's author
 * wrote them in. A separate ordering field would be a second source of truth for a fact
 * the artifact already carries — and the scaffold, which everything is built on, is
 * feature 1 of epic 1 for exactly that reason.
 */
export function featuresOfEpics(
  epics: readonly { id: string; body: string; status?: string }[],
): FeatureParse {
  const features: Feature[] = [];
  const problems: string[] = [];
  const flags: string[] = [];
  for (const e of epics) {
    // **A RETIRED epic is not asked for features**. `status: done` on an epic
    // means its work was completed under the previous ladder: the criteria it delivers are
    // built, and demanding the new shape of a document written before that shape existed
    // would report it malformed for ever. `parseFeatures` refuses an epic declaring none,
    // and the malformed check returns before the chain is consulted — so on a target
    // whose seven epics predate all of this, the loop would stall the first tick after its
    // last intent finished. Nothing red, nothing spent, the program's remaining work never
    // started.
    //
    // Its `delivers` still counts for coverage, which is the whole point: retiring an epic
    // must not make the chain re-plan work that is already built. This ONLY stops the
    // engine asking it for features, a grade, or children.
    //
    // **The status cannot be self-awarded.** `mechanicalFindings` refuses `done` on a newly
    // minted epic, so it can only arrive by an observer editing a file — which is what
    // retirement is. Without that refusal this would be a gate an ACT could switch off by
    // writing one word, and coverage would be claimed by an epic that built nothing.
    if (e.status === "done") {
      flags.push(`${e.id}: retired — its coverage counts and nothing is asked of it`);
      continue;
    }
    const r = parseFeatures(e.id, e.body);
    features.push(...r.features);
    problems.push(...r.problems);
    flags.push(...r.flags);
  }
  return { features, problems, flags };
}
