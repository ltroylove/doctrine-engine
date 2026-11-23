import { parseEvidence, parseEnvelope, parseFrontmatter, type EvidenceSpec } from "./envelope.js";

/**
 * The work-unit contract: one Markdown file per unit, YAML frontmatter
 * carrying the machine-readable contract, prose body carrying intent + context.
 * The admissibility rule is the hard gate: no machine-checkable evidence, no entry
 * to the loop.
 */

/**
 * Every status a work document may hold. **One vocabulary, because there is one type.**
 *
 * `Intent` and `WorkUnit` are the same thing now (ADR-0001/0002), and while they were two
 * types they had two enums that overlapped on exactly one token — `ready` — meaning two
 * different things: *has acceptance, may be decomposed* on one and *admissible to the
 * loop* on the other. That is the "two names for one edge" hazard inverted, and it is
 * worse: one name for two edges.
 *
 * What makes a single enum safe is that the two DIALECTS below never meet in one array.
 * `loadUnits` reads `work/*.md` with a non-recursive `readdir` filtered to `.md`, so the
 * `work/intents/` directory beneath it is not in the listing; `loadIntents` reads that
 * directory and nothing else. Every reader filters by collection before it looks at a
 * status. Checked rather than assumed, because it is the whole load-bearing claim here.
 */
export const WORK_STATUSES = [
  // Minted with its epic, carrying what it delivers, what it waits on, and its `## Intent`
  // — and nothing about HOW. The half that is frozen when build-out appends the spec below
  // it. It carries one law wherever it appears: a scaffold with evidence is
  // refused, because a probe written before the tree exists is a guess about an interface
  // nobody has built.
  "scaffold",
  "draft",
  /** LEGACY (intent dialect): minted by the program ACT, awaiting the program-judge. */
  "proposed",
  "ready",
  "in-progress",
  "verified",
  // Judged, pushed, PR open, waiting on external review. A unit sits here
  // for one window, not for an approval.
  "in-review",
  /** LEGACY (intent dialect): has child units in flight. A unit has no children. */
  "decomposed",
  "merged",
  /** LEGACY (intent dialect): its acceptance was run by the engine and passed. */
  "done",
  "escalated",
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

/**
 * The name the rest of the engine has always used. Kept as an alias rather than
 * search-replaced: the rename would touch every file that mentions a unit and prove
 * nothing, and `UnitStatus` is still what the field means where it is read.
 */
export type UnitStatus = WorkStatus;

/**
 * The statuses a UNIT document may hold — the dialect gate, not the type.
 *
 * `decomposed`, `proposed` and `done` are absent because a unit has no children to
 * decompose, no judge minting it, and no engine-run acceptance of its own. They are
 * deleted outright at cutover once no intent document is left in flight.
 */
export const UNIT_STATUSES: readonly WorkStatus[] = [
  "scaffold", "draft", "ready", "in-progress", "verified", "in-review", "merged", "escalated",
];

/** LEGACY: the statuses an INTENT document may hold. Deleted with the dialect at cutover. */
export const INTENT_STATUSES: readonly WorkStatus[] = [
  "scaffold", "proposed", "ready", "decomposed", "done",
];

export const TIERS = ["reversible", "irreversible"] as const;
export type Tier = (typeof TIERS)[number];

/**
 * Re-exported, not redeclared. Acceptance is carried at three levels now (ADR-0003), so
 * its shape and its parser live with the envelope every level shares — see
 * `envelope.ts`. These names stay here because two dozen call sites import them from
 * this module and a rename is risk with no return.
 */
export { EVIDENCE_KINDS, type EvidenceKind, type EvidenceSpec } from "./envelope.js";

export interface WorkUnit {
  id: string;
  title: string;
  tier: Tier;
  status: UnitStatus;
  budgetUsd: number;
  /**
   * The REQUIREMENTS that must be satisfied before this unit can be built (ADR-0004) —
   * PRD criterion ids, never another document's id.
   */
  dependsOn: string[];
  /**
   * PRD criterion ids this unit IMPLEMENTS. The only list coverage counts (ADR-0005).
   *
   * **New, and empty on every unit written before now.** Until ADR-0001 only an intent
   * declared coverage, so a unit's `depends_on` had to resolve one level up — a criterion
   * was satisfied when every INTENT delivering it was done. That indirection is real
   * wiring, not a bridge, and it is what collapses here: the thing that declares
   * `delivers` and the thing that gets built become one.
   */
  delivers: string[];
  /** Criteria it merely PRESENTS. Satisfies no coverage; a dependent still waits on it. */
  renders: string[];
  /**
   * The probes a judge executes against this unit's diff — its acceptance, and the ONLY
   * acceptance it carries (ADR-0003). Heavy and implementation-specific on purpose,
   * because it is written just-in-time against a tree that exists. The lighter end-to-end
   * checks live one and two rungs up, on the feature and the epic, which is what keeps a
   * unit from grading itself unopposed.
   */
  evidence: EvidenceSpec[];
  /**
   * The FEATURE this unit belongs to — `<epic id>#<n.m>`, a heading inside its epic.
   *
   * Distinct from `intent` below, and deliberately NOT a rename of it. They name two
   * different things: a feature heading and an intent document. Aliasing them would give
   * the ~90 units already merged on one target a `parent` that claims to be a feature
   * and is not — and `PARENT_LEVEL` says a unit's parent is a feature, so a lint would
   * read that claim and believe it. A missing field is recoverable; a wrong one is not.
   */
  parent?: string;
  /**
   * Backlink to the intent this unit was decomposed from, if any. **Legacy.** Every unit
   * already in flight carries it and the four-level dispatcher reads
   * it (`units.filter(u => u.intent === i.id)`). Deleted at cutover, not
   * before: those programs finish under the ladder they were planned on.
   */
  intent?: string;
  /**
   * The TICKET this came from, when it came from one — `M-<issue#>`.
   *
   * **Origin, not parent, and the distinction is the whole ticket design.** Work born from
   * a ticket still names the feature it belongs to and is still checked against it in both
   * directions. Parenting it to the ticket instead would let a ticket introduce work no
   * feature carries, which is the hole this ladder exists to close: if a ticket wants
   * something its feature does not cover, the feature has to grow first, and approving a
   * `growth` ticket is accepting a PRD change.
   */
  origin?: string;
  /** The prose body: intent, context pointers, out-of-scope. */
  body: string;
}

export type ParseResult =
  | { ok: true; unit: WorkUnit }
  | { ok: false; errors: string[] };

export function parseWorkUnit(markdown: string, where = "unit"): ParseResult {
  // The SHARED half read by the one parser that owns it: id, title, status, parent,
  // depends_on, delivers, renders. It was hand-rolled here, and that is how `delivers`
  // came to exist at three levels and not at the level that actually gets built.
  //
  // `strictLink: false` with a default level, for the reason `intent.ts` gives in the same
  // words: a parser reads what exists, a gate refuses what may be created. Every unit
  // already in flight was written before `level:` and `parent:` existed, and a
  // strict parser here would leave the loop unable to read its own merged work.
  const { frontmatter: fm, body, envelope, errors } = parseEnvelope(markdown, where, {
    strictLink: false,
    defaultLevel: "unit",
  });
  if (envelope.level !== undefined && envelope.level !== "unit") {
    errors.push(`${where}: level "${envelope.level}" is not a unit`);
  }
  if (!TIERS.includes(fm["tier"] as Tier)) errors.push(`tier must be one of: ${TIERS.join(", ")}`);
  if (envelope.status !== undefined && !UNIT_STATUSES.includes(envelope.status as WorkStatus)) {
    errors.push(`status must be one of: ${UNIT_STATUSES.join(", ")}`);
  }
  if (typeof fm["budget_usd"] !== "number" || fm["budget_usd"] <= 0) {
    errors.push("budget_usd must be a positive number");
  }

  const evidence = parseEvidence(fm["evidence"], "evidence", errors);

  // The scaffold law, moved down to the thing that is built. A scaffold is minted with its
  // epic, before the tree exists; evidence written then is a guess about an interface
  // nobody has built, and the guess is load-bearing by the time a judge executes it. The
  // spec is appended when the unit is reached and the tree can be read — which is the
  // whole reason there are two states rather than one.
  if (envelope.status === "scaffold" && evidence.length > 0) {
    errors.push(`${where}: a "scaffold" unit must carry no evidence — the spec is appended when the unit is reached, against the tree as it then is`);
  }

  // NOT checked here: that `intent` and `parent` agree, or that either is present. They
  // name different things (see the field docs) and the mint gate is where a newly written
  // one is refused.
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    unit: {
      id: envelope.id!,
      title: envelope.title!,
      tier: fm["tier"] as Tier,
      status: envelope.status as WorkStatus,
      budgetUsd: fm["budget_usd"] as number,
      dependsOn: envelope.dependsOn ?? [],
      delivers: envelope.delivers ?? [],
      renders: envelope.renders ?? [],
      evidence,
      ...(envelope.parent !== undefined ? { parent: envelope.parent } : {}),
      ...(typeof fm["intent"] === "string" ? { intent: fm["intent"] } : {}),
      ...(typeof fm["origin"] === "string" && fm["origin"].trim().length > 0 ? { origin: (fm["origin"] as string).trim() } : {}),
      body,
    },
  };
}

export interface BuildOutLint {
  ok: boolean;
  problems: string[];
}

/**
 * The append contract (ADR-0001): **build-out writes BELOW the scaffold, and the scaffold
 * half is byte-identical afterwards.**
 *
 * A unit is minted with its epic as a scaffold — what it delivers, what it waits on, and
 * its `## Intent`, which is why the slice exists. It is built out just-in-time by an ACT
 * that reads the tree as it then is and appends its spec. The freeze is what keeps the two
 * halves meaning different things: **an intent rewritten to match what was built is the
 * ratchet running backwards.** Without it the ACT can quietly widen `delivers` to whatever
 * it found convenient, and every coverage number downstream is a report on the ACT's own
 * opinion.
 *
 * **`scaffold` → `draft` is the one edit the ACT makes to the frozen half, and it is named
 * rather than exempted.** It has to make it: a scaffold that carries evidence is refused by
 * the parser above, and evidence is exactly what build-out adds. So the ACT writes a draft,
 * the engine promotes draft → ready once this gate passes, and that is the shape
 * `runDecompose` already has. The alternative — the ACT leaving the status alone — would
 * put a document in a state its own parser rejects.
 *
 * **Three rules, and none of them depends on how the YAML is laid out.** An earlier form of
 * this compared the scaffold's frontmatter BYTES as a prefix of the built-out one. That
 * reads well and is wrong twice: it fails an ACT that inserts `evidence:` above a field
 * rather than below it, which is a formatting opinion and not a violation, and it passes a
 * field that was DELETED as long as nothing before it moved.
 *
 *  - **the body is a prefix.** This is where `## Intent` lives and it is the rule the
 *    ratchet actually needs. Bytes, because a normalisation of what was written compared
 *    to a normalisation of what was written would pass every rewrite that survives a
 *    round trip.
 *  - **no key vanishes, and the only key that may arrive is `evidence`.** Catches a
 *    deletion, which a prefix rule cannot see.
 *  - **every declared value is still that value.** Catches a line slipped into
 *    `delivers:`'s block list — an ADDITION, legal under any additions-only diff rule, and
 *    precisely the failure `Delivers`/`Renders` exists to stop (ADR-0005).
 */
export function lintBuildOut(scaffold: string, builtOut: string, where = "unit"): BuildOutLint {
  const problems: string[] = [];
  const before = parseWorkUnit(scaffold, `${where} (scaffold)`);
  const after = parseWorkUnit(builtOut, `${where} (built out)`);
  if (!before.ok) return { ok: false, problems: before.errors.map((e) => `scaffold does not parse: ${e}`) };
  if (!after.ok) return { ok: false, problems: after.errors.map((e) => `built-out unit does not parse: ${e}`) };

  if (before.unit.status !== "scaffold") {
    problems.push(`${where}: build-out was handed a "${before.unit.status}", not a scaffold — there is nothing frozen to append to`);
  }
  if (after.unit.status !== "draft") {
    problems.push(`${where}: build-out left status "${after.unit.status}" — it writes a draft, and the engine promotes it once this gate passes`);
  }
  // A build-out that appended no probes is not a build-out. The admissibility law refuses
  // it later anyway; refusing it HERE keeps the ACT's spend attributable to the thing it
  // failed to do, rather than surfacing three rungs away as a unit that never becomes
  // admissible and never says why.
  if (after.unit.evidence.length === 0) {
    problems.push(`${where}: build-out added no evidence — the spec is what it exists to append`);
  }

  const fmBefore = parseFrontmatter(scaffold, where);
  const fmAfter = parseFrontmatter(builtOut, where);

  // Line endings normalised before the prefix comparison, and that is not a weakening of
  // the rule. The two sides cross a boundary: the scaffold is read back from a git
  // checkout and the built-out half was written by the ACT, so on Windows one can be CRLF
  // and the other LF with nothing else different at all. A rule that called that a
  // rewritten `## Intent` would refuse every honest build-out on the operator's machine —
  // the same shape as the acceptance failures a `.gitattributes` change did not fix,
  // because it does not touch files already checked out. What is being asserted is that
  // the ACT did not rewrite the scaffold, and a line ending is not a rewrite.
  const lf = (t: string): string => t.replace(/\r\n/g, "\n");
  if (!lf(fmAfter.body).startsWith(lf(fmBefore.body))) {
    problems.push(`${where}: the scaffold's body is not a prefix of the built-out one — an \`## Intent\` rewritten to match what was built is the ratchet running backwards`);
  }

  const keysBefore = Object.keys(fmBefore.frontmatter);
  const keysAfter = new Set(Object.keys(fmAfter.frontmatter));
  for (const k of keysBefore) {
    if (!keysAfter.has(k)) problems.push(`${where}: build-out dropped \`${k}\` — the scaffold declared it`);
  }
  for (const k of keysAfter) {
    if (!keysBefore.includes(k) && k !== "evidence") {
      problems.push(`${where}: build-out added \`${k}\` — a build-out appends its spec, and \`evidence\` is the only field that is spec`);
    }
  }

  // Values, compared as values rather than as text, so a reordering passes and a widened
  // list does not.
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  const scalars: [string, unknown, unknown][] = [
    ["id", before.unit.id, after.unit.id],
    ["title", before.unit.title, after.unit.title],
    ["tier", before.unit.tier, after.unit.tier],
    ["budget_usd", before.unit.budgetUsd, after.unit.budgetUsd],
    ["parent", before.unit.parent, after.unit.parent],
    ["intent", before.unit.intent, after.unit.intent],
    ["origin", before.unit.origin, after.unit.origin],
  ];
  for (const [field, a, b] of scalars) {
    if (a !== b) problems.push(`${where}: build-out changed \`${field}\` from "${String(a)}" to "${String(b)}" — the scaffold declared it`);
  }
  const lists: [string, readonly string[], readonly string[]][] = [
    ["delivers", before.unit.delivers, after.unit.delivers],
    ["renders", before.unit.renders, after.unit.renders],
    ["depends_on", before.unit.dependsOn, after.unit.dependsOn],
  ];
  for (const [field, a, b] of lists) {
    if (!same(a, b)) {
      problems.push(`${where}: build-out changed \`${field}\` from [${a.join(", ")}] to [${b.join(", ")}] — what a slice covers is settled when it is scaffolded, not by the ACT that builds it`);
    }
  }

  return { ok: problems.length === 0, problems };
}

export type Admissibility =
  | { admissible: true }
  | { admissible: false; reasons: string[] };

/**
 * The hard gate: the dispatcher may only pick `ready` units with
 * non-empty executable evidence whose dependencies have all merged.
 */
export function isAdmissible(unit: WorkUnit, satisfiedCriteria: ReadonlySet<string>): Admissibility {
  const reasons: string[] = [];
  if (unit.status !== "ready") reasons.push(`status is "${unit.status}", not "ready"`);
  if (unit.evidence.length === 0) {
    reasons.push("no machine-checkable evidence — a unit without evidence cannot enter the loop");
  }
  // A dependency is a REQUIREMENT, and it is satisfied when every unit that delivers or
  // renders it has merged (ADR-0004) — computed by `satisfied` in `depends.ts`, which is
  // where "every, not any" is argued. A criterion nothing names is absent from that set
  // rather than vacuously true, so this refuses an edge that can never clear instead of
  // admitting against it.
  reasons.push(...unsatisfied(unit, satisfiedCriteria));
  return reasons.length > 0 ? { admissible: false, reasons } : { admissible: true };
}

/** The dependency clause, written once so both rungs that ask it ask the same question. */
function unsatisfied(unit: WorkUnit, satisfiedCriteria: ReadonlySet<string>): string[] {
  return unit.dependsOn
    .filter((dep) => !satisfiedCriteria.has(dep))
    .map((dep) => `requirement not satisfied: ${dep}`);
}

/**
 * May this scaffolded unit be BUILT OUT now — its spec written against the tree (ADR-0001)?
 *
 * A separate question from `isAdmissible`, because the two rungs want opposite things from
 * the same fields. Admissibility refuses a unit with no evidence; buildability refuses one
 * that HAS evidence, because a scaffold carrying evidence is a scaffold somebody already
 * built out, and re-running the ACT on it would overwrite a spec the freeze exists to
 * protect.
 *
 * **The dependency clause is the same clause**, shared rather than restated. It is also
 * the whole point of building out late: a spec written before its dependencies land is
 * written against a tree that does not have them, which is the guess the spec was moved
 * out of the scaffold to avoid.
 */
export function isBuildable(unit: WorkUnit, satisfiedCriteria: ReadonlySet<string>): Admissibility {
  const reasons: string[] = [];
  if (unit.status !== "scaffold") reasons.push(`status is "${unit.status}", not "scaffold"`);
  if (unit.evidence.length > 0) reasons.push("already carries evidence — this unit has been built out");
  reasons.push(...unsatisfied(unit, satisfiedCriteria));
  return reasons.length > 0 ? { admissible: false, reasons } : { admissible: true };
}
