/**
 * `context/contracts.md` — the interfaces shared between work units, where the owner
 * builds it and everyone else consumes it unchanged.
 *
 * **This module exists because `plan-judge` is being deleted and one of its clauses is
 * not.** ADR-0001 removes the decompose rung, and with it the judge whose rule 3 said
 * *mint no rival to an existing contract*. The rung that inherits the exposure is
 * build-out, which is both the writer of contract additions and — being a fresh planner
 * reading one slice of a tree — the ACT most able to duplicate one without noticing.
 *
 * What is mechanized here is the half a parser can decide, and it is deliberately
 * **stronger** than the clause it replaces:
 *
 *   - an added section may not carry a heading an existing contract already has;
 *   - an existing contract section may not be rewritten or removed at all.
 *
 * The second is not in `plan-judge`'s wording and is the one that matters more. A judge
 * asked about rivals is looking at what was ADDED; a build-out that quietly edits the
 * signature in a contract other units have already been built against does not add
 * anything, and every one of those units is now wrong about an interface it consumed.
 * Append-only is checkable, and the ownership line at the top of the file already says it
 * in prose.
 *
 * **What is NOT covered, said plainly rather than implied.** A semantic rival — a new
 * contract that competes with an existing one under a different name — needs a reader,
 * and this cannot see it. That half of rule 3 dies with `plan-judge` and does not come
 * back here. It is a real reduction in cover, and the argument for accepting it is that
 * the alternative was keeping a whole judge alive for one clause that fired on a rung
 * that no longer exists. If duplicate contracts start appearing after cutover, this is
 * the place that has to grow a reader.
 */

/** `## <title>` — one contract section. `#` and `###` are the file's own furniture. */
const CONTRACT_HEADING = /^##\s+(.+?)\s*$/;

/**
 * Two headings are the same contract when they read the same to a person.
 *
 * Case, backticks, and punctuation are formatting; `## The actor parameter` and
 * `## the `actor` parameter!` name one thing. Comparing raw text would let a rival be
 * minted by capitalising a word, which is the failure mode this check exists for rather
 * than an edge case of it.
 */
function normalise(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface ContractSection {
  /** The heading exactly as written, for messages. */
  title: string;
  key: string;
  /** The section's whole text, heading included — what append-only is checked over. */
  body: string;
}

/** Split a contracts file into its `##` sections. Text before the first one is preamble. */
export function parseContracts(markdown: string): ContractSection[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: ContractSection[] = [];
  let current: { title: string; from: number } | null = null;
  const flush = (to: number): void => {
    if (current === null) return;
    out.push({
      title: current.title,
      key: normalise(current.title),
      body: lines.slice(current.from, to).join("\n").trimEnd(),
    });
  };
  lines.forEach((line, i) => {
    const m = CONTRACT_HEADING.exec(line);
    if (m === null) return;
    flush(i);
    current = { title: m[1]!, from: i };
  });
  flush(lines.length);
  return out;
}

/**
 * Everything before the first `##` — the file's title and its ownership rules.
 *
 * It is part of the append-only comparison, and it had to be (PR #94's second review):
 * `parseContracts` has no representation for this text, so a contract written here — an
 * unheaded `pushInvoices(db)` line below `# Contracts`, which is exactly what a test in this
 * repo did — could be rewritten or deleted by a later build-out and pass the gate
 * untouched. So the preamble is frozen like any section, and a new contract must arrive as
 * a `##` section, where the section rules can see it.
 */
function preambleOf(markdown: string): string {
  const LF = String.fromCharCode(10);
  const lines = markdown.split(String.fromCharCode(13) + LF).join(LF).split(LF);
  const first = lines.findIndex((l) => CONTRACT_HEADING.test(l));
  return (first === -1 ? lines : lines.slice(0, first)).join(LF).trimEnd();
}

/**
 * What a build-out did to `contracts.md`, and whether it was allowed to.
 *
 * Returns the problems, empty when the change is legal. `before` being absent — the file
 * did not exist — is the same as an empty one: everything in `after` is an addition.
 */
export function lintContractAdditions(before: string, after: string): string[] {
  const problems: string[] = [];
  // A file that did not exist has no preamble to protect: everything in it is an addition.
  // Once one exists, it is frozen — see `preambleOf`.
  if (before.trim() !== "" && preambleOf(after) !== preambleOf(before)) {
    problems.push(
      "changed the text above the first contract section — that is the file's title and its "
      + "ownership rules, and a contract written there cannot be protected; add a new contract "
      + "as a `## <name>` section instead",
    );
  }
  const existing = parseContracts(before);
  const now = parseContracts(after);
  const byKey = new Map(existing.map((s) => [s.key, s]));

  const seen = new Set<string>();
  for (const section of now) {
    const prior = byKey.get(section.key);
    if (prior === undefined) {
      // An addition. Its only sin is colliding with another addition in the same run.
      if (seen.has(section.key)) {
        problems.push(`added the contract "${section.title}" twice`);
      }
      seen.add(section.key);
      continue;
    }
    seen.add(section.key);
    if (section.body !== prior.body) {
      problems.push(
        `rewrote the existing contract "${prior.title}" — contracts are append-only here: `
        + "the owner builds it and every other unit consumes it unchanged, so units already "
        + "built against this one are now wrong about an interface they were handed",
      );
    }
  }

  for (const section of existing) {
    if (!now.some((s) => s.key === section.key)) {
      problems.push(`removed the existing contract "${section.title}" — a contract with consumers is not this unit's to delete`);
    }
  }

  return problems;
}
