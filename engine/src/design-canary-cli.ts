import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAllDesignCanaries, runDesignCanary, type DesignCanaryDeps } from "./design-canary.js";
import type { DesignBlock } from "./design-judge.js";

// The design-canary sweep: pnpm design-canaries <arena-dir> [canary-id]
//
// Measures the design-judge's recall against seeded defects that all pass the
// conformance gate. Run it before the judge gates anything, after any change to its
// law, and on the standing weekly sweep with the other two harnesses.

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCTRINE_ROOT = resolve(HERE, "..", "..");

const [arenaArg, onlyId] = process.argv.slice(2);
if (arenaArg === undefined) {
  console.error("usage: pnpm design-canaries <arena-dir> [canary-id]");
  process.exit(2);
}
const arenaDir = resolve(arenaArg);
const manifest = JSON.parse(readFileSync(join(arenaDir, ".doctrine", "manifest.json"), "utf8")) as {
  design?: DesignBlock;
  setup?: string;
};
if (manifest.design === undefined) {
  console.error(`${arenaDir} declares no "design" block — nothing to calibrate against`);
  process.exit(2);
}

const deps: DesignCanaryDeps = {
  arenaDir,
  canariesDir: join(DOCTRINE_ROOT, "design-canaries"),
  runsDir: join(arenaDir, ".doctrine", "design-canary-runs"),
  agentDefinitionPath: join(DOCTRINE_ROOT, ".claude", "agents", "design-judge.md"),
  design: manifest.design,
  budgetUsd: 4,
  ...(manifest.setup !== undefined ? { setup: manifest.setup } : {}),
};

if (onlyId !== undefined) {
  const run = await runDesignCanary(onlyId, deps);
  console.log(`${run.canaryId}: ${run.result} — ${run.detail} ($${run.spendUsd.toFixed(2)})`);
  process.exit(run.result === "caught" ? 0 : 1);
}

const { runs, recall } = await runAllDesignCanaries(deps);
for (const r of runs) console.log(`${r.canaryId}: ${r.result} — ${r.detail} ($${r.spendUsd.toFixed(2)})`);
const spend = runs.reduce((a, r) => a + r.spendUsd, 0);
console.log(`\ndesign-judge recall: ${recall} (control counted separately) — $${spend.toFixed(2)}`);
const clean = runs.every((r) => r.result === "caught");
process.exit(clean ? 0 : 1);
