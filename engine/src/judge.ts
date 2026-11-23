import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildClaudeArgv } from "./argv.js";
import type { RunFailureReason } from "./outcome.js";
import { classifySpawn, runAgent as productionRunAgent, type RunAgentOptions, type SpawnRunResult } from "./spawn.js";
import { loadVerdict, type Verdict } from "./verdict.js";
import type { WorkUnit } from "./work-unit.js";

/** Injected agent seam — production is spawn.ts's runAgent; tests inject a fake. */
export type RunAgentFn = (prompt: string, opts: RunAgentOptions) => Promise<SpawnRunResult>;

export interface JudgeContext {
  unit: WorkUnit;
  /** Worktree checked out at the pre-change commit. */
  baseDir: string;
  /** Worktree checked out at the candidate commit. */
  headDir: string;
  baseSha: string;
  headSha: string;
  /** Pre-computed `git diff base...head` file — the judge reads this, never git history. */
  diffPath: string;
  /** Where the judge must write its verdict JSON. */
  verdictPath: string;
  logPath: string;
  requiredGates: readonly string[];
  budgetUsd: number;
  /** Path to .claude/agents/code-judge.md — single source of the judge's law. */
  agentDefinitionPath: string;
  /** Defect-registry checks to run, formatted "DP-xx: detection check". */
  registryChecks?: readonly string[];
  /** Deny-rules settings file (one-way doors) passed to the CLI. */
  settingsPath?: string;
  timeoutMs?: number;
  runAgent?: RunAgentFn;
}

export type JudgeOutcome =
  | { kind: "judged"; verdict: Verdict; logPath: string }
  | { kind: "failed"; reason: RunFailureReason; outage: boolean; errors: string[]; logPath: string };

/**
 * A cwd that is not a git repository, for the context-isolated agents.
 *
 * Claude Code adds a `gitStatus` block to its default system prompt describing the
 * repo at cwd — branch name, and the subject lines of recent commits. Run the judge
 * inside the head worktree and that block hands it **the implementer's commit
 * message**: a summary of the diff, written by the author of the diff, in the context
 * of the one agent that exists to be walled off from exactly that. The judge's own law
 * names commit messages as contamination and forbids `git log`, and it caught this
 * itself on the first production run — failing a change whose nine evidence commands
 * had all executed and exited 0, because a leak it did not solicit is still a leak.
 *
 * So the judge runs from an empty scratch directory outside every repository. There is
 * no git status to inject. It reaches the artefacts by absolute path, which its prompt
 * already gives it, and its law already tells it to execute evidence in the head
 * worktree rather than in cwd — so nothing about how it works changes.
 *
 * The alternatives were worse. `--exclude-dynamic-system-prompt-sections` only moves
 * those sections into the first user message; the leak survives. `--system-prompt-file`
 * would drop them by replacing the default prompt wholesale, and with it Claude Code's
 * own tool instructions — a large behavioural change to the one component the whole
 * design rests on, to fix a leak that a different cwd fixes outright.
 */
export function isolatedCwd(kind: string): string {
  return mkdtempSync(join(tmpdir(), `doctrine-${kind}-`));
}

/** Default gate list a judge run must positively prove. */
export const DEFAULT_REQUIRED_GATES = ["diff-read", "evidence-executed"] as const;

function agentLaw(agentDefinitionPath: string): string {
  const text = readFileSync(agentDefinitionPath, "utf8");
  // Strip the .claude/agents frontmatter; the body is the judge's law.
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return (m ? m[1]! : text).trim();
}

/**
 * Assemble the judge's entire context. Isolation is BY CONSTRUCTION: everything the
 * judge sees is listed here, and nothing here derives from the implementer's
 * reasoning — only the unit contract, the diff, worktree paths, and output contract.
 */
export function assembleJudgePrompt(ctx: JudgeContext): string {
  const evidenceList = ctx.unit.evidence
    .map((e, i) => `${i}. [${e.kind}] run: ${e.run}\n   expect: ${e.expect}`)
    .join("\n");
  const registry =
    ctx.registryChecks !== undefined && ctx.registryChecks.length > 0
      ? `\n## Defect-registry checks (run each, cite by id)\n${ctx.registryChecks.map((c) => `- ${c}`).join("\n")}\n`
      : "";
  return `${agentLaw(ctx.agentDefinitionPath)}

---

# Your task

## Work unit contract
id: ${ctx.unit.id}
title: ${ctx.unit.title}
tier: ${ctx.unit.tier}

### Intent (from the unit body)
${ctx.unit.body}

### Evidence specs (execute each; report in this order)
${evidenceList}
${registry}
## Paths
- diff (read this, never git history): ${ctx.diffPath}
- base worktree (${ctx.baseSha}): ${ctx.baseDir}
- head worktree (${ctx.headSha}): ${ctx.headDir}
- write the verdict JSON to EXACTLY: ${ctx.verdictPath}
- write per-evidence logs next to it as evidence-<i>.log

## Gates you must positively prove in gates_executed
${ctx.requiredGates.map((g) => `- ${g}`).join("\n")}

## Record in the verdict
base_sha: ${ctx.baseSha}
head_sha: ${ctx.headSha}
`;
}

/**
 * Run the code-judge for one unit. Trusts artifacts, never claims: whatever the
 * judge says in chat is discarded; only a validated verdict file counts, and any
 * spawn-level failure or validation gap fails loudly with a closed-set reason.
 */
export async function runJudge(ctx: JudgeContext): Promise<JudgeOutcome> {
  const invoke = ctx.runAgent ?? productionRunAgent;
  const prompt = assembleJudgePrompt(ctx);
  const argv = buildClaudeArgv({
    maxBudgetUsd: ctx.budgetUsd,
    allowedTools: ["Bash", "Read", "Grep", "Glob", "Write"],
    addDirs: [ctx.baseDir, ctx.headDir, dirname(ctx.verdictPath)],
    permissionMode: "dontAsk",
    ...(ctx.settingsPath !== undefined ? { settingsPath: ctx.settingsPath } : {}),
  });

  const scratch = isolatedCwd("judge");
  let spawned;
  try {
    spawned = await invoke(prompt, {
      argv,
      cwd: scratch,
      timeoutMs: ctx.timeoutMs ?? 15 * 60_000,
      logPath: ctx.logPath,
    });
  } finally {
    // A supervisor runs indefinitely; one scratch dir per judged unit, never removed,
    // is an unbounded leak. Best-effort — a failed cleanup must not fail a verdict.
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
  }

  const spawnFailure = classifySpawn(spawned);
  if (spawnFailure !== null) {
    return {
      kind: "failed",
      reason: spawnFailure,
      outage: spawned.outage,
      errors: [`judge run failed at spawn level: ${spawnFailure}`],
      logPath: ctx.logPath,
    };
  }

  const validated = loadVerdict(ctx.verdictPath, ctx.unit, ctx.requiredGates);
  if (!validated.ok) {
    return { kind: "failed", reason: validated.reason, outage: false, errors: validated.errors, logPath: ctx.logPath };
  }
  return { kind: "judged", verdict: validated.verdict, logPath: ctx.logPath };
}

/** Convenience: default verdict/log locations for a run directory. */
export function judgePaths(runDir: string): { verdictPath: string; logPath: string } {
  return { verdictPath: join(runDir, "verdict.json"), logPath: join(runDir, "judge.log") };
}
