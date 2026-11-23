import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAllCanaries, runCanary } from "./canary.js";

// Usage:
//   pnpm canaries <arena-dir>            run all canaries
//   pnpm canaries <arena-dir> <canary>   run one canary
const HERE = dirname(fileURLToPath(import.meta.url));
const DOCTRINE_ROOT = resolve(HERE, "..", "..");

const [arenaArg, onlyId] = process.argv.slice(2);
if (arenaArg === undefined) {
  console.error("usage: pnpm canaries <arena-dir> [canary-id]");
  process.exit(2);
}

const deps = {
  arenaDir: resolve(arenaArg),
  canariesDir: join(DOCTRINE_ROOT, "canaries"),
  runsDir: join(resolve(arenaArg), ".doctrine", "canary-runs"),
  agentDefinitionPath: join(DOCTRINE_ROOT, ".claude", "agents", "code-judge.md"),
  budgetUsd: 3,
};

if (onlyId !== undefined) {
  const run = await runCanary(onlyId, deps);
  console.log(`${run.canaryId}: ${run.result} — ${run.detail}`);
  process.exit(run.result === "caught" ? 0 : 1);
}

const { runs, recall } = await runAllCanaries(deps);
for (const r of runs) console.log(`${r.canaryId}: ${r.result} — ${r.detail}`);
console.log(`\ncanary recall: ${recall}`);
const errors = runs.filter((r) => r.result === "error").length;
if (errors > 0) console.log(`(${errors} judge-run errors — fix the harness before reading recall)`);
