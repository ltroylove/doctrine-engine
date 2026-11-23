import { createHash } from "node:crypto";
import type { CriteriaParse } from "./coverage.js";
import { edgeProblems as sharedEdgeProblems } from "./depends.js";
import { inServeOrder, lintEpics, type ChainLint, type Narrowing, type NarrowingLevel } from "./narrowing.js";

/**
 * **The check nothing in this ladder performs: one COMPLETE level against itself.**
 *
 * Every gate above this reads one document. `narrowing-judge` scores one narrowing against
 * one parent; `mechanicalFindings` filters the hop arithmetic down to the problems that name
 * the document being minted, deliberately, because a level is not complete until its last
 * document lands and an incomplete set is nobody's fault.
 *
 * The consequence was measured on a target. Seven epics, every one of them
 * individually faithful to the PRD, judged and published. Two of them build the same thing:
 *
 * > `ep-hours-to-invoice`: "This epic therefore builds §4.6's queue and the three producers
 * > those criteria name."
 * >
 * > `ep-ledger-and-close`, feature 2: "The derived queue itself (`Producer`, `queue`, `act`,
 * > `attention_log`, UX §2's four tiers and the navigation count)."
 *
 * Each is aware the other needs it. Neither defers. Both passed, and both were RIGHT to
 * pass — the judge is asked whether this document conforms to its parent, and both do. The
 * defect exists only between them, and nothing was looking there.
 *
 * So this module reads the set. It re-derives nothing: `lintEpics` and `lintFeatureDocs` are
 * the coverage arithmetic and are called, not reimplemented — the one thing computed here
 * is which siblings share a criterion id, which is four lines over `delivers` and is the
 * question the existing lint answers as an advisory flag that no caller reads.
 */

export interface SetReview {
  level: NarrowingLevel;
  /**
   * WHICH set this is, because there are three and two of them are features.
   *
   * `epic-features` is one epic's children against that epic. `all-features` is every
   * feature in the program against every epic — a different question, and the one whose
   * absence let two epics' children collide unseen. See `reviewFeatureLevel`.
   */
  scope: "epics" | "epic-features" | "all-features";
  /** The epic a feature set belongs to. Absent for an epic set and for the level-wide review. */
  epicId?: string;
  /**
   * **Blocking.** The set is wrong in a way no further planning fixes, so the honest action
   * in an unattended loop is to stop and say why. Free to compute, which is what lets it
   * gate: the asymmetry this engine runs on everywhere.
   */
  problems: string[];
  /**
   * **Advisory.** Legal, or not decidable by arithmetic at all. Recorded for the operator
   * and never gating — including everything a paid judge reports, which is why the judge
   * cannot stall this rung no matter what it says.
   */
  advisory: string[];
  /** Ids reviewed, in store order, for the report. */
  members: string[];
  /**
   * Hash of the documents exactly as written — the idempotence key.
   *
   * Over `source` and not over `(id, delivers)`, because the collision above is PROSE. An
   * epic that silently takes over its sibling's work changes no id and no `delivers` list,
   * so a key built from those would call the set unchanged and skip the review that exists
   * to catch it.
   */
  hash: string;
}

/**
 * The shared half: a set is only reviewable once, whatever level it is.
 *
 * **The PARENT is in the key, and leaving it out was a real hole.** This hash decides two
 * things — whether the dispatch hook skips the review, and whether a report may be
 * downgraded — and both are wrong if it covers only the siblings. `reviewEpicSet`'s
 * arithmetic depends on the PRD's criteria and `reviewFeatureSet`'s on the parent epic, so
 * widening an epic's `delivers` without touching a single feature file introduces blocking
 * gaps the key could not see, and the loop goes on treating a stale report as a reviewed
 * set. External review, PR #82.
 *
 * What it does NOT cover, said rather than left to be discovered: the ARCH. An epic set's
 * parent is the PRD *and* the ARCH, and only the PRD reaches this function. An ARCH edit
 * that changes no criterion does not re-trigger the epic-set review.
 */
function hashOf(docs: readonly Narrowing[], parent: readonly string[]): string {
  const h = createHash("sha256");
  for (const d of [...docs].sort((a, b) => a.id.localeCompare(b.id))) h.update(d.id).update("\0").update(d.source).update("\0");
  h.update("--parent--\0");
  for (const p of parent) h.update(p).update("\0");
  return h.digest("hex").slice(0, 16);
}

/**
 * Criteria claimed by more than one sibling.
 *
 * **Blocking for an epic set, advisory for a feature set, and the asymmetry is the parent's
 * own law rather than a preference.** `lintFeatureDocs` states it: "Union, not per-feature:
 * splitting a criterion across two features is legal and normal" — a schema feature and the
 * screen that reads it can honestly share one criterion, provided they grade the whole of it
 * between them. Epics are the other case. An epic is a slice of the app, the slices are what
 * the program is cut into, and a criterion in two of them means two slices both own it: the
 * feature rung below will then narrow it twice and two implementers will build it.
 *
 * That rule is NEW here, and it is written down rather than assumed. Nothing before this
 * forbade overlap — `nextChainNeed` mints epics until every criterion is claimed and never
 * asks whether one is claimed twice.
 */
/**
 * Criteria more than one slice claims to DELIVER. Exported because it has two call sites
 * with one meaning: the set review (a complete level) and the mint gate (one new epic
 * against the ones that exist). Before PR #94's second review only the set review asked,
 * and a program whose scaffolds were all buildable could build, grade and finish without
 * the set review ever running — two epics building one criterion, reported done.
 */
export function sharedCriteria(siblings: readonly Narrowing[]): Map<string, string[]> {
  const claimed = new Map<string, string[]>();
  for (const s of siblings) for (const c of s.delivers) claimed.set(c, [...(claimed.get(c) ?? []), s.id]);
  return new Map([...claimed].filter(([, by]) => by.length > 1));
}

/**
 * The declared order, checked — the mechanical half that did not exist until `after:` did.
 *
 * Three things arithmetic can decide about a dependency graph and a judge reading prose
 * cannot: an edge to a document that is not in the set, an edge to itself, and a cycle.
 * All three are BLOCKING, because the chain schedules on this graph: an unresolvable one
 * is not a document to correct, it is a program that cannot be built in any order.
 *
 * `inServeOrder` deliberately does not resolve a cycle — it hands the tangle back and this
 * is where it is refused, with the members named.
 */
function edgeProblems(docs: readonly Narrowing[], level: string): string[] {
  return sharedEdgeProblems(docs, level);
}

/**
 * **An epic set against the program.**
 *
 * `existing` is every epic the store holds, and the review runs only when the level is
 * complete — which is `nextChainNeed` returning something other than `kind: "epic"`. A set
 * reviewed while it is still being minted reports the criteria its unwritten members were
 * going to take, which is the incomplete-set noise `mechanicalFindings` filters out one
 * rung up and must not be reintroduced here.
 */
export function reviewEpicSet(criteria: CriteriaParse, epics: readonly Narrowing[]): SetReview {
  const lint: ChainLint = lintEpics(criteria, epics);
  const problems = [...lint.problems];
  const advisory = [...lint.flags.filter((f) => !/ is covered by \d+ /.test(f))];

  problems.push(...edgeProblems(epics, "epic"));

  for (const [id, by] of sharedCriteria(epics)) {
    problems.push(
      `${id} is claimed by ${by.length} epics (${by.join(", ")}) — epics are the slices the program is cut into, so a criterion in two of them is narrowed twice and built twice`,
    );
  }

  // Criterion id AND text: the arithmetic turns on the ids, and the judge quotes the text,
  // so a criterion reworded under the same id changes what a faithful epic should say.
  const parent = criteria.criteria.map((c) => `${c.id} :: ${c.text}`);
  return { level: "epic", scope: "epics", problems, advisory, members: epics.map((e) => e.id), hash: hashOf(epics, parent) };
}

/**
 * **The worklist: artifacts more than one epic's features make an OWNERSHIP claim about.**
 *
 * The cross-epic review cannot work from a feature LIST — every collision measured so far
 * lives in prose and nowhere else. `ft-close-month`'s "This slice creates the
 * `categorisations` migration" is not in an id, a title or a `delivers` entry, and neither is
 * the `sync_log` double-write, the `ActResult` contradiction or the C1.4 hand-off. The
 * defect class *is* two documents saying incompatible things about a shared artifact, and
 * the artifact appears only in body text.
 *
 * Reading thirty documents in full is the other wrong answer: a judge that reads a subset
 * and rules on the whole returns a clean verdict on the half it happened to open.
 *
 * So the engine computes where to look and the judge reads around the hits. **What it looks
 * for is claim language, not mere mention, and that correction is the whole of this
 * function.** The first version ranked identifiers by rarity — on the assumption that a
 * specific shared artifact is named by few documents — and it put `categorisations`, the
 * collision that motivated this rung, at rank 199 behind `accountId` and `description`.
 * Rarity is backwards: an artifact two slices fight over is one that many slices discuss.
 *
 * A claim is a sentence that says who builds a thing — creates, owns, builds, lands, adds
 * the migration — or that says who does NOT, because a disclaimer pointing at a document
 * that never accepts is half of the same defect. An identifier carrying such a sentence in
 * two different epics is a candidate.
 *
 * This is a HINT and never a finding. It orders the judge's reading; it does not claim a
 * collision exists, and a useless hint costs one wasted grep. Nothing gates on it.
 */
const CLAIM = /\b(creates?|creating|owns?|builds?|lands?|writes the|adds the|belongs to|this slice|does not create|never creates|not this feature|is the sibling|assigned to|owner|owned by|is ours|is not ours)\b/i;

export function crossEpicCandidates(
  epics: readonly Narrowing[],
  features: readonly Narrowing[],
  limit = 30,
): Array<{ name: string; claimedBy: string[]; epics: string[] }> {
  const epicOf = new Map(features.map((f) => [f.id, f.parent ?? ""]));
  const claims = new Map<string, Set<string>>();

  for (const f of features) {
    // Sentence-ish: these documents are markdown prose and bullet lists, so a period or a
    // newline both end a claim. Splitting finer produces fragments with the verb in one
    // piece and the identifier in the next, which is how a real claim gets missed.
    for (const sentence of f.body.split(/(?<=[.:;])\s+|\r?\n/)) {
      if (!CLAIM.test(sentence)) continue;
      for (const m of sentence.matchAll(/`([^`\r\n]{3,60})`/g)) {
        const raw = m[1]!.trim().replace(/\(\)$/, "");
        if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(raw) || raw.length < 4) continue;
        if (!claims.has(raw)) claims.set(raw, new Set());
        claims.get(raw)!.add(f.id);
      }
    }
  }

  const out: Array<{ name: string; claimedBy: string[]; epics: string[] }> = [];
  for (const [name, fids] of claims) {
    const ids = [...fids].sort();
    const es = [...new Set(ids.map((id) => epicOf.get(id) ?? ""))].filter((e) => e.length > 0).sort();
    // Two epics at least: one epic's features are already read against each other by the
    // per-epic review, and repeating that here spends the judge's turn on settled ground.
    if (es.length < 2) continue;
    out.push({ name, claimedBy: ids, epics: es });
  }
  // Most contested first — the number of EPICS making a claim, then the number of features.
  out.sort((a, b) => b.epics.length - a.epics.length || b.claimedBy.length - a.claimedBy.length || a.name.localeCompare(b.name));
  void epics;
  return out.slice(0, limit);
}

/**
 * **Which sets are reviewable right now — one rule, and both callers read it.**
 *
 * The dispatch hook and the operator sweep each decided this for themselves, and they
 * disagreed: the hook waits for `nextChainNeed` to stop asking for a feature, which cannot
 * happen while any criterion is unclaimed, while the sweep asked only whether every EXISTING
 * epic had complete coverage. On a program still growing epics, that is true long before the
 * feature level is finished — so the sweep would buy a judge for a partial set, label the
 * report "every feature in the program", commit it, and have the next epic invalidate it.
 * External review, PR #83.
 *
 * That is the shape this repo keeps paying for: one rule written twice, and the copy nobody
 * checked is the one that ran. It is written once here.
 *
 * `completeOnly` is the whole of the rule. A set under review must be finished, because a
 * set reviewed mid-mint reports the work its unwritten members were going to do.
 */
export function reviewableSets(
  criteria: CriteriaParse,
  epics: readonly Narrowing[],
  features: readonly Narrowing[],
): Array<{ review: SetReview; docs: Narrowing[]; parents: Narrowing[]; parentIsProgram: boolean }> {
  const out: Array<{ review: SetReview; docs: Narrowing[]; parents: Narrowing[]; parentIsProgram: boolean }> = [];
  if (epics.length === 0) return out;

  // The epic level is complete when every PRD criterion has reached an epic — the same
  // question `nextChainNeed` answers by stopping at `kind: "epic"`.
  const claimed = new Set(epics.flatMap((e) => e.delivers));
  const epicSetComplete = criteria.criteria.every((c) => claimed.has(c.id));
  if (epicSetComplete) {
    out.push({ review: reviewEpicSet(criteria, epics), docs: [...epics], parents: [], parentIsProgram: true });
  }

  // There is no feature-set review, because there is no feature SET to review separately:
  // features are written with their epic, in the same document and the same ACT, so a
  // review of them is a review of that epic. What the old feature-set and feature-level
  // reviews checked between sibling DOCUMENTS — a criterion two of them both claim, an
  // ordering edge across epics — is now either inside one document, where `lintFeatures`
  // and `parseFeatures` decide it for free, or between epics, where `reviewEpicSet`
  // already looks.
  return out;
}
