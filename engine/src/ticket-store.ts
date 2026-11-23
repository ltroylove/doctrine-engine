import { execFileSync } from "node:child_process";
import { APPROVED_LABEL, NEEDS_TRIAGE_LABEL, ticketLabels, type Ticket } from "./ticket.js";

/**
 * Where tickets live — and the only thing that knows they are GitHub issues.
 *
 * The same seam `NarrowingStore` is, for the same reason: `ticket.ts` parses a string and
 * does arithmetic over objects, and `parseFrontmatter` takes a label it only puts in
 * messages. Everything above this file is storage-agnostic already.
 *
 * Unlike narrowings, tickets are issues from the first day. A narrowing's identity is a
 * slug because it must be able to name its parent before a tracker has seen it; a ticket's
 * origin IS the tracker, so there is nothing to migrate and no file to keep in step.
 */

export interface RawIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
}

export interface TicketStore {
  /** Issues waiting to be triaged, oldest first — a queue, so the backlog drains in order. */
  needingTriage(): RawIssue[];
  /** One issue by number, whatever state it is in. */
  read(number: number): RawIssue | undefined;
  /**
   * Write the triaged body and set the derived labels.
   *
   * Derived, never authored: `ticketLabels` computes them from the ticket's own fields, so
   * the labels and the frontmatter cannot disagree because nothing states them twice.
   */
  publish(ticket: Ticket, body: string): void;
  /** Issues a person has approved and the loop has not yet planned. */
  approved(): RawIssue[];
}

function gh(arenaDir: string, args: string[]): string {
  return execFileSync("gh", args, { cwd: arenaDir, encoding: "utf8" }).trim();
}

/** The labels the engine manages. `approved` is deliberately not among them — see below. */
const LABEL_PREFIXES = ["type:", "kind:", "tier:"];

export class GhTicketStore implements TicketStore {
  constructor(private readonly arenaDir: string, private readonly run: (dir: string, args: string[]) => string = gh) {}

  private list(label: string): RawIssue[] {
    let out: string;
    try {
      out = this.run(this.arenaDir, ["issue", "list", "--label", label, "--state", "open", "--json", "number,title,body,url,labels", "--limit", "50"]);
    } catch {
      // A tracker that cannot be reached is not an empty backlog. Returning [] here would
      // read as "nothing to triage" and the rung would go quietly idle on an outage.
      throw new Error(`could not list issues labelled ${label}`);
    }
    const rows = JSON.parse(out) as Array<{ number: number; title: string; body: string; url: string; labels: Array<{ name: string }> }>;
    return rows
      .map((r) => ({ number: r.number, title: r.title, body: r.body ?? "", url: r.url, labels: r.labels.map((l) => l.name) }))
      .sort((a, b) => a.number - b.number);
  }

  needingTriage(): RawIssue[] {
    return this.list(NEEDS_TRIAGE_LABEL);
  }

  approved(): RawIssue[] {
    return this.list(APPROVED_LABEL);
  }

  read(number: number): RawIssue | undefined {
    try {
      const out = this.run(this.arenaDir, ["issue", "view", String(number), "--json", "number,title,body,url,labels"]);
      const r = JSON.parse(out) as { number: number; title: string; body: string; url: string; labels: Array<{ name: string }> };
      return { number: r.number, title: r.title, body: r.body ?? "", url: r.url, labels: r.labels.map((l) => l.name) };
    } catch {
      return undefined;
    }
  }

  publish(ticket: Ticket, body: string): void {
    const n = String(ticket.number);
    // A lookup that FAILED is not an issue with no labels.
    //
    // Collapsing it to `[]` meant a transient `issue view` failure published the body and
    // then removed nothing: `needs-triage` stayed on, so the issue sat at the head of the
    // queue and was triaged again next tick, and a stale `kind:`/`type:` from an earlier
    // classification stayed beside the new one. Both failures are silent and the second
    // outlives the outage. A publish that cannot read the labels it must replace has not
    // published.
    const current = this.read(ticket.number);
    if (current === undefined) {
      throw new Error(`could not read issue #${n} before publishing — refusing to publish a body whose labels cannot be reconciled`);
    }
    const existing = current.labels;
    // Replace the derived set rather than adding to it: a ticket re-triaged after its
    // classification changed would otherwise carry both `kind:repair` and `kind:growth`,
    // and every reader would pick whichever it happened to see first.
    const stale = existing.filter((l) => LABEL_PREFIXES.some((p) => l.startsWith(p)));
    const wanted = ticketLabels(ticket);
    const args = ["issue", "edit", n, "--body", body];
    for (const l of stale.filter((l) => !wanted.includes(l))) args.push("--remove-label", l);
    for (const l of wanted) args.push("--add-label", l);
    // Triage is what removes this, and it is the same act for every source: an issue a
    // person opened and one the loop's own deferred findings opened both arrive labelled
    // and both leave it here.
    if (existing.includes(NEEDS_TRIAGE_LABEL)) args.push("--remove-label", NEEDS_TRIAGE_LABEL);
    this.run(this.arenaDir, args);
  }
}

/**
 * In memory, for tests and to keep the interface honest.
 *
 * A second implementation exists before it is needed for the same reason the narrowing
 * store has one: an interface with exactly one implementation is a shape, not a seam, and
 * the leaks only show when something else has to fit through it.
 */
export class MemoryTicketStore implements TicketStore {
  readonly issues = new Map<number, RawIssue>();
  /** Bodies as published, so a test can read back exactly what was written. */
  readonly published = new Map<number, string>();

  constructor(seed: readonly RawIssue[] = []) {
    for (const i of seed) this.issues.set(i.number, { ...i, labels: [...i.labels] });
  }

  private withLabel(label: string): RawIssue[] {
    return [...this.issues.values()].filter((i) => i.labels.includes(label)).sort((a, b) => a.number - b.number);
  }

  needingTriage(): RawIssue[] { return this.withLabel(NEEDS_TRIAGE_LABEL); }
  approved(): RawIssue[] { return this.withLabel(APPROVED_LABEL); }
  read(number: number): RawIssue | undefined { return this.issues.get(number); }

  publish(ticket: Ticket, body: string): void {
    const issue = this.issues.get(ticket.number);
    if (issue === undefined) return;
    issue.body = body;
    this.published.set(ticket.number, body);
    issue.labels = [
      ...issue.labels.filter((l) => !LABEL_PREFIXES.some((p) => l.startsWith(p)) && l !== NEEDS_TRIAGE_LABEL),
      ...ticketLabels(ticket),
    ];
  }
}

/**
 * What no ACT may do, at the permission layer.
 *
 * **A gate the loop can satisfy on its own is not a gate.** The triage ACT holds `Bash`
 * so it can grep the codebase, and `gh` is on its PATH — so without this it could label
 * its own ticket approved and walk through the one step that exists to make a person look.
 * That is not a hypothetical failure of judgement; it is a capability, and capabilities
 * get removed rather than discouraged.
 *
 * The engine does not apply it either. `GhTicketStore.publish` writes only the derived
 * labels, and `approved` is not among them.
 */
export const TICKET_ACT_DENY: readonly string[] = [
  // `gh` ENTIRELY, and the reason is that the first version of this list was wrong.
  //
  // It denied `--add-label approved` in three spellings and four `gh issue` verbs, which
  // reads like a boundary and is not one: `gh api -X PATCH repos/o/r/issues/445 -f
  // labels[]=approved` sets the label without matching any of them. A deny list built from
  // spellings is a list of the ways somebody thought of, and the authenticated API route
  // accepts arbitrary methods and fields.
  //
  // So the capability goes rather than its spellings. These ACTs have no business calling
  // the tracker at all: the triager is handed the issue text in its prompt and writes its
  // ticket to a scratch file, and the ENGINE publishes. `gh` on their PATH was never
  // needed — it was only ever an unclosed door. Found by external review, 2026-09-13.
  "Bash(gh:*)",
  "Bash(*gh api*)",
  "Bash(*gh issue*)",
  "Bash(*gh pr*)",
  // And the raw route underneath it, for the same reason one level down: `curl` against
  // api.github.com with the token in the environment is the same request without the CLI.
  "Bash(*api.github.com*)",
];
