/**
 * The dependency graph, over REQUIREMENTS rather than over documents (ADR-0004).
 *
 * A slice says `depends_on: [C1.1]` — *I cannot be built until C1.1 is satisfied* — and
 * never `depends_on: [some-other-slice]`. The reason is churn: document ids change every
 * time a slice is re-planned after a failed grade, which under ADR-0001 is the normal
 * case, so every edge pointing at one is left dangling or silently wrong. Requirement ids
 * do not move.
 *
 * **A dependency waits on `delivers` ∪ `renders`.** Coverage counts `delivers` alone —
 * the question there is *is the product built*, and displaying a criterion builds nothing.
 * Satisfaction asks the other question, *does the thing I am waiting on exist yet*, and a
 * slice waiting on a display is waiting on the renderer. One field pair, two readers,
 * deliberately disagreeing; `union` below is the one line to change if that turns out
 * wrong on the first live epic.
 *
 * Two things read this graph and they are not the same question:
 *
 *  - **`inDependencyOrder`** — a static PLANNING order. Which epic is narrowed first.
 *  - **`satisfied`** — a runtime BUILD fact. Which criteria are finished, so a unit
 *    waiting on one may enter the loop.
 */

/** Anything with an id that names criteria. Epics, features and units all qualify. */
export interface Slice {
  id: string;
  delivers: readonly string[];
  renders: readonly string[];
}

/** A slice that also waits on criteria. */
export interface Dependent extends Slice {
  dependsOn: readonly string[];
}

/** What a dependency waits on — see the header. */
const union = (s: Slice): string[] => [...s.delivers, ...s.renders];

/** Criterion id → the slices that name it. The index both readers below share. */
export function namedBy<T extends Slice>(slices: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const s of slices) for (const c of union(s)) out.set(c, [...(out.get(c) ?? []), s]);
  return out;
}

/**
 * The criteria that are finished: every slice naming one has landed.
 *
 * **Every, not any.** A criterion split across two slices — legal, and flagged as such by
 * the hop lint — is not satisfied when the first of them merges, and a dependent admitted
 * then is admitted against half of what it asked for. That is the same composition the
 * chain already paid for once at the feature rung, where "served" meant "some intent names
 * it" and the first batch of three finished a feature holding more.
 *
 * A criterion **no** slice names is absent from the result rather than vacuously true. It
 * is an unsatisfiable dependency, `problems` says so by name, and answering "satisfied"
 * here would let a dependent through on a requirement nothing is building.
 */
export function satisfied<T extends Slice>(slices: readonly T[], done: (s: T) => boolean): Set<string> {
  const out = new Set<string>();
  for (const [c, naming] of namedBy(slices)) if (naming.every(done)) out.add(c);
  return out;
}

/**
 * Planning order: every slice comes after the slices that name what it waits on.
 *
 * **A stable topological sort, and both halves matter.** Topological, because a slice
 * another waits on has to come first — building PRD §5 step 3 before step 0 is what this
 * exists to stop, and it is not hypothetical: `nextChainNeed` once walked epics in
 * `readdir` order, which is alphabetical, and three units merged against a table whose
 * slice had not been started (measured 2026-09-15). Stable, because among slices with no
 * edge between them the given order is kept, so adding one dependency re-orders exactly
 * what it names and nothing else.
 *
 * A CYCLE is not resolved here and must not be: the remaining slices are returned in the
 * given order rather than a winner being invented, and `problems` refuses the set with the
 * whole graph in hand. Picking silently would schedule a program whose own dependency
 * graph is impossible and report nothing.
 */
export function inDependencyOrder<T extends Dependent>(slices: readonly T[]): T[] {
  const index = namedBy(slices);
  const blockers = (s: T): Set<string> => {
    const ids = new Set<string>();
    for (const c of s.dependsOn) for (const other of index.get(c) ?? []) if (other.id !== s.id) ids.add(other.id);
    return ids;
  };
  const remaining = [...slices];
  const out: T[] = [];
  const done = new Set<string>();
  while (remaining.length > 0) {
    const i = remaining.findIndex((s) => [...blockers(s)].every((id) => done.has(id)));
    if (i === -1) {
      out.push(...remaining);
      break;
    }
    const [next] = remaining.splice(i, 1);
    out.push(next!);
    done.add(next!.id);
  }
  return out;
}

/**
 * What is wrong with the graph itself, as findings rather than as a thrown error.
 *
 * `label` names the level for the message — "epic", "feature of ep-x" — because the same
 * arithmetic serves every level and the reader needs to know which one it is reading.
 */
export function edgeProblems(slices: readonly Dependent[], label: string): string[] {
  const problems: string[] = [];
  const index = namedBy(slices);

  for (const s of slices) {
    for (const c of s.dependsOn) {
      if (union(s).includes(c)) {
        problems.push(`${s.id}: depends on ${c}, which it names itself — a slice cannot wait on its own work`);
        continue;
      }
      // An edge on a requirement nothing delivers or renders can never clear. Left
      // unchecked it reads as "not ready yet" forever, which is the quiet kind of stuck:
      // nothing red, nothing spent, nothing ever happening.
      if (!index.has(c)) {
        problems.push(`${s.id}: depends on ${c}, which no ${label} delivers or renders — an edge that can never clear`);
      }
    }
  }

  const ordered = inDependencyOrder(slices);
  const placed = new Set<string>();
  for (const s of ordered) {
    const waiting = new Set<string>();
    for (const c of s.dependsOn) for (const other of index.get(c) ?? []) if (other.id !== s.id) waiting.add(other.id);
    if ([...waiting].some((id) => !placed.has(id))) {
      problems.push(`the ${label} graph has a cycle among ${ordered.filter((x) => !placed.has(x.id)).map((x) => x.id).join(", ")}`);
      break;
    }
    placed.add(s.id);
  }
  return problems;
}

/** A slice a `depends_on` can resolve against, and whether its work is finished. */
export interface DependableSlice extends Dependent {
  done: boolean;
  kind: "epic" | "intent" | "unit";
}

/**
 * **Every slice a `depends_on` can resolve against — the ONE definition.**
 *
 * Three readers ask this question: admissibility (`satisfied`, rungs 1 and 1b), the epic
 * ACT's mint gate, and the ratchet's mint gate. They disagreed. Admissibility resolved
 * through the intents; both mint gates resolved through the units. Old units declare no
 * `delivers`, so the first post-cutover scaffold depending on a criterion the previous
 * ladder built would have been refused at mint as "an edge that can never clear" — even
 * with `satisfied` right. A rule written three times is a rule applied at one level and
 * not its siblings, so it is written once, here.
 *
 * What counts, and why each is shaped as it is:
 *
 * - **retired epics** (`status: done`), as done. They carry the coverage the previous
 *   ladder built and verified. An ACTIVE epic is not included at all: its doneness is
 *   computed from grades, not stored, and its criteria are named by its own units — so
 *   listing it here with `done: false` would hold every dependent on it unsatisfied for
 *   ever.
 * - **intents**, done when `done`. The in-flight ones are the reason this is a WIDENING of
 *   `satisfied` and not a re-pointing: a retired epic narrowed to what the old ladder
 *   planned names `C10.1` as done while the intent building it has not finished. "Every,
 *   not any" holds that criterion unsatisfied until the intent is done — which it can only
 *   do if the intent is in the set. When the intent dialect is deleted, this member drops
 *   out, and the retired epics alone carry what it built.
 * - **units**, done when `merged` — and an **escalated unit is not in the set at all.**
 *   A judge that escalates has ruled the unit unbuildable as specified, so its claim to
 *   deliver anything is void. Counted as a namer it did two kinds of damage (PR #96 review):
 *   under "every, not any" it held a criterion unsatisfied for ever, even after a
 *   replacement unit delivering it MERGED — freezing the ratchet's own recovery path,
 *   whose dependents were then neither admissible nor stranded — and it told a planner
 *   it may depend on a criterion nothing live would ever build. Excluded, a criterion only
 *   an escalated unit named is absent from the set, so it is unsatisfied (its dependents are
 *   stranded by `unsatisfiableUnits`), and it ENTERS the planner's list the moment a
 *   replacement is scaffolded — which is the change the gap-skip key has to see.
 */
export function dependableSlices(
  epics: readonly { id: string; status: string; delivers: readonly string[]; renders: readonly string[] }[],
  intents: readonly { id: string; status: string; delivers: readonly string[]; renders: readonly string[]; dependsOn: readonly string[] }[],
  units: readonly { id: string; status: string; delivers: readonly string[]; renders: readonly string[]; dependsOn: readonly string[] }[],
): DependableSlice[] {
  return [
    ...epics.filter((e) => e.status === "done").map((e) => ({
      id: e.id, delivers: e.delivers, renders: e.renders, dependsOn: [], done: true, kind: "epic" as const,
    })),
    ...intents.map((i) => ({
      id: i.id, delivers: i.delivers, renders: i.renders, dependsOn: i.dependsOn, done: i.status === "done", kind: "intent" as const,
    })),
    ...units.filter((u) => u.status !== "escalated").map((u) => ({
      id: u.id, delivers: u.delivers, renders: u.renders, dependsOn: u.dependsOn, done: u.status === "merged", kind: "unit" as const,
    })),
  ];
}
