import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildClaudeArgv } from "./argv.js";
import type { Intent } from "./intent.js";
import { isolatedCwd, type RunAgentFn } from "./judge.js";
import { classifySpawn, runAgent as productionRunAgent } from "./spawn.js";
import type { WorkUnit } from "./work-unit.js";

/**
 * The plan-judge: the one artifact class nothing
 * verified was the PLAN itself. The code-judge scores implementation-vs-unit and
 * the intent-grade scores outcome-vs-acceptance, but a decomposer that misreads
 * or embellishes the intent produces units that are faithfully implemented,
 * honestly judged, and wrong. This is a single judge pass over a plan,
 * in code-judge form: context-isolated, cite-or-fail, verdict artifact
 * only — NOT a multi-stage document-review pipeline.
 *
 * It runs between plan lint and mechanical promotion; a fail reverts the plan
 * wholesale (re-decompose is a normal tick, plans are cheap).
 */

export interface PlanVerdictUnit {
  id: string;
  ok: boolean;
  cite: string;
  problems: string[];
}

export interface PlanVerdict {
  intent: string;
  verdict: "pass" | "fail";
  judged: true;
  units: PlanVerdictUnit[];
  rival_check: string;
}

export type PlanJudgeOutcome =
  | { kind: "pass"; verdict: PlanVerdict; spendUsd: number }
  | { kind: "fail"; verdict: PlanVerdict; problems: string[]; spendUsd: number }
  | { kind: "failed"; reason: string; outage: boolean; errors: string[]; spendUsd: number };

export interface PlanJudgeContext {
  intent: Intent;
  children: WorkUnit[];
  /** Working-tree paths of the draft unit files, relative to arenaDir. */
  unitFiles: string[];
  arenaDir: string;
  agentDefinitionPath: string;
  budgetUsd: number;
  logPath: string;
  verdictPath: string;
  timeoutMs?: number;
  runAgent?: RunAgentFn;
}

function agentLaw(path: string): string {
  const text = readFileSync(path, "utf8");
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return (m ? m[1]! : text).trim();
}

export function assemblePlanJudgePrompt(ctx: PlanJudgeContext): string {
  const acceptance = ctx.intent.evidence
    .map((e, i) => `${i}. [${e.kind}] run: ${e.run}\n   expect: ${e.expect}`)
    .join("\n");
  const units = ctx.unitFiles
    .map((f) => `--- ${f} ---\n${readFileSync(join(ctx.arenaDir, f), "utf8").trim()}`)
    .join("\n\n");
  return `${agentLaw(ctx.agentDefinitionPath)}

---

# Your plan to judge

## The intent (the ratified source of truth)

id: ${ctx.intent.id}
title: ${ctx.intent.title}

### Brief
${ctx.intent.body}

### Acceptance evidence
${acceptance || "(none declared)"}

## The draft plan to judge (${ctx.children.length} units — your verdict must cover exactly these ids: ${ctx.children.map((u) => u.id).join(", ")})

${units}

## Paths
- repository root (contracts.md, decisions.md, source tree): ${ctx.arenaDir}
  Read, Grep and Glob it by that ABSOLUTE path. It is NOT your working directory: you
  run from an empty scratch directory outside every repository, so that the harness
  cannot inject the decompose commit's own subject line into your context. A relative
  path resolves to that empty directory and will appear to show a missing file — which
  is not evidence of anything.
- write the verdict JSON to EXACTLY: ${ctx.verdictPath}
`;
}

export function validatePlanVerdict(
  raw: unknown,
  childIds: readonly string[],
): { ok: true; verdict: PlanVerdict } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) return { ok: false, errors: ["verdict is not a JSON object"] };
  const v = raw as Record<string, unknown>;

  if (v["judged"] !== true) errors.push("judged must be exactly true");
  if (v["verdict"] !== "pass" && v["verdict"] !== "fail") errors.push('verdict must be "pass" or "fail"');
  if (typeof v["rival_check"] !== "string" || v["rival_check"].trim().length === 0) {
    errors.push("rival_check must be a non-empty string — it is the liveness proof of the rival scan");
  }

  const units = Array.isArray(v["units"]) ? (v["units"] as unknown[]) : null;
  if (units === null) {
    errors.push("units must be a list");
    return { ok: false, errors };
  }
  const seen = new Map<string, PlanVerdictUnit>();
  for (const [i, entry] of units.entries()) {
    const u = entry as Record<string, unknown> | null;
    if (typeof u !== "object" || u === null) { errors.push(`units[${i}] must be a mapping`); continue; }
    const id = typeof u["id"] === "string" ? u["id"] : "";
    if (id.length === 0) { errors.push(`units[${i}].id missing`); continue; }
    if (!childIds.includes(id)) { errors.push(`units[${i}]: "${id}" is not in the plan`); continue; }
    if (seen.has(id)) { errors.push(`duplicate verdict entry for ${id}`); continue; }
    const ok = u["ok"] === true;
    const cite = typeof u["cite"] === "string" ? u["cite"] : "";
    const problems = Array.isArray(u["problems"]) ? (u["problems"] as unknown[]).filter((p) => typeof p === "string") as string[] : [];
    if (ok && cite.trim().length === 0) errors.push(`${id}: ok without a cite — traceability is cite-or-fail`);
    if (!ok && problems.length === 0) errors.push(`${id}: not ok but no problems stated`);
    seen.set(id, { id, ok, cite, problems });
  }
  for (const id of childIds) {
    if (!seen.has(id)) errors.push(`no verdict entry for ${id} — every unit must be judged`);
  }
  const allOk = [...seen.values()].every((u) => u.ok);
  if (v["verdict"] === "pass" && !allOk) errors.push("verdict pass but a unit entry is not ok");
  if (v["verdict"] === "fail" && allOk && seen.size === childIds.length) {
    errors.push("verdict fail but every unit entry is ok");
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    verdict: {
      intent: typeof v["intent"] === "string" ? v["intent"] : "",
      verdict: v["verdict"] as "pass" | "fail",
      judged: true,
      units: [...seen.values()],
      rival_check: v["rival_check"] as string,
    },
  };
}

export async function runPlanJudge(ctx: PlanJudgeContext): Promise<PlanJudgeOutcome> {
  const invoke = ctx.runAgent ?? productionRunAgent;
  mkdirSync(join(ctx.verdictPath, ".."), { recursive: true });

  const scratch = isolatedCwd("plan-judge");
  let spawned;
  try {
    spawned = await invoke(assemblePlanJudgePrompt(ctx), {
      argv: buildClaudeArgv({
        maxBudgetUsd: ctx.budgetUsd,
        allowedTools: ["Read", "Grep", "Glob", "Write"],
        addDirs: [ctx.arenaDir],
        permissionMode: "dontAsk",
      }),
      // Same isolation as the code-judge: from inside the arena, the injected gitStatus
      // block carries the decompose commit's subject — the planner's own account of the
      // plan being judged. It reaches the arena by absolute path instead.
      cwd: scratch,
      timeoutMs: ctx.timeoutMs ?? 10 * 60_000,
      logPath: ctx.logPath,
    });
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
  }

  const spendUsd = spawned.resultMessage?.total_cost_usd ?? 0;
  const spawnFailure = classifySpawn(spawned);
  if (spawnFailure !== null) {
    return { kind: "failed", reason: spawnFailure, outage: spawned.outage, errors: [], spendUsd };
  }
  if (!existsSync(ctx.verdictPath)) {
    return { kind: "failed", reason: "missing-plan-verdict", outage: false, errors: [`no verdict file at ${ctx.verdictPath}`], spendUsd };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(ctx.verdictPath, "utf8"));
  } catch (e) {
    return { kind: "failed", reason: "malformed-plan-verdict", outage: false, errors: [String(e)], spendUsd };
  }
  const validated = validatePlanVerdict(raw, ctx.children.map((u) => u.id));
  if (!validated.ok) {
    return { kind: "failed", reason: "malformed-plan-verdict", outage: false, errors: validated.errors, spendUsd };
  }
  if (validated.verdict.verdict === "pass") {
    return { kind: "pass", verdict: validated.verdict, spendUsd };
  }
  return {
    kind: "fail",
    verdict: validated.verdict,
    problems: validated.verdict.units.filter((u) => !u.ok).flatMap((u) => u.problems.map((p) => `${u.id}: ${p}`)),
    spendUsd,
  };
}
