# docs/

What is written down about Doctrine, apart from `README.md` at the repo root and the agent prompts
in `.claude/agents/`, which are executable artifacts rather than documentation.

## Read in this order

1. **[design.md](design.md)** — the design. What the system **is**, present tense. No rationale;
   that is what `adr/` is for.
2. **[adr/](adr/)** — one file per decision: Status / Context / Decision / Consequences. Read these
   to know *why* something is the way it is.
3. **[calibration/](calibration/)** — measured judge-calibration records: the number each gate was
   trusted on.

## What is not here

The build plan, the execution plans, the research notes and the session handoffs were working
documents and are not published. Where a passage refers to a target application, that application
is not named.

## Rules these documents were kept by

- **`design.md` describes; `adr/` decides.** A decision in the design document is a decision nobody
  can find later, and a measurement in it is a measurement that gets edited.
- **Supersede, don't delete.** A wrong decision gets a new ADR and a `Superseded by:` line on the
  old one. A record rewritten after the fact records nothing.
