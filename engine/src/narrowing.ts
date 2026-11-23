import { lintCoverage, type CriteriaParse } from "./coverage.js";
import { parseEnvelope, parseEvidence, type EvidenceSpec } from "./envelope.js";
import { inDependencyOrder } from "./depends.js";
import type { Feature } from "./feature.js";

/**
 * A **narrowing**: one document that restates a slice of its parent, small enough that
 * the rung below never reads the whole program.
 *
 * ```
 * PRD + ARCH   ──►  epic      a slice of the app, its features as HEADINGS inside it
 * feature      ──►  units     scaffolded, then built out just-in-time
 * ```
 *
 * **There is one narrowing level: the epic** (ADR-0001). A feature is a
 * `### Feature <n>.<m>:` heading written inside its epic — `feature.ts` — not a
 * document of its own. Measured: 30 feature documents on one target produced 33
 * intents, a fan-out of 1.1, which is a rename rather than a narrowing, and they ran to
 * a median of 19,111 characters of restated requirement detail.
 *
 * **The rung this replaced wrote a single "brief" per ladder step**, and a ladder step is
 * an epic. PRD §5's steps ran from 3 to 14 criteria; step 3 held 14 of them, produced
 * TWELVE intents, and its brief was the largest document on the target at 44,516
 * characters — longer than the PRD it narrows. One document cannot be both the slice of
 * an app and the thing a planner builds from. A feature HEADING does not reopen that: it
 * restates nothing, it names ids.
 *
 * **There is no feature RUNG.** Features are part of their epic and are written with it,
 * in one ACT. Nothing plans a feature separately, so nothing reviews a feature set
 * separately either: the only question is whether every requirement of an epic is
 * captured in one of its features, and `lintFeatures` is that question. `feature`
 * survives as a parseable LEVEL so an arena still holding documents from the old ladder
 * loads instead of exploding; it is removed at cutover.
 */

export const NARROWING_LEVELS = ["epic", "feature"] as const;
export type NarrowingLevel = (typeof NARROWING_LEVELS)[number];

export const NARROWING_STATUSES = ["active", "done"] as const;
export type NarrowingStatus = (typeof NARROWING_STATUSES)[number];

export interface Narrowing {
  id: string;
  level: NarrowingLevel;
  title: string;
  status: NarrowingStatus;
  /**
   * The epic this feature narrows. Required on a feature, absent on an epic — an epic's
   * parent is the program itself, which is not an artifact with an id.
   */
  parent?: string;
  /**
   * Sibling ids that must be served before this one.
   *
   * **This is what the chain schedules on, and its absence built the program backwards.**
   * `nextChainNeed` walked epics in store order, which is `readdir`, which is alphabetical —
   * so on one target it began at `ep-categorisation-and-judgment` (PRD §5 step 3) before
   * `ep-hours-to-invoice` (steps 0-1, the harness) or `ep-ledger-and-close` (step 2) existed.
   * The first intent it cut needed a `matches` table the step-2 slice owns, three units were
   * built and merged, and the intent could not pass: three of the eight modules its
   * acceptance imports belonged to slices that had not been started. Measured 2026-09-15.
   *
   * Every epic already states its ladder position in its own prose. Nothing read it.
   */
  dependsOn: string[];
  /** PRD criterion ids this narrowing accounts for. The whole coverage chain hangs on it. */
  delivers: string[];
  /** Criteria it merely presents. Recorded and reported; satisfies no coverage. */
  renders: string[];
  /**
   * The epic's own acceptance: the functional suite the ENGINE runs, with no LLM, once
   * every feature under it is done (ADR-0003). The lightest of the three and the last to
   * fire — a unit's probes are heavy and implementation-specific, a feature's are a
   * handful of end-to-end checks, and this one asks whether the product-level flow works.
   *
   * **Empty on every epic written before ADR-0003, and that is not a parse error.** It is
   * also not a vacuous pass: the epic grade refuses to close an epic carrying no
   * acceptance, because a level with nothing to run has not been graded — it has been
   * skipped. Where that distinction is enforced is the grade, never here; a parser cannot
   * know which levels are owed acceptance and a grade can.
   *
   * A feature's acceptance lives in its heading instead (`feature.ts`), because a feature
   * is a heading and has no frontmatter to put it in. Same shape, same executor, same
   * meaning — only the authoring surface differs, because the container differs.
   */
  evidence: EvidenceSpec[];
  body: string;
  /**
   * The whole document, frontmatter included, exactly as written.
   *
   * The store persists THIS rather than re-serialising the fields, so what is published
   * is byte-for-byte what the judge read. Round-tripping through a serialiser would let
   * the published artifact differ from the judged one — in comment formatting, key order,
   * anything — and the gate's whole claim is that it ruled on what shipped.
   */
  source: string;
  /**
   * Where it came from: a repo-relative path today, an issue reference once the store
   * moves. Used in messages and to locate the parent; never parsed for meaning.
   */
  path: string;
}

export type NarrowingParse = { ok: true; narrowing: Narrowing } | { ok: false; errors: string[] };

export function parseNarrowing(markdown: string, path: string): NarrowingParse {
  const { frontmatter: fm, envelope, body, errors } = parseEnvelope(markdown, path);

  // Level is the envelope's business; which levels are NARROWINGS is this module's. An
  // intent shares the envelope and is not one of these — it carries acceptance evidence
  // and a budget, and is parsed by `intent.ts`.
  if (envelope.level !== undefined && envelope.level !== "epic" && envelope.level !== "feature") {
    errors.push(`${path}: level "${envelope.level}" is not a narrowing — epics and features are`);
  }
  if (!NARROWING_STATUSES.includes(envelope.status as NarrowingStatus)) {
    errors.push(`${path}: status must be one of: ${NARROWING_STATUSES.join(", ")}`);
  }
  // A narrowing that delivers nothing cannot be checked against its parent in either
  // direction, so it is not a narrowing. Contrast an INTENT, where an empty `delivers` is
  // legal and reported (`structuralIntents`): an intent can be real structural work, but
  // a document whose only job is to restate a slice of requirements has no such case.
  if ((envelope.delivers ?? []).length === 0) errors.push(`${path}: a narrowing must declare the criterion ids it delivers`);

  const evidence = parseEvidence(fm["evidence"], `${path} evidence`, errors);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    narrowing: {
      id: envelope.id!,
      level: envelope.level as NarrowingLevel,
      title: envelope.title!,
      status: envelope.status as NarrowingStatus,
      ...(envelope.parent !== undefined ? { parent: envelope.parent } : {}),
      dependsOn: envelope.dependsOn ?? [],
      delivers: envelope.delivers!,
      renders: envelope.renders ?? [],
      evidence,
      body,
      source: markdown,
      path,
    },
  };
}

export interface ChainLint {
  ok: boolean;
  problems: string[];
  flags: string[];
}

/**
 * **Hop 1 — epics against the program.** Every criterion reaches an epic, and no epic
 * claims one the PRD does not contain.
 *
 * This is `lintCoverage` with epics standing in for intents, which it can do because it
 * only ever reads `{ id, delivers }`. One implementation, two callers, no sibling to fall
 * out of step with.
 */
export function lintEpics(parse: CriteriaParse, epics: readonly Narrowing[]): ChainLint {
  const problems: string[] = [];
  for (const e of epics) {
    if (e.level !== "epic") problems.push(`${e.id}: level is "${e.level}", but it was loaded as an epic`);
  }
  const seen = new Set<string>();
  for (const e of epics) {
    if (seen.has(e.id)) problems.push(`duplicate epic id ${e.id}`);
    seen.add(e.id);
  }
  const coverage = lintCoverage(parse, epics, "epic");
  return { ok: problems.length === 0 && coverage.ok, problems: [...problems, ...coverage.problems], flags: coverage.flags };
}

/**
 * **Hop 2, asked of the new shape — an epic's FEATURES against that epic.**
 *
 * Same question as `lintFeatureDocs` and a different artifact: the features are parsed out of
 * the epic rather than loaded beside it, so there is no parent to check and no level to
 * mismatch. What is left is the pair of directions that matter.
 *
 * **Bloat is judged on both lists.** Presenting a criterion the epic has no record of is
 * scope from outside the slice just as surely as implementing one is — the screen has to
 * come from somewhere, and this epic is not where it is written down.
 *
 * **Coverage is judged on `Delivers` alone** (ADR-0005). A slice that only renders a
 * criterion accounts for none of it. That asymmetry is the whole point of the split: the
 * case it exists to catch is a UI feature claiming everything it merely displays, which
 * makes coverage pass while the product is unbuilt. When that happens the message says so
 * rather than reporting the criterion as simply missing, because the two have different
 * fixes.
 */
export function lintFeatures(epic: Narrowing, features: readonly Feature[]): ChainLint {
  const problems: string[] = [];
  const flags: string[] = [];
  const builds = new Set(epic.delivers);
  const shows = new Set(epic.renders);
  const scope = new Set([...epic.delivers, ...epic.renders]);
  const delivered = new Map<string, string[]>();
  const rendered = new Map<string, string[]>();

  for (const f of features) {
    if (f.epic !== epic.id) problems.push(`${f.id}: parsed out of "${f.epic}", checked against "${epic.id}"`);
    for (const c of [...f.delivers, ...f.renders]) {
      if (!scope.has(c)) problems.push(`${f.id} names ${c}, which ${epic.id} does not — a feature may not bring scope its epic has no record of`);
    }
    for (const c of f.delivers) {
      if (shows.has(c) && !builds.has(c)) {
        problems.push(`${f.id} delivers ${c}, which ${epic.id} only renders — the epic says something else builds it`);
      } else if (builds.has(c)) delivered.set(c, [...(delivered.get(c) ?? []), f.id]);
    }
    for (const c of f.renders) if (scope.has(c)) rendered.set(c, [...(rendered.get(c) ?? []), f.id]);
  }

  for (const c of epic.delivers) {
    const by = delivered.get(c);
    if (by === undefined || by.length === 0) {
      const shown = rendered.get(c) ?? [];
      problems.push(shown.length > 0
        ? `${c} is delivered by ${epic.id} and by none of its features — ${shown.join(", ")} renders it, and rendering delivers nothing`
        : `${c} is in ${epic.id} and in none of its features — the epic is faithful to the PRD, every feature is faithful to the epic, and the requirement is gone`);
    } else if (by.length > 1) {
      flags.push(`${c} is split across ${by.length} features (${by.join(", ")}) — legal, provided they grade the whole of it between them`);
    }
  }

  // The mirror, for the other list. An epic claiming it presents something no feature
  // presents is the same failure one column over, and it is the one a reader skims past:
  // the screen is in the plan and in nobody's slice.
  for (const c of epic.renders) {
    if ((rendered.get(c) ?? []).length === 0) problems.push(`${c} is rendered by ${epic.id} and by none of its features`);
  }

  if (features.length === 0) problems.push(`${epic.id} has no features — an epic is not buildable and nothing below it can start`);
  return { ok: problems.length === 0, problems, flags };
}

/**
 * **Hop 3 — an intent set against the one feature it belongs to.**
 *
 * Identical in shape to hop 2 and deliberately so; `items` is anything carrying an id and
 * a `delivers` list, which is what lets an intent be checked here without this module
 * knowing what an intent is.
 *
 * The one difference from `lintFeatureDocs`: an intent covering NOTHING is allowed through,
 * because structural work is real (a test harness, a table the categories point at) and
 * forcing it to name a criterion it does not grade is coverage typed into existence.
 * It is reported rather than refused — see `structuralIntents` in `coverage.ts`.
 */
export function lintChildren(
  feature: { id: string; delivers: readonly string[] },
  items: readonly { id: string; delivers: readonly string[] }[],
): ChainLint {
  const problems: string[] = [];
  const flags: string[] = [];
  const owned = new Set(feature.delivers);
  const claimed = new Map<string, string[]>();

  for (const it of items) {
    if (it.delivers.length === 0) {
      flags.push(`${it.id} delivers no criterion: structural work, reported not refused. Which criterion would fail if it were deleted?`);
      continue;
    }
    for (const c of it.delivers) {
      if (!owned.has(c)) {
        problems.push(`${it.id} delivers ${c}, which ${feature.id} does not — scope from outside the feature it belongs to`);
        continue;
      }
      claimed.set(c, [...(claimed.get(c) ?? []), it.id]);
    }
  }

  for (const c of feature.delivers) {
    const by = claimed.get(c);
    if (by === undefined || by.length === 0) problems.push(`${c} is in ${feature.id} and in none of its children`);
    else if (by.length > 1) flags.push(`${c} is split across ${by.length} children (${by.join(", ")})`);
  }

  return { ok: problems.length === 0, problems, flags };
}

/**
 * What the chain owes next — computed from artifacts, never decided at runtime.
 *
 * The loop used to ask an LLM "which step is next?" on every run, against eighty
 * thousand characters. Here it is a read of committed state, in a fixed order, and the
 * order is the whole design: nothing below a level starts until that level is complete
 * and checked, because a feature cut from an incomplete epic is cut from a document that
 * is still moving.
 */
export type ChainNeed =
  /** No epic delivers the program yet. Mint one; `covered` says what is already claimed. */
  | { kind: "epic"; covered: string[] }
  /** This feature is ready to have its units planned. */
  | { kind: "children"; epic: Narrowing; feature: Feature }
  /** Every criterion is claimed down to a feature and every feature is served. */
  | { kind: "complete" }
  /**
   * The program declares no identified criteria, so the chain has nothing to measure.
   *
   * NOT "complete", which is the whole reason this arm exists. Coverage over an empty set
   * is vacuously satisfied at every hop, so a PRD whose criteria carry no ids would have
   * reported the chain finished, skipped every rung beneath it, and idled — the silent
   * no-op that `lintCoverage` already refuses for the same reason one level down.
   */
  | { kind: "unmeasurable"; detail: string };

export interface ChainState {
  criteria: readonly string[];
  epics: readonly Narrowing[];
  /** Parsed out of `epics` by `featuresOfEpics`. Features are never loaded separately. */
  features: readonly Feature[];
  /** Ids of features whose units are planned — the caller decides what that means. */
  servedFeatures: ReadonlySet<string>;
}

/**
 * Order: finish the epic layer, then finish one epic's features, then plan that
 * feature's children.
 *
 * Epics first and to completion, because the epic layer is the only place the WHOLE
 * program is in view; cutting features from a half-drawn epic layer means the slice
 * boundaries move underneath work already done. Features one epic at a time, because
 * that is the smallest unit the operator can read and veto.
 */
/**
 * Siblings in the order the chain must serve them: `after` first, then store order.
 *
 * **A stable topological sort, and both halves of that matter.** Topological, because a
 * slice that another slice waits on has to come first — building step 3 before step 0 is
 * what this function exists to stop. Stable, because among documents with no edge between
 * them the previous order is kept, so adding one `after:` re-orders exactly what it names
 * and nothing else.
 *
 * A CYCLE is not resolved here and must not be: this returns the remaining documents in
 * store order rather than inventing a winner, and `reviewEpicSet` refuses the set outright.
 * Picking silently would schedule a program whose own dependency graph is impossible and
 * report nothing.
 *
 * An `after` naming an id that does not exist is likewise not this function's to judge —
 * it is treated as satisfied here and refused by the set review, which can say so with the
 * whole set in hand.
 */
export function inServeOrder(docs: readonly Narrowing[]): Narrowing[] {
  return inDependencyOrder(docs);
}

export function nextChainNeed(state: ChainState): ChainNeed {
  if (state.criteria.length === 0) {
    return {
      kind: "unmeasurable",
      detail: "the PRD declares no identified criteria — every hop of the chain would pass vacuously and the loop would idle with the whole program unbuilt",
    };
  }
  const claimedByEpics = new Set(state.epics.flatMap((e) => e.delivers));
  const uncovered = state.criteria.filter((c) => !claimedByEpics.has(c));
  if (uncovered.length > 0) return { kind: "epic", covered: [...claimedByEpics] };

  // Serve order, not store order. `readdir` is alphabetical, and alphabetical put PRD §5
  // step 3 ahead of steps 0 through 2 on one target — see `Narrowing.after`.
  const epics = inServeOrder(state.epics);

  for (const epic of epics) {
    // Declaration order inside the epic, which the features already carry: their order in
    // the document IS the order their author wrote them in. That is what puts the scaffold
    // first — it is feature 1 of epic 1, where it was written.
    for (const feature of state.features.filter((f) => f.epic === epic.id)) {
      if (!state.servedFeatures.has(feature.id)) return { kind: "children", epic, feature };
    }
  }

  return { kind: "complete" };
}

/**
 * Which features are finished being planned — computed, not assumed.
 *
 * A feature is served when the intents under it cover **all** of its criteria, or when it
 * has been explicitly marked `done`. Not when *an* intent names it.
 *
 * That distinction is the whole of this function and it was got wrong, in a way worth
 * recording because neither half looked wrong alone. The intent ceiling is three, so a
 * feature holding more criteria than that legitimately takes several ACTs — which is why
 * a judge reporting outstanding slices is a PASS. Meanwhile "served" meant "some intent
 * names it". Compose the two and the first batch of three marks the feature finished:
 * `nextChainNeed` never returns to it, the remaining criteria reach no intent, and the
 * chain reports `complete` with requirements dropped.
 *
 * That is precisely the false completeness the chain exists to prevent, arriving at its
 * last hop, through two changes that were each correct on their own. External review
 * caught it in the pull request whose prose claimed every hop was checked both ways.
 */
export function servedFeatures(
  features: readonly Feature[],
  children: readonly { id: string; delivers: readonly string[]; parent?: string }[],
): Set<string> {
  const served = new Set<string>();
  for (const f of features) {
    const mine = children.filter((c) => c.parent === f.id);
    // `delivers`, not delivers-and-renders: a feature is finished being planned when
    // something is going to BUILD each of its criteria (ADR-0005). There is no `done`
    // status to short-circuit this, because a feature has no status — it is part of its
    // epic, and whether it is served is computed from what is under it.
    if (mine.length > 0 && lintChildren({ id: f.id, delivers: f.delivers }, mine).ok) served.add(f.id);
  }
  return served;
}
