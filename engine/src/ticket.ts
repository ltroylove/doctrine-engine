import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CriteriaParse } from "./coverage.js";
import type { Narrowing } from "./narrowing.js";
import { parseFrontmatter, parseStringList } from "./envelope.js";
import { TIERS, type Tier } from "./work-unit.js";

/**
 * A ticket: one request, living in a GitHub issue.
 *
 * **The issue exists first, and that is what makes tickets different from everything
 * else on this ladder.** `envelope.ts` decided ids are slugs and never issue numbers,
 * because "a document cannot name its own parent until the parent exists there." A
 * ticket's origin IS the tracker — a person, an agent, or the loop's own deferred
 * findings open an issue, and triage fills it in. So `M-<issue#>` does not violate that
 * reasoning; it sits outside it, and tickets are the first artifact where the number is
 * authoritative rather than derived.
 *
 * **A ticket is an ORIGIN, not a parent.** This is the decision the rest of the design
 * hangs on. An intent born from a ticket still carries `parent: <feature>` and is still
 * checked against that feature in both directions — it records the ticket in a separate
 * `origin:` field. Parenting an intent to a ticket instead was the obvious move and it
 * was wrong: it would let a ticket introduce work no feature carries, which is exactly
 * the hole this ladder exists to close. `lintChildren` refuses `delivers` outside the
 * feature's set, so a ticket that wants something its feature does not have cannot
 * smuggle it in — the feature has to grow first, which is what `growth` below is for.
 */

/**
 * Repair or growth — and triage's FIRST question, because the two go to different places.
 *
 * A repair is about behaviour the PRD already states: find the criterion, find the
 * feature covering it, attach. Nothing above the intent changes.
 *
 * Growth is about behaviour the PRD does not state yet. The criterion comes first, then
 * possibly a feature, then possibly an epic — the narrowing chain run in reverse, with
 * every hop still owing its both-ways check.
 */
export const TICKET_KINDS = ["repair", "growth"] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

/**
 * The four repair shapes, plus growth.
 *
 * `growth` is a kind AND a type on purpose: every other type is a repair, so the type
 * alone would leave "is this growth" to be re-derived by everything that reads a ticket.
 * `lintTicket` holds them to agreement rather than letting them drift.
 */
export const TICKET_TYPES = ["bug", "debt", "security", "perf", "growth"] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

/** Where the work attaches, or what has to be created before it can. */
export type TicketHome =
  | { kind: "existing"; feature: string }
  | { kind: "new-feature"; epic: string }
  | { kind: "new-epic" };

/**
 * A criterion triage DRAFTS for the PRD, on a growth ticket.
 *
 * Drafted, never applied: no ACT in this engine can write `docs/program/**`, and the PRD
 * is a program input nobody in the loop authors at all. That is the line between "the
 * loop builds the app" and "the loop decides what the app is", and it is why approving a
 * growth ticket is a different decision from approving a repair — it means accepting a
 * PRD change. The operator edits the wording at approval; triage's job is to make that
 * an edit rather than a blank page.
 */
export interface DraftedCriterion {
  id: string;
  /** `machine` if the criterion can be graded by a command; `draft` if it cannot yet. */
  kind: "machine" | "draft";
  text: string;
}

export interface Ticket {
  /** `M-<issue#>`, not zero-padded. */
  id: string;
  number: number;
  title: string;
  kind: TicketKind;
  type: TicketType;
  /**
   * Reversibility, and this repo's existing rubric rather than a second one.
   *
   * `TIERS` and its rule are locked: irreversible changes get design rigor,
   * reversible ones get built and evaluated. A ticket classification of
   * auto/manual/excluded would be that rule stated twice — the shape this engine has
   * paid for seven times — so `irreversible` IS "not for the unattended queue", and
   * `lintPlan` already surfaces irreversible children to the observer.
   */
  tier: Tier;
  /** REPAIR: the PRD criteria this repairs. Empty on a growth ticket. */
  delivers: string[];
  /** GROWTH: the criteria the PRD is missing. Empty on a repair ticket. */
  proposes: DraftedCriterion[];
  home: TicketHome;
  /** Repo-relative paths the fix touches. Every one must resolve — see `lintTicket`. */
  files: string[];
  /** Repo-relative paths that show the correct pattern for this kind of fix. */
  references: string[];
  /** One line per intent triage thinks this needs. See the sizing rule in `lintTicket`. */
  intents: string[];
  body: string;
  /** Where it was read from — an issue URL. Used in messages, never parsed. */
  source: string;
}

export type TicketParse = { ok: true; ticket: Ticket } | { ok: false; errors: string[] };

const HOME_NEW_EPIC = "new-epic";

/**
 * Read a triaged ticket out of an issue body.
 *
 * The body carries a frontmatter block, the same shape every other artifact here uses,
 * so one parser reads a file today and an issue body tomorrow — `parseFrontmatter` takes
 * a string and a label it only puts in messages.
 */
export function parseTicket(markdown: string, number: number, where: string): TicketParse {
  const { frontmatter: fm, body, errors } = parseFrontmatter(markdown, where);
  const id = `M-${number}`;

  const title = typeof fm["title"] === "string" ? fm["title"].trim() : "";
  if (title.length === 0) errors.push(`${where}: title is required`);

  const kind = fm["kind"];
  if (!TICKET_KINDS.includes(kind as TicketKind)) {
    errors.push(`${where}: kind must be one of: ${TICKET_KINDS.join(", ")}`);
  }
  const type = fm["type"];
  if (!TICKET_TYPES.includes(type as TicketType)) {
    errors.push(`${where}: type must be one of: ${TICKET_TYPES.join(", ")}`);
  }
  const tier = fm["tier"];
  if (!TIERS.includes(tier as Tier)) {
    errors.push(`${where}: tier must be one of: ${TIERS.join(", ")}`);
  }

  // `kind` and `type` say the same thing about growth, and disagreement is a real
  // finding rather than something to reconcile silently: it means triage classified the
  // ticket one way and described it another, and every reader downstream would pick
  // whichever field it happens to consult.
  if (kind === "growth" && type !== "growth") {
    errors.push(`${where}: kind is "growth" but type is "${String(type)}" — growth is both, or neither`);
  }
  if (type === "growth" && kind !== "growth") {
    errors.push(`${where}: type is "growth" but kind is "${String(kind)}" — growth is both, or neither`);
  }

  const home = parseHome(fm["home"], where, errors);

  // Parse EVERY field before deciding, and the order is the bug this avoids rather than
  // a style. The first version read the lists inside the object literal it was returning,
  // so `errors.length > 0` was evaluated before `parseStringList` had pushed anything into
  // it: a malformed `delivers:` was collected into an array nobody read and the ticket came
  // back `ok: true`. A parser that reports into a value it has already branched on is not
  // reporting.
  const delivers = parseStringList(fm["delivers"], "delivers", errors);
  const proposes = parseProposes(fm["proposes"], where, errors);
  const files = parseStringList(fm["files"], "files", errors);
  const references = parseStringList(fm["references"], "references", errors);
  const intents = parseStringList(fm["intents"], "intents", errors);

  if (errors.length > 0 || home === undefined) return { ok: false, errors };
  return {
    ok: true,
    ticket: {
      id, number, title,
      kind: kind as TicketKind,
      type: type as TicketType,
      tier: tier as Tier,
      delivers, proposes, home, files, references, intents,
      body,
      source: where,
    },
  };
}

/**
 * `home: ft-x` | `home: new-feature under ep-x` | `home: new-epic`.
 *
 * Prose rather than a nested mapping because a person reads this in an issue body and
 * edits it at approval. The three shapes are exactly the three answers triage can give.
 */
function parseHome(raw: unknown, where: string, errors: string[]): TicketHome | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    errors.push(`${where}: home is required — a feature id, "new-feature under <epic>", or "${HOME_NEW_EPIC}"`);
    return undefined;
  }
  const value = raw.trim();
  if (value === HOME_NEW_EPIC) return { kind: "new-epic" };
  const m = /^new-feature\s+under\s+(\S+)$/.exec(value);
  if (m) return { kind: "new-feature", epic: m[1]! };
  if (/^\S+$/.test(value)) return { kind: "existing", feature: value };
  errors.push(`${where}: home "${value}" is not a feature id, "new-feature under <epic>", or "${HOME_NEW_EPIC}"`);
  return undefined;
}

/** `proposes:` entries as `C4.1 | machine | the text`. */
function parseProposes(raw: unknown, where: string, errors: string[]): DraftedCriterion[] {
  const out: DraftedCriterion[] = [];
  for (const entry of parseStringList(raw, "proposes", errors)) {
    const parts = entry.split("|").map((p) => p.trim());
    if (parts.length < 3 || parts[0]!.length === 0 || parts[2]!.length === 0) {
      errors.push(`${where}: proposed criterion "${entry}" must read "<id> | machine|draft | <text>"`);
      continue;
    }
    if (parts[1] !== "machine" && parts[1] !== "draft") {
      errors.push(`${where}: proposed criterion "${parts[0]}" has kind "${parts[1]}" — must be machine or draft`);
      continue;
    }
    out.push({ id: parts[0]!, kind: parts[1], text: parts.slice(2).join(" | ") });
  }
  return out;
}

/**
 * How many intents a ticket may sketch before it stops being a ticket.
 *
 * The same number the program rung already uses, and for the same reason: a plan that
 * runs to the end is fiction. Past it, the artifact is behaving like a FEATURE — it is a
 * slice of an epic, not a unit of work — and the honest output of triage is to say so,
 * rather than quietly minting six intents against a request nobody sized.
 */
export const MAX_TICKET_INTENTS = 3;

/** Text that means triage left a hole. Any of it is a finding. */
const PLACEHOLDERS: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /<[a-z][a-z0-9 _/.-]*>/i, what: "an angle-bracket placeholder" },
  { pattern: /\bM-XXX\b/, what: "the template's placeholder id" },
  { pattern: /\bYYYY-MM-DD\b/, what: "the template's placeholder date" },
  { pattern: /\bTBD\b|\bTODO\b/, what: "a TBD/TODO" },
];

export interface TicketContext {
  /** Repository root, for checking that every path named actually resolves. */
  arenaDir: string;
  criteria: CriteriaParse;
  epics: readonly Narrowing[];
  features: readonly Narrowing[];
}

/**
 * Everything the engine can decide about a triaged ticket for FREE.
 *
 * **This is the half that makes a ticket agent-executable rather than a wish**, and it is
 * mechanical on purpose. The obvious alternative is a checklist in the triage law — every
 * path real, no placeholder text, criteria that exist — which the agent then attests to
 * having followed. This engine's rule is the opposite: trust artifacts, never claims. A
 * self-attested checklist is a claim.
 *
 * So the judge never spends a turn on any of this, and none of it can be got wrong
 * quietly.
 */
export function lintTicket(ticket: Ticket, ctx: TicketContext): string[] {
  const problems: string[] = [];
  const ids = new Set(ctx.criteria.criteria.map((c) => c.id));

  // --- no holes left anywhere a person or a planner will read ---
  //
  // The body AND the fields. Scanning only the body left `intents: [TODO]`, a title that
  // is still a placeholder, and a proposed criterion reading "TBD" all passing the gate
  // and being published — and the judge's law says explicitly that placeholders were
  // already checked and must not be re-litigated, so nothing downstream would have looked
  // again before a person approved it.
  const authored = [
    ticket.title,
    ticket.body,
    ...ticket.delivers,
    ...ticket.files,
    ...ticket.references,
    ...ticket.intents,
    ...ticket.proposes.flatMap((p) => [p.id, p.text]),
    ticket.home.kind === "existing" ? ticket.home.feature : ticket.home.kind === "new-feature" ? ticket.home.epic : "",
  ].join(String.fromCharCode(10));
  for (const { pattern, what } of PLACEHOLDERS) {
    const m = pattern.exec(authored);
    if (m) problems.push(`the ticket still contains ${what}: "${m[0]}" — triage discovers, it does not template`);
  }

  // --- every path names something that exists ---
  //
  // A ticket may not carry placeholder paths, and this is what enforces it. A ticket
  // whose files do not resolve sends an implementer looking for code that is not there,
  // and it fails on the harness rather than on the work.
  for (const f of ticket.files) {
    if (!existsSync(join(ctx.arenaDir, f))) problems.push(`files: "${f}" does not exist in the repository`);
  }
  for (const f of ticket.references) {
    if (!existsSync(join(ctx.arenaDir, f))) problems.push(`references: "${f}" does not exist in the repository`);
  }
  if (ticket.files.length === 0) {
    problems.push("files is empty — a ticket that names no file has not been scanned against the codebase");
  }

  // --- repair and growth are checked against opposite things ---
  if (ticket.kind === "repair") {
    if (ticket.proposes.length > 0) {
      problems.push(`a repair proposes no new criteria, and this one proposes ${ticket.proposes.length} — if the PRD is missing something, the ticket is growth`);
    }
    if (ticket.delivers.length === 0) {
      problems.push("a repair must name the PRD criteria it repairs — if none applies, the behaviour is not in the PRD and this is growth");
    }
    for (const c of ticket.delivers) {
      if (!ids.has(c)) problems.push(`delivers ${c}, which the PRD does not have — a repair repairs something already stated`);
    }
  } else {
    if (ticket.delivers.length > 0) {
      problems.push(`growth delivers nothing yet: ${ticket.delivers.join(", ")} — the criteria do not exist until the PRD carries them`);
    }
    if (ticket.proposes.length === 0) {
      problems.push("growth must draft the criteria the PRD is missing — that draft is what the operator edits at approval");
    }
    for (const p of ticket.proposes) {
      if (ids.has(p.id)) {
        problems.push(`proposes ${p.id}, which the PRD already has — a proposed criterion is a NEW one, and reusing an id silently rewrites an existing requirement`);
      }
    }
  }

  // --- the home has to be somewhere, and for a repair it has to be the RIGHT somewhere ---
  if (ticket.home.kind === "existing") {
    const wanted = ticket.home.feature;
    const feature = ctx.features.find((f) => f.id === wanted);
    if (feature === undefined) {
      problems.push(`home names feature "${wanted}", which does not exist`);
    } else if (ticket.kind === "repair") {
      // The constraint that keeps a ticket from smuggling scope in. `lintChildren`
      // refuses an intent covering what its feature does not, so a repair attached to a
      // feature that does not carry its criteria produces intents nothing can admit.
      for (const c of ticket.delivers) {
        if (!feature.delivers.includes(c)) {
          problems.push(`delivers ${c} but feature ${feature.id} does not — either this belongs to a different feature, or that feature has to grow first`);
        }
      }
    }
  } else if (ticket.home.kind === "new-feature") {
    const epic = ticket.home.epic;
    if (!ctx.epics.some((e) => e.id === epic)) {
      problems.push(`home puts a new feature under epic "${epic}", which does not exist`);
    }
  }

  // A repair never creates structure: the behaviour is already in the PRD, so something
  // already delivers it. Needing a new feature or epic means the PRD does not state this,
  // which makes it growth however much it feels like a bug.
  if (ticket.kind === "repair" && ticket.home.kind !== "existing") {
    problems.push(`a repair attaches to an existing feature, and this one asks for ${ticket.home.kind} — behaviour with no feature is not yet in the PRD, which makes this growth`);
  }

  // --- sizing ---
  if (ticket.intents.length === 0) {
    problems.push("intents is empty — triage says what work this becomes, or it has not been sized");
  }
  if (ticket.intents.length > MAX_TICKET_INTENTS) {
    problems.push(
      `${ticket.intents.length} intents sketched, over the ${MAX_TICKET_INTENTS} a ticket may hold. ` +
      "At this size the request is a FEATURE — a slice of an epic rather than a unit of work — and it goes through " +
      "the narrowing chain, which checks it against its epic in both directions. Say that, rather than minting the intents.",
    );
  }

  return problems;
}

/**
 * The labels this ticket's own fields imply.
 *
 * Derived, never authored: the labels and the header cannot disagree because nothing
 * states them twice. `needs-triage` and `approved` are deliberately absent — the first is
 * removed when triage finishes, and the second is the human gate and is not the engine's
 * to write.
 */
export function ticketLabels(ticket: Ticket): string[] {
  return [`type:${ticket.type}`, `kind:${ticket.kind}`, `tier:${ticket.tier}`];
}

/**
 * The label that means a person approved this, and the ONE label no agent may apply.
 *
 * A gate the loop can satisfy on its own is not a gate. This name goes on the deny list
 * for every ACT, which is what makes the approval step real rather than ceremonial.
 */
export const APPROVED_LABEL = "approved";
export const NEEDS_TRIAGE_LABEL = "needs-triage";
