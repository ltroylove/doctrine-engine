# CLAUDE.md

Guidance for Claude Code, and for anyone else, working in this repository.

## What this repository is

Doctrine is an unattended loop for building software with AI agents, run locally. A small
TypeScript engine (`engine/`) looks at a **target** git repository, works out the one next
step, and starts one Claude Code agent to do it, using the prompts in `.claude/agents/`. A
separate judge agent verifies each piece of work before it lands. No person approves anything
in the path.

**The engine is retired.** Development stopped in October 2026. It is published as a record
and is not maintained. Read `README.md` for the idea, `docs/design.md` for what the system
is, and `docs/adr/` for why each decision was made.

## What you can and cannot run from a clone

| | Works from this repository alone? |
|---|---|
| Install and run the tests | **Yes, on Windows.** 729 tests, all offline. Not checked on macOS or Linux. |
| Run the loop | **Only against a target repository you set up yourself.** None is included. |
| Run the calibration sweeps (`pnpm canaries` and the two others) | **No.** Each canary is pinned to a commit of an arena repository that is not published. |

The loop has only been run by its author. The steps below are read from the code, not from a
fresh machine.

## Install and test

Requirements: **Node 22 or later**, **pnpm**, and **git** (2.28 or later, since the tests run
`git init -b`).

```bash
cd engine
pnpm install
pnpm test          # tsc --noEmit && vitest run
```

**The suite has only been run on Windows.** At least one stand-in in
`engine/test/review.test.ts` recognises only paths that start with a drive letter, so some
tests are likely to fail on macOS or Linux until that is changed.

The tests need no network, no `claude` and no `gh`. Agents are replaced by a small stand-in
(`engine/test/fake-claude/`), and git remotes are local bare repositories. One test rebases
without passing a git identity, so set a global `user.name` and `user.email` first.

Other scripts in `engine/package.json`: `pnpm typecheck`, `pnpm build` (to `engine/dist`),
`pnpm loop`, `pnpm coherence`, and the three canary commands.

## Running the loop

**Read "What the loop does to a target" below before you run it.** Use a dedicated clone of
the target, never a working copy you care about.

```bash
cd engine
pnpm loop <target-dir> [maxTicks]

# or, from the repository root, a wrapper that restarts the loop if its process dies:
node scripts/run-loop.mjs <target-dir>
```

### What the machine needs

- **The Claude Code CLI, on PATH as `claude`, already logged in.** The engine starts it as
  `claude -p --output-format stream-json …` with no shell. On Windows it must be the native
  binary: a `claude.cmd` installed by npm cannot be started this way.
- **Authentication is the CLI's own login.** The engine removes `ANTHROPIC_API_KEY` from each
  agent's environment on purpose, so an API key in your shell is not used. It never passes
  `--model`; the CLI's default model runs.
- **bash.** On Windows the engine looks for Git Bash under `Program Files\Git\bin`, because
  the WSL relay can come first on PATH. Set `DOCTRINE_BASH` to a bash executable to override.
- **`gh`, logged in,** only if the target uses pull-request landing or GitHub-issue tickets.

### What the target needs

A git repository with a local base branch (default `development`) and a manifest at
`.doctrine/manifest.json`. The smallest manifest the tests use:

```json
{ "base_branch": "development", "doors": [] }
```

The manifest is not validated. A misspelled field is ignored without a message.

| Field | Default | What it does |
|---|---|---|
| `base_branch` | `development` | The branch units are cut from and land into |
| `setup` | none | A command run with bash in each worktree before checks, such as `npm ci` |
| `gates` | none | Named commands that must pass before the paid judge runs |
| `doors` | `[]` | Path globs no agent may edit, write or touch from bash |
| `door_credentials` | `[]` | Environment-variable name patterns. If any is set in your shell, the loop refuses to start |
| `budgets` | `attemptsPerUnit: 2`, `dailySpendUsd: 100`, `consecutiveFailuresHalt: 3` | The loop's safety limits. The keys are camelCase |
| `landing` | `local` | `local` merges inside the clone. `pr` pushes to `origin` and merges a pull request with `gh` |
| `review` | off | With `landing: "pr"`: wait for review comments, answer them, then merge. `window_s` 300, `max_rounds` 2 |
| `program` | none | `{ "prd": "<path>", "arch": "<path>" }`. Turns on planning from a PRD and an architecture document |
| `design` | none | `{ contract, screens, out }`. Required before any unit that touches UI can land |
| `tickets` | off | Triage GitHub issues as intake. Needs `program` as well |
| `surface` | none | A command that must exit 0 before the program counts as done |

The loop needs work to pick up. The simplest form is a **work unit**: a Markdown file in
`work/` with YAML frontmatter. A unit is picked only when its status is `ready` and it has
evidence.

```markdown
---
id: wu-bump-marker
title: Bump marker to v2
tier: reversible
status: ready
budget_usd: 5
evidence:
  - kind: command
    run: "grep -q v2 app.txt"
    expect: "exit 0 on head"
---
Change the marker in app.txt from v1 to v2.
```

`tier` is `reversible` or `irreversible`. `budget_usd` caps what the implementer and the judge
may each spend on the unit. A unit file that does not parse is skipped without a message.

With a `program` block the loop plans its own work instead: it reads the PRD and architecture
document, writes epics under `docs/program/epics/`, and scaffolds units from them. The PRD's
success criteria must be bullets of the form ``- **machine** `C1.1` Given …``, under headings
numbered `C1.`, `C2.` and so on.

Add these to the target's `.gitignore`: `.doctrine/lease/`, `.doctrine/runs/` and
`.doctrine/canary-runs/`.

### What the loop does to a target

- **It discards uncommitted changes.** When it reverts an agent's work it runs
  `git checkout -- .` and `git clean -fd` in the target's working tree, and every tick checks
  out the base branch.
- **It commits straight to the base branch:** landed work, status changes and its own
  bookkeeping under `context/`.
- **It deletes local branches named `doctrine/*`** that match no ready unit.
- **With `landing: "pr"` it pushes** unit branches and the base branch to `origin`, and merges
  pull requests itself.
- **Only `ANTHROPIC_API_KEY` is removed from the agents' environment.** Every other variable
  in your shell reaches them, unless you list its name pattern in `door_credentials`, which
  stops the loop from starting while it is set.

### Controlling it

There is no console. You steer the loop through two files in the target.

- **`.doctrine/pause`** stops the loop while it exists. Its text is the reason. A line
  `resume_at: <ISO time>` makes it a timed wait that the loop lifts itself. Without that line
  the pause is permanent and the process exits with code 0. The loop writes this file itself
  when a safety limit trips, and deleting it is how you acknowledge a halt.
- **`.doctrine/directives.md`** holds YAML frontmatter with `veto: [unit ids]`,
  `priority: [unit ids]` and `intake_mode: manual`. If the frontmatter does not parse, the
  loop treats itself as paused.

Each tick prints one line, `[tick] <decision> <unit> — <detail>`, and the loop waits two to
three minutes between ticks. The ledgers are `.doctrine/ticks.jsonl` and
`.doctrine/metrics.jsonl` in the target.

Exit codes of `pnpm loop`: 0 for a normal stop, including a permanent pause; 1 when the
containment check refuses to start or three ticks in a row throw; 2 for bad usage. A missing
manifest is an uncaught error.

### Cost

Every agent run is capped with `--max-budget-usd`. Implementing and judging a unit are each
capped at the unit's `budget_usd`. Planning runs are capped in code at between $3 and $20
each. The loop pauses until the next UTC midnight once the day's recorded spend passes
`dailySpendUsd`, and halts after `consecutiveFailuresHalt` failures in a row. On a subscription
login the dollar figures are the CLI's own estimates, not a bill.

## Repository layout

| Path | What |
|---|---|
| `engine/src/` | The loop. `loop-cli.ts` is the entry point, `supervisor.ts` paces ticks, `dispatch.ts` decides the next step |
| `engine/test/` | The tests, and `fake-claude/`, the stand-in for the CLI |
| `.claude/agents/` | The 19 agent prompts the engine loads. They are part of the program, not documentation |
| `canaries/`, `plan-canaries/`, `design-canaries/` | Seeded defects each judge was measured against |
| `scripts/run-loop.mjs` | The restarting wrapper |
| `docs/` | `design.md`, the ADRs in `adr/`, and the calibration records in `calibration/` |

## Working on the code

- **An agent prompt and the parser that reads its output are one contract.**
  `engine/test/prompt-drift.test.ts` fails when a prompt names a field no parser reads. Change
  both together.
- **The safety limits are load-bearing.** Budgets, attempt caps, the failure halt and the deny
  rules are the only things that stop an unattended loop. Do not remove one to make a test
  pass.
- **The engine trusts artifacts, never an agent's claims.** State is worked out again from
  the target's committed files on every tick. Do not add state that lives only in memory or
  in a branch name.
- **Run `pnpm test` after any change.** The suite takes under a minute.
- Comments explain why the code exists, often by describing a failure that happened. Some
  refer to a build plan and research notes that are not published.
