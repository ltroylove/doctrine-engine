# ADR-0009 — A target glossary, injected deterministically

**Status:** Proposed 2026-10-19. Depends on D7 (`docs/design.md`, the context ladder) and on
[ADR-0008](0008-surface-first-and-the-surface-contract.md).

## Context

**The incident.** On 2026-10-18, the second target's `u-2026-10-18-close-figures` escalated. Its spec's §1
defined the Close page's `payroll` figure as "`sum()` of every `employees[].gross`", citing
`payroll_line` refs. But a `payroll_line` ref traces to its line's amount **negated**, because
`src/core/ids.ts` defines a ref's amount as its contribution to the cash figure, and payroll is money
leaving. One word was carrying two signed meanings. The planner meant gross pay. The ref kind it
picked meant cash out. No implementation could meet both, and the implementer's way out was a
negative Payroll card. The judge escalated correctly. The observer fixed the spec by hand: a new
`payroll_gross` kind, positive, matching the figure on the canvas. That cost one escalated attempt,
one rebuild and an observer intervention.

**How often this happens, measured honestly.** The target had four escalations from 2026-09-12 to
2026-10-19. Only close-figures was a vocabulary failure. The other three were:

- a producer-ordering error in a spec (`sentinel-precision`);
- the Playwright absolute-path filter trap (`sentinel-e2e`);
- an editable-tests list that left out one file (`close-prestate-ready`).

So the evidence is one incident, not a pattern. This ADR is sized to that.

**Why the vocabulary has no home today.** `context/contracts.md` is the only shared document, and
it records **interfaces**: shapes, owners, consumers. On this target it is 2,982 lines in 57
sections. The meaning of a term like "payroll" is spread across the contract sections that use it,
and the sign rule lived in a code comment in `src/core/ids.ts`. The file is also too big to amend
safely. The close-figures build-out could not Edit it, chose not to rewrite all 2,600 lines, and left
its own contract in the unit file instead, with a note asking the next unit to copy it across.
Asking ACTs to maintain a second large prose file would hit the same wall.

**Prior art, as an idea only.** Matt Pocock's public skills recommend a project glossary that agents
must use, for shorter output and consistent naming. Doctrine takes the idea and none of the text.

## Decision

1. **Each target gets `context/glossary.md`: short, one entry per term.** An entry has:
   - the term;
   - its single meaning, in one sentence;
   - its unit and sign where the term is a quantity ("cents, positive: gross pay");
   - the terms it is easily confused with, and how they differ;
   - its owner (a PRD or ARCH section, or the unit that minted it).

   It holds only terms where a wrong reading leads to a wrong build. It is not a dictionary of the
   domain.
2. **It is seeded at onboarding**, from the PRD and the ARCH, by the same session that writes the
   manifest. The ARCH is the usual source of sign and unit rules. **It ships with at least one
   entry or not at all.** No empty placeholder file.
3. **ACTs never edit it. The engine appends to it.** The build-out and epic ACTs may return
   `glossary:` entries in their output. The engine parses them and appends them, the way
   `appendDecision` writes `decisions.md`. An entry whose term already exists with a different
   meaning is **refused mechanically**, and the refusal names both meanings. A collision is a
   finding, not something to merge. The new field is covered by `prompt-drift.test.ts`, like every
   law and parser pair.
4. **Retrieval is deterministic.** The engine injects the whole file, by path, into the task of
   every ACT that writes or judges a spec or a diff:
   - narrowing-decomposer
   - build-out
   - implementer
   - unit-fixer
   - code-judge

   This is D7's guardrail: load-bearing context is handed over, never left for the agent to
   remember.
5. **The code-judge gains one coherence check:** a spec or diff that uses a glossary term in a
   meaning other than its entry fails `coherence: terms`, citing the entry.

## Consequences

- **The close-figures class is caught before money is spent.** The payroll collision would have
  surfaced as a refused glossary entry at build-out, or as a `terms` finding at the first judge,
  not as an escalation after an implementation.
- **It costs tokens on every ACT that receives it.** That is why the file holds only terms that
  have caused, or plausibly can cause, a wrong build, and why it is held to a size budget.
- **Kill criterion.** If, after the next program's worth of epics on any target, the glossary has
  caught nothing (no refused collision, no `terms` finding), and no escalation was a vocabulary
  failure, then the injection is costing more than it saves. Supersede this ADR and drop it. One
  incident justifies a trial, not a permanent mechanism.
- **Doctrine's own vocabulary is out of scope.** "Surface", "unit", "epic" and similar terms are
  defined by the laws and ADRs that introduce them. The whole-program surface check being put
  into an epic's evidence on 2026-10-19 was a misuse of an engine term. It is the retro's business
  ([ADR-0010](0010-the-retro-turns-run-artifacts-into-intake.md)), and an engine refusal, not a
  glossary entry.
