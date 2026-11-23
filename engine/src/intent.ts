import { namedBy, type Slice } from "./depends.js";
import { parseEnvelope, parseEvidence, parseStringList } from "./envelope.js";
import { EVIDENCE_KINDS, INTENT_STATUSES, TIERS, type EvidenceKind, type EvidenceSpec, type Tier, type WorkStatus, type WorkUnit } from "./work-unit.js";

/**
 * **`Intent` is `WorkUnit`.** One type, because "intent" and "unit" named one thing twice
 * (ADR-0001, ADR-0002): a representative intent carried six executable probes citing source
 * files and line numbers, which is a specification, and in places a plan. The word now
 * means what it means outside this repo — an `## Intent` SECTION every document carries,
 * saying why the slice exists — and the implementable thing is a unit.
 *
 * What survives here is a DIALECT, not a type. An intent document spells its evidence
 * `acceptance:` and its tier `tier_default:`, has `level: intent`, and holds statuses no
 * unit holds. Twenty-one of them are in flight on one target and they finish under the
 * ladder they were planned on, so the parser stays and the meaning does not
 * fork: `parseIntent` reads that spelling and returns the same `WorkUnit` everything else
 * speaks.
 *
 * The statuses themselves now live in `work-unit.ts` beside the unit dialect's, for the
 * reason this repo has paid for five times: two vocabularies for one field is how a check
 * gets written for one level and not its sibling.
 */
export type Intent = WorkUnit;
export type IntentStatus = WorkStatus;

export type IntentParseResult = { ok: true; intent: Intent } | { ok: false; errors: string[] };


export function parseIntent(markdown: string, where = "intent"): IntentParseResult {
  // The SHARED half first — id, level, title, status, parent, delivers — so that the link
  // rule is enforced here in exactly the words it is enforced for an epic and a feature.
  // It was not, for one commit: `parent` was called `feature` here and the check lived in
  // a different file, which is two names for one edge and the reason this module stopped
  // parsing its own envelope.
  // `strictLink: false` and a default level: a parser reads what exists, and the mint gate
  // refuses what may be created. Being strict here would make every intent written before
  // this envelope unreadable — 21 of them on one target — so the coverage arithmetic
  // could not see the work it is meant to measure. `runProgramDecompose` is where a newly
  // minted intent with the wrong parent is refused.
  const { frontmatter: fm, body, envelope, errors } = parseEnvelope(markdown, where, {
    strictLink: false,
    defaultLevel: "intent",
  });

  if (envelope.level !== undefined && envelope.level !== "intent") {
    errors.push(`${where}: level "${envelope.level}" is not an intent`);
  }
  if (!INTENT_STATUSES.includes(envelope.status as WorkStatus)) {
    errors.push(`status must be one of: ${INTENT_STATUSES.join(", ")}`);
  }
  if (typeof fm["budget_usd"] !== "number" || fm["budget_usd"] <= 0) {
    errors.push("budget_usd must be a positive number");
  }
  if (!TIERS.includes(fm["tier_default"] as Tier)) {
    errors.push(`tier_default must be one of: ${TIERS.join(", ")}`);
  }
  const acceptance = parseEvidence(fm["acceptance"], "acceptance", errors);
  // **The dialect's third renaming, and the one that was missed.** `covers:` was renamed to
  // `delivers:` and nothing read the old spelling here — so all 33 intents on one target
  // parsed with `delivers: []`, `satisfiedCriteria` was empty on that target from the
  // rename on, and every decompose ACT there was told "Criteria you may depend on: (none)".
  // Invisible because the loop was paused; found while retiring its epics.
  //
  // Read-side only, beside `tier_default` and `acceptance` below: a parser reads what
  // exists. Both spellings at once is a contradiction rather than a preference, and the
  // silent resolution — believe one — is how a claim quietly changes what it covers.
  const legacyCovers = fm["covers"];
  if (legacyCovers !== undefined && fm["delivers"] !== undefined) {
    errors.push(`${where}: carries both \`covers\` and \`delivers\` — \`covers\` is the old spelling of \`delivers\`; keep one`);
  }
  const delivers = fm["delivers"] === undefined && legacyCovers !== undefined
    ? parseStringList(legacyCovers, "covers", errors)
    : envelope.delivers ?? [];
  const renders = envelope.renders ?? [];
  const dependsOn = parseStringList(fm["depends_on"], "depends_on", errors);

  // The admissibility law, one level up: an intent may not be ready/decomposed
  // without acceptance evidence.
  const status = envelope.status as WorkStatus;
  if ((status === "ready" || status === "decomposed") && acceptance.length === 0) {
    errors.push(`an intent cannot be "${status}" without acceptance evidence`);
  }

  // And its mirror, which is what keeps the scaffold from becoming the fiction rule 2
  // forbids. A scaffold is minted before the code exists; an acceptance command
  // written then is a guess about an interface nobody has built, and the guess is
  // load-bearing by the time anyone checks it. Acceptance is written when the intent
  // is reached and the tree can be read — that is the whole point of the two states.
  if (status === "scaffold" && acceptance.length > 0) {
    errors.push('a "scaffold" intent must carry no acceptance evidence — acceptance is written when the intent is reached, against the tree as it then is');
  }
  // NOT checked: that a scaffold declares a non-empty `delivers`. It was, and the rule
  // was wrong twice over.
  //
  // Mechanically it is redundant: completeness is a property of the SET, and
  // `lintCoverage` already fails when a criterion reaches no intent. An intent covering
  // nothing cannot hide a gap — it can only fail to close one, which the set-level lint
  // sees.
  //
  // And it forced dishonesty. Structural work exists — a chart of accounts the
  // categories point at, a test harness — and requiring every intent to name a criterion
  // makes the planner attach one it does not grade, which is coverage typed into
  // existence: the exact failure `lintCoverage`'s invented-id check exists to stop.
  //
  // An empty `delivers` is therefore legal and is a REPORTED SIGNAL (see
  // `structuralIntents` in coverage.ts). It always means one of two things, and never
  // that the work is fine as it stands: either the PRD states the requirement somewhere
  // the arithmetic does not index, or the PRD presupposes the work and no criterion
  // tests it. The falsifiable question is "which criterion would fail if this work were
  // deleted?" — and "none" is a defect report against the PRD, which is the operator's
  // document to fix.

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    intent: {
      id: envelope.id!,
      title: envelope.title!,
      status,
      budgetUsd: fm["budget_usd"] as number,
      // The dialect's two renamings, and neither loses a distinction. `tier_default` was
      // the default tier for an intent's CHILDREN; a unit has none, so the only tier left
      // is its own. `acceptance` and `evidence` were one list run at two moments — engine
      // post-merge, judge pre-merge — and ADR-0003 settles which survives at this level:
      // a unit's acceptance IS its probes, and the lighter end-to-end checks move up to
      // the feature and the epic, where a grade can still be run against something the
      // unit did not write.
      tier: fm["tier_default"] as Tier,
      evidence: acceptance,
      delivers,
      renders,
      dependsOn,
      ...(envelope.parent !== undefined ? { parent: envelope.parent } : {}),
      ...(typeof fm["origin"] === "string" && fm["origin"].trim().length > 0 ? { origin: (fm["origin"] as string).trim() } : {}),
      body,
    },
  };
}

export interface PlanLint {
  ok: boolean;
  problems: string[];
  /** Non-blocking, surfaced to the observer (e.g. irreversible-tier children). */
  flags: string[];
}

/**
 * Mechanical plan lint — deliberately NOT an LLM judge. Shape is checked
 * by code; semantic coverage is settled by the intent-grade tick against reality.
 */
export function lintPlan(intent: Intent, children: WorkUnit[], slices: readonly Slice[]): PlanLint {
  const problems: string[] = [];
  const flags: string[] = [];
  // The same index `satisfied` and `edgeProblems` read, built here from the slices that
  // actually declare coverage. Units do not: only an intent says what it delivers, so a
  // unit's `depends_on` resolves one level up — a criterion is satisfied when every intent
  // delivering or rendering it is done. That indirection is real wiring, not a bridge, and
  // it collapses when `Intent` and `WorkUnit` become one type and the thing that declares
  // `delivers` is the thing that gets built.
  const named = namedBy(slices);
  const own = new Set([...intent.delivers, ...intent.renders]);

  for (const u of children) {
    if (u.evidence.length === 0) problems.push(`${u.id}: no machine-checkable evidence`);
    if (u.intent !== intent.id) problems.push(`${u.id}: intent backlink is "${u.intent ?? ""}", expected "${intent.id}"`);
    if (u.tier === "irreversible") flags.push(`${u.id}: irreversible tier — surfaced for observer attention`);
    for (const dep of u.dependsOn) {
      // Waiting on its OWN intent. The intent is not done until every one of its units has
      // merged — this one included — so the edge is a deadlock with itself, and the unit
      // would sit inadmissible forever with nothing red and nothing spent. `edgeProblems`
      // refuses the same shape one level up; this is that rule where the criterion belongs
      // to the parent rather than to the slice.
      if (own.has(dep)) {
        problems.push(`${u.id}: depends on ${dep}, which its own intent ${intent.id} delivers — ${intent.id} cannot be done until ${u.id} merges, so the edge can never clear`);
        continue;
      }
      // And the unsatisfiable edge: a criterion no intent names is ABSENT from the
      // satisfied set rather than vacuously true, so admitting against it is impossible.
      // Unchecked it reads as "not ready yet" forever.
      if (!named.has(dep)) {
        problems.push(`${u.id}: depends on ${dep}, which no intent delivers or renders — an edge that can never clear`);
      }
    }
  }

  const budgetSum = children.reduce((s, u) => s + u.budgetUsd, 0);
  if (budgetSum > intent.budgetUsd) {
    problems.push(`child budgets sum to $${budgetSum}, exceeding the intent's $${intent.budgetUsd}`);
  }

  // NO cycle detection here, and its removal is the point of the change above. A cycle
  // needs a graph whose nodes are the things that name each other, and after ADR-0004 a
  // unit names criteria, never another unit — so the only graph that can hold one is the
  // graph over slices that declare `delivers`. `edgeProblems` owns it, at the level that
  // owns the coverage. Keeping a unit-id walk here would be a second, weaker statement of
  // a rule that already has one, applied to edges that no longer exist.

  return { ok: problems.length === 0, problems, flags };
}
