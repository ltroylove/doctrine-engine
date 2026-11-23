import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAllPlanCanaries, runPlanCanary } from "./plan-canary.js";

// usage:
//   pnpm plan-canaries <arena-dir>             run all plan canaries
//   pnpm plan-canaries <arena-dir> <canary>    run one plan canary
const HERE = dirname(fileURLToPath(import.meta.url));
const DOCTRINE_ROOT = resolve(HERE, "..", "..");

const [arenaArg, onlyId] = process.argv.slice(2);
if (arenaArg === undefined) {
  console.error("usage: pnpm plan-canaries <arena-dir> [canary-id]");
  process.exit(2);
}
const deps = {
  arenaDir: resolve(arenaArg),
  canariesDir: join(DOCTRINE_ROOT, "plan-canaries"),
  runsDir: join(resolve(arenaArg), ".doctrine", "plan-canary-runs"),
  agentDefinitionPath: join(DOCTRINE_ROOT, ".claude", "agents", "plan-judge.md"),
  budgetUsd: 5,
};

if (onlyId !== undefined) {
  const run = await runPlanCanary(onlyId, deps);
  console.log(`${run.canaryId}: ${run.result} — ${run.detail}`);
  process.exit(run.result === "caught" ? 0 : 1);
}

const { runs, recall } = await runAllPlanCanaries(deps);
for (const r of runs) console.log(`${r.canaryId}: ${r.result} — ${r.detail}`);
console.log(`plan-canary recall: ${recall}`);
process.exit(runs.every((r) => r.result === "caught") ? 0 : 1);
