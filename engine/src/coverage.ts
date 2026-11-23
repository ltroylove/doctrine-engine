import { edgeProblems, type Dependent } from "./depends.js";
import type { Intent } from "./intent.js";

/**
 * Anything that can account for a criterion: an intent, an epic, a feature.
 *
 * The coverage arithmetic never needed to know which — it reads an id and a `delivers`
 * list — and typing it to `Intent` meant the epic/feature rungs would have needed their
 * own copy of it. One implementation, three callers, no sibling to drift.
 */
export interface Covering {
  readonly id: string;
  readonly delivers: readonly string[];
}

/**
 * Program coverage (the scaffold rung): the one check in Doctrine that runs
 * PRD → intents rather than intent → PRD.
 *
 * Every existing gate is SOUNDNESS: the program-judge's "cite or fail" and "no
 * invented product", and the narrowing rung's "nothing is invented". They prove the loop
 * built nothing the program did not ask for. Not one of them proved the loop built
 * everything it did — the narrowing judge of the day disclaimed it in its own words
 * ("completeness is not the test"). The chain in `narrowing.ts` closed that at every hop;
 * this module is the arithmetic it closed it WITH.
 *
 * **Scope: the PRD's §4 success criteria, and nothing else.** Measured on a target:
 * of 182 acceptance entries, 47 grade a §4 criterion, 49 are the three
 * standing manifest gates carried on every intent, and 86 cite the ARCH, its pinned
 * decisions or `contracts.md`. The last group needs no ids of its own — it is covered
 * transitively, since a criterion's acceptance passing is what proves the structure
 * underneath it works. §4 is where *done* is defined; coverage of done is the property
 * worth gating. See `docs/design.md`, "What the gate covers, and what it does not".
 *
 * That gap cannot be closed by execution, which is why cutting it with the rest of
 * the doc-validates-doc pipeline was over-broad. An
 * intent-grade proves you built what you wrote down; nothing anywhere can run to
 * discover a requirement that reached no intent. Completeness is a property of the
 * SET of intents against the PRD, and a set property is checkable exactly once, on
 * paper, before anything is built.
 *
 * So this module is deliberately pure and LLM-free: it parses the PRD's criterion
 * ids, reads what the scaffolded intents claim to cover, and answers three questions
 * by arithmetic — is anything uncovered, is anything covered that the PRD does not
 * contain, and is the program done. Nothing here judges MEANING. An intent that
 * claims `C4.2` and has nothing to do with it is the program-judge's problem; this
 * module only ever reports what the artifacts say.
 */

export type CriterionKind = "machine" | "draft";

export interface Criterion {
  /** Stable identifier, e.g. "C4.2". */
  id: string;
  kind: CriterionKind;
  /** The capability heading this criterion sits under, e.g. "C4". */
  capability: string;
  /** The criterion's prose, for error messages that a human can act on. */
  text: string;
}

/**
 * The bullet shape the PRD must use. The id follows the kind marker, in backticks:
 *
 *     - **machine** `C1.1` Given fixture statements for one account and one month...
 *
 * Chosen over "id anywhere in the line" on purpose. A tolerant parser here is the
 * same failure as an acceptance list where nothing fails: it silently shrinks the
 * denominator, and a coverage gate measuring half a PRD reports green while missing
 * exactly the requirements nobody bothered to label.
 */
const CRITERION = /^[-*]\s+\*\*(machine|draft)\*\*\s+`(C\d+\.\d+)`\s*(.*)$/;

/** A criterion bullet that carries no id — counted, never skipped. See `parseCriteria`. */
const UNLABELLED = /^[-*]\s+\*\*(machine|draft)\*\*\s+(?!`C\d+\.\d+`)(.*)$/;

const CAPABILITY_HEADING = /^#{2,4}\s+(C\d+)\./;

export interface CriteriaParse {
  criteria: Criterion[];
  /**
   * Criterion bullets with no id, as `<capability>: <first 60 chars>`. NOT a warning:
   * any entry here makes `lintCoverage` fail, because an unlabelled criterion is one
   * the coverage arithmetic cannot see, and a gate that cannot see a requirement
   * reports green for it forever.
   */
  unlabelled: string[];
  /** Ids used by more than one bullet — the PRD contradicting itself about what an id names. */
  duplicateIds: string[];
}

/**
 * Read the PRD's success criteria. Capability headings (`### C4. Materials`) scope the
 * bullets beneath them; a criterion whose id disagrees with its heading is reported by
 * `lintCoverage` rather than silently re-homed, because the disagreement is the finding.
 */
export function parseCriteria(prd: string): CriteriaParse {
  const criteria: Criterion[] = [];
  const unlabelled: string[] = [];
  const seen = new Map<string, number>();
  let capability = "";

  for (const line of prd.split(/\r?\n/)) {
    const heading = CAPABILITY_HEADING.exec(line);
    if (heading) {
      capability = heading[1]!;
      continue;
    }
    const m = CRITERION.exec(line);
    if (m) {
      const id = m[2]!;
      seen.set(id, (seen.get(id) ?? 0) + 1);
      criteria.push({ id, kind: m[1] as CriterionKind, capability, text: m[3]!.trim() });
      continue;
    }
    const u = UNLABELLED.exec(line);
    if (u) unlabelled.push(`${capability || "(no capability heading)"}: ${u[2]!.trim().slice(0, 60)}`);
  }

  return {
    criteria,
    unlabelled,
    duplicateIds: [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id).sort(),
  };
}

export interface CoverageLint {
  ok: boolean;
  problems: string[];
  /** Non-blocking observations for the observer. */
  flags: string[];
}

/**
 * Does the intent set account for the PRD?
 *
 * Blocking, in both directions:
 *  - **uncovered** — a criterion no intent claims. The failure the whole rung exists
 *    for, and the one nothing else in Doctrine can see.
 *  - **invented** — an intent claiming an id the PRD does not contain. The mirror, and
 *    it matters because without it "covered" is trivially satisfiable by typing ids.
 *  - **unlabelled / duplicated** — the PRD itself is not in a state the arithmetic can
 *    read. Fails rather than warns, per `CriteriaParse.unlabelled`.
 *
 * **What "delivers" means, and it is a UNION rule.** An intent belongs in a criterion's
 * cover set when its acceptance grades part of that criterion, and the criterion is
 * honestly covered when the intents covering it grade the WHOLE of it between them.
 * Splitting is legal and normal: on one target, `invoice-push-paid` grades the first
 * half of C5.4 ("payment status updates the invoice to `paid`") and `attention-queue`
 * grades the second ("an unpaid invoice past terms produces an Attention item"), and
 * together they are complete.
 *
 * What is NOT legal is a cover set whose union leaves part of the criterion ungraded,
 * because `programProgress` settles a criterion once every covering intent is `done` —
 * so a partial claim on a finished intent reports the missing part as built. External
 * review caught five of these in one target's backfill, each
 * provable from the covering intent's own words: C1.4 spans "Close, Jobs and Billing"
 * and the Close intent says "Jobs has no screen"; C5.1 names a materials column the
 * skeleton says "is not graded here because C4 has not run"; C10.1 requires an ordered
 * sync the invoice intent deliberately asserted as a *subsequence* because the payroll
 * step is not built; C11.3 requires accuracy "at or above the bar set at calibration"
 * and the bar has never been measured.
 *
 * This cannot be checked mechanically — it needs the criterion's clauses read against
 * the evidence — which is exactly why it belongs to the program-judge and is written
 * here as the contract that judge enforces. The arithmetic below assumes it.
 *
 * `draft` criteria count toward coverage exactly like `machine` ones. A criterion
 * without a machine check is still a requirement; it is the intent's acceptance that
 * may not be able to grade it, which the program rung already handles by leaving such an
 * entry visibly draft on the intent. Dropping them here would quietly redefine
 * "the program" as "the testable part of the program".
 */
/**
 * `label` is what the things being counted ARE — "epic", "unit". It exists because every
 * message here said "intent", at every level, long after ADR-0002 deleted that rung: an
 * operator reading why the chain is stuck was told 38 criteria were "covered by no intent"
 * when what was owed was an EPIC, and the scaffold gate reported "duplicate intent id
 * wu-import" about a unit. Same shape as `edgeProblems`, which already takes one.
 */
export function lintCoverage(parse: CriteriaParse, slices: readonly Covering[], label = "slice"): CoverageLint {
  const problems: string[] = [];
  const flags: string[] = [];

  for (const u of parse.unlabelled) {
    problems.push(`PRD criterion carries no id, so no ${label} can cover it — ${u}`);
  }
  for (const id of parse.duplicateIds) {
    problems.push(`PRD uses the criterion id ${id} more than once — an id must name one requirement`);
  }

  // The agreement `parseCriteria` promises to report rather than silently re-home.
  // It matters most during a manual id migration, which is the only time criteria are
  // typed by hand under headings they may not belong to: a `C2.1` that drifts under
  // `### C1.` is claimable, coverable, and wrong about which capability it belongs to,
  // and every downstream message would then name the wrong one.
  for (const c of parse.criteria) {
    const prefix = c.id.slice(0, c.id.indexOf("."));
    if (c.capability !== "" && prefix !== c.capability) {
      problems.push(`${c.id} sits under the ${c.capability} heading — a criterion id must match the capability it is written under`);
    }
  }

  const known = new Map(parse.criteria.map((c) => [c.id, c]));
  const claimed = new Map<string, string[]>();
  for (const slice of slices) {
    for (const id of slice.delivers) {
      if (!known.has(id)) {
        problems.push(`${slice.id} claims to cover ${id}, which is not a criterion in the PRD`);
        continue;
      }
      claimed.set(id, [...(claimed.get(id) ?? []), slice.id]);
    }
  }

  for (const c of parse.criteria) {
    const by = claimed.get(c.id);
    if (by === undefined || by.length === 0) {
      problems.push(`${c.id} (${c.capability}, ${c.kind}) is covered by no ${label} — "${c.text.slice(0, 70)}"`);
    } else if (by.length > 1) {
      // Legal: two intents can honestly share one criterion (a schema intent and the
      // screen that reads it). Surfaced because it is also what splitting a criterion
      // that should have been two looks like.
      flags.push(`${c.id} is covered by ${by.length} ${label}s (${by.join(", ")})`);
    }
  }

  for (const id of structuralIntents(slices)) {
    // Not a problem — a signal. See `structuralIntents`.
    flags.push(`${id} delivers no criterion: it grades structure only. Which criterion would fail if it were deleted? "None" is a defect report against the PRD`);
  }

  if (parse.criteria.length === 0) {
    problems.push("the PRD declares no identified criteria — coverage over an empty set is not coverage");
  }

  return { ok: problems.length === 0, problems, flags };
}

export interface ProgramProgress {
  /** Criteria the loop can actually verify. `done` counts only these. */
  machineTotal: number;
  machineDone: number;
  /** Machine criterion ids whose covering intents have not all reached `done`. */
  outstanding: string[];
  /**
   * Every `draft` criterion, always — regardless of whether its covering intent
   * landed. See `programProgress`: nothing verified these, so nothing may report
   * them satisfied.
   */
  unverifiable: string[];
  /** True when every MACHINE criterion is done. Draft criteria never gate. */
  done: boolean;
}

/**
 * Program-level done, computed from artifacts rather than claimed by an agent.
 *
 * This replaces an LLM writing "every rung is built", checked by a second LLM reading
 * the ladder. A criterion is done when EVERY intent covering it is `done`: a criterion
 * two intents share is not satisfied by the easier one landing.
 *
 * **NOT WIRED YET, and saying so is the point.** Nothing in the tick calls this. The
 * chain's `complete` arm means every criterion reaches a feature and every feature has
 * intents — which is a statement about PLANNING, not about work being finished. Program
 * done is this function returning `done: true`, and the rung that should ask it does not
 * exist. Recorded here rather than left for someone to assume from the fact that the
 * function exists: a tested function with no caller is a claim about a design, and this
 * one is a claim about a design that is not built.
 *
 * **It takes a `landed` PREDICATE rather than reading a status, and that is not
 * indirection for its own sake.** `Intent` is `WorkUnit` now, and its caller is the epic
 * grade — so this would otherwise be typed to the thing it is NOT given, and the string
 * `"done"` means one thing in the unit dialect, another in an intent's, and a third on a
 * narrowing, where it is the only terminal status there is. Three vocabularies reaching
 * one comparison is how a check gets written for one level and silently mis-answers for
 * its sibling. `satisfied` in `depends.ts` takes the same predicate for the same reason;
 * a rule stated twice in two shapes is a rule applied once.
 *
 * **A `draft` criterion is never done, and that asymmetry with `lintCoverage` is
 * deliberate.** Coverage counts draft criteria because a requirement without a machine
 * check is still a requirement and must reach an intent. Completion cannot count them,
 * because an intent reaches `done` when its ACCEPTANCE passes, and a draft criterion is
 * by definition one no acceptance entry grades — so it would flip to done having been
 * verified by nothing. That is "an acceptance list where nothing fails grades nothing"
 * reappearing one rung up, inside the gate built to prevent exactly this. Such criteria
 * are to be "surfaced to the observer, never silently dropped, never
 * blocking"; `unverifiable` is that surface, and it is satisfied by listing them rather
 * than by counting them.
 */
export function programProgress<T extends Covering>(
  parse: CriteriaParse,
  slices: readonly T[],
  landed: (s: T) => boolean,
): ProgramProgress {
  const byId = new Map<string, T[]>();
  for (const slice of slices) {
    for (const id of slice.delivers) byId.set(id, [...(byId.get(id) ?? []), slice]);
  }
  const outstanding: string[] = [];
  const unverifiable: string[] = [];
  let machineTotal = 0;
  for (const c of parse.criteria) {
    if (c.kind === "draft") {
      unverifiable.push(c.id);
      continue;
    }
    machineTotal += 1;
    const covering = byId.get(c.id) ?? [];
    if (covering.length === 0 || !covering.every(landed)) outstanding.push(c.id);
  }
  return {
    machineTotal,
    machineDone: machineTotal - outstanding.length,
    outstanding,
    unverifiable,
    done: outstanding.length === 0 && machineTotal > 0,
  };
}

export interface ScaffoldLint {
  ok: boolean;
  problems: string[];
  flags: string[];
}

/**
 * The gate on a newly minted scaffold: coverage in both directions, plus the shape of
 * the dependency graph the scaffold exists to carry.
 *
 * Mechanical and LLM-free, exactly like `lintPlan` one rung below. The program-judge
 * still runs after this and still asks whether each intent MEANS what it claims; this
 * asks only whether the set is arithmetically sound, which is the half a judge reading
 * prose is worst at and code is best at.
 */
export function lintScaffold(
  parse: CriteriaParse,
  minted: readonly Intent[],
  opts: { elsewhere?: readonly Intent[]; scope?: readonly string[]; dependable?: readonly Dependent[] } = {},
): ScaffoldLint {
  const elsewhere = opts.elsewhere ?? [];
  // **What this scaffold is answerable FOR.** Under ADR-0006 the epic ACT scaffolds its own
  // units, so the set is one epic's and the coverage question is "every criterion THIS EPIC
  // delivers reaches one of its units" — the epic's `Delivers`, passed in as `scope`. Asked
  // against the whole PRD it would fail every epic for the criteria the other epics own;
  // answered by another epic's units it would be unfailable. `lintEpics` asks the other
  // half, that every PRD criterion reaches an epic, and the whole-program question is the
  // composition of the two.
  //
  // Defaulting to the whole PRD keeps the one-shot whole-program call meaningful, which is
  // what this was before ADR-0006 and what a single-epic program still is.
  const scoped: CriteriaParse = opts.scope === undefined
    ? parse
    : { ...parse, criteria: parse.criteria.filter((c) => opts.scope!.includes(c.id)) };

  const coverage = lintCoverage(scoped, minted, "unit");
  const problems = [...coverage.problems];
  const flags = [...coverage.flags];

  // Seeded with what is already scaffolded, so a minted id colliding with an EXISTING one
  // is caught. Re-minting an id is the most expensive failure available at this rung and
  // the easiest to correct — and per-epic minting is what makes it possible at all, since
  // a whole-program scaffold had nothing to collide with.
  const seen = new Set(elsewhere.map((i) => i.id));
  for (const i of minted) {
    if (seen.has(i.id)) problems.push(`duplicate unit id ${i.id}`);
    seen.add(i.id);
    // Every member must actually BE a scaffold, or the gate is bypassable by writing the
    // wrong status. The parser requires acceptance only for `ready` and `decomposed`, so an
    // ACT emitting `status: done` produces a slice with no acceptance that parses cleanly,
    // satisfies coverage, and is counted COMPLETE by `programProgress` on the spot — the
    // whole program graded by nothing, through the one gate built to prevent exactly that.
    if (i.status !== "scaffold") {
      problems.push(`${i.id} has status "${i.status}" — every unit in a newly minted scaffold must be "scaffold"`);
    }
  }

  // The dependency graph, through the ONE implementation that owns it. The three checks
  // this spelled out by hand are all `edgeProblems`: a self-edge, an edge on something
  // nothing delivers, and a cycle. They were written against DOCUMENT ids, and every level
  // has since moved to criterion ids — so `depends_on: [C1.1]`, written exactly as ADR-0004
  // requires, was refused as unresolvable by the whole-program mint gate.
  //
  // **Open-world, which is what ADR-0006 costs.** The set being minted is one epic's units,
  // so a unit here legitimately waits on a criterion an earlier epic delivers. Handed only
  // the new ones, `edgeProblems` would report edges that CAN clear as edges that never can
  // — the quiet kind of stuck, inside the gate built to prevent it.
  //
  // Filtered to problems naming a minted slice. A pre-existing defect among slices this ACT
  // did not write is not this ACT's to fail on: it would refuse a correct epic for something
  // it cannot see, and the ACT would revert, re-run and refuse again until the failure halt
  // tripped — spend, with nothing it could have done differently.
  const mine = minted.map((i) => i.id);
  // `dependable` is `dependableSlices` — the ONE definition of what an edge can resolve
  // against, shared with admissibility. Without it this saw units only, and old units
  // declare no `delivers`, so an edge on a criterion the previous ladder built read as one
  // that can never clear. Deduplicated by id: a unit is in both `elsewhere` and here, and
  // counting it twice is how a graph walk invents a cycle.
  const graph = new Map<string, Dependent>();
  for (const s of [...(opts.dependable ?? []), ...elsewhere, ...minted]) graph.set(s.id, s);
  problems.push(...edgeProblems([...graph.values()], "scaffold").filter((c) => mine.some((id) => c.includes(id))));

  return { ok: problems.length === 0, problems, flags };
}


/**
 * Intents whose evidence is entirely structural — they grade the architecture and no
 * PRD success criterion.
 *
 * Reported, never blocked, and the distinction is the whole point. Blocking forces the
 * planner to attach a criterion it does not grade, which is coverage typed into
 * existence. Staying silent makes this the bloat hatch — the direction upfront
 * decomposition is supposed to close, opposite to the one `lintCoverage` closes.
 *
 * **An empty `delivers` is never "necessary work that advances nothing."** That sentence
 * is a contradiction: necessary work is necessary FOR something, and that something is
 * either in the program or it is not. So it always resolves to exactly one of two
 * findings, both actionable:
 *
 *  1. **The ledger under-indexes the PRD.** The requirement is real and stated outside
 *     §4 — one target's `harness` intent builds, item by item, the "Test runner,
 *     fixture layout, QBO sandbox wiring, the AI seam stub and the labeled fixture
 *     ledger" that PRD §5 step 0 names. It advances the PRD; the arithmetic reads §4.
 *  2. **The PRD under-specifies.** The work is presupposed by prose no criterion tests.
 *     One target's `chart-of-accounts` builds `qbo_accounts` because C2's preamble says
 *     "Every transaction gets a QBO account category" — and no criterion would fail if
 *     the table vanished, because C2.1 only asks that a transaction "receives its
 *     approved category", which free integers satisfy. That intent's own acceptance
 *     proves it: it grades that `qbo_accounts` stays OUT of C10.1's sync step list.
 *
 * The test that separates them is falsifiable, which is why it is worth writing down:
 * **which criterion would fail if this work were deleted?** "None" is a defect report
 * against the PRD, and `docs/program/**` is the operator's document, so the loop
 * reports it and mints against the program as it stands.
 */
export function structuralIntents(intents: readonly Covering[]): string[] {
  return intents.filter((i) => i.delivers.length === 0).map((i) => i.id);
}
