import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertContainment } from "./containment.js";
import { supervise } from "./supervisor.js";

// The production entry point: pnpm loop <arena-dir> [maxTicks]
// Startup is gated by the containment assertion — the loop REFUSES TO START while
// any door credential is present in its environment.
const HERE = dirname(fileURLToPath(import.meta.url));
const DOCTRINE_ROOT = resolve(HERE, "..", "..");

const [arenaArg, maxTicksArg] = process.argv.slice(2);
if (arenaArg === undefined) {
  console.error("usage: pnpm loop <arena-dir> [maxTicks]");
  process.exit(2);
}
const arenaDir = resolve(arenaArg);
const manifest = JSON.parse(readFileSync(join(arenaDir, ".doctrine", "manifest.json"), "utf8")) as Record<string, unknown>;

const containment = assertContainment(manifest);
if (!containment.ok) {
  console.error("REFUSING TO START — containment violations:");
  for (const v of containment.violations) console.error(`  - ${v}`);
  process.exit(1);
}

let results;
try {
  results = await supervise(
  {
    arenaDir,
    agentDefs: {
      implementer: join(DOCTRINE_ROOT, ".claude", "agents", "implementer.md"),
      judge: join(DOCTRINE_ROOT, ".claude", "agents", "code-judge.md"),
      decomposer: join(DOCTRINE_ROOT, ".claude", "agents", "decomposer.md"),
      planJudge: join(DOCTRINE_ROOT, ".claude", "agents", "plan-judge.md"),
      reviewFixer: join(DOCTRINE_ROOT, ".claude", "agents", "review-fixer.md"),
      unitFixer: join(DOCTRINE_ROOT, ".claude", "agents", "unit-fixer.md"),
      narrowingDecomposer: join(DOCTRINE_ROOT, ".claude", "agents", "narrowing-decomposer.md"),
      narrowingJudge: join(DOCTRINE_ROOT, ".claude", "agents", "narrowing-judge.md"),
      narrowingSetJudge: join(DOCTRINE_ROOT, ".claude", "agents", "narrowing-set-judge.md"),
      narrowingFixer: join(DOCTRINE_ROOT, ".claude", "agents", "narrowing-fixer.md"),
      intentFixer: join(DOCTRINE_ROOT, ".claude", "agents", "intent-fixer.md"),
      ticketTriager: join(DOCTRINE_ROOT, ".claude", "agents", "ticket-triager.md"),
      ticketJudge: join(DOCTRINE_ROOT, ".claude", "agents", "ticket-judge.md"),
      ticketFixer: join(DOCTRINE_ROOT, ".claude", "agents", "ticket-fixer.md"),
      programDecomposer: join(DOCTRINE_ROOT, ".claude", "agents", "program-decomposer.md"),
      programJudge: join(DOCTRINE_ROOT, ".claude", "agents", "program-judge.md"),
      designJudge: join(DOCTRINE_ROOT, ".claude", "agents", "design-judge.md"),
      // The three-rung ladder's two ACTs (ADR-0001, ADR-0003). Both rungs stay off
      // without a law, so wiring them here is what turns them on — and both are inert
      // until cutover for a reason that has nothing to do with this list: no unit
      // anywhere holds `status: scaffold`, and no feature has children.
      buildOut: join(DOCTRINE_ROOT, ".claude", "agents", "build-out.md"),
      scaffoldGap: join(DOCTRINE_ROOT, ".claude", "agents", "scaffold-gap.md"),
    },
  },
  {
    ...(maxTicksArg !== undefined ? { maxTicks: Number(maxTicksArg) } : {}),
    onTick: (r) => console.log(`[tick] ${r.decision}${r.unit ? ` ${r.unit}` : ""}${r.detail ? ` — ${r.detail}` : ""}`),
  },
);
} catch (e) {
  // A supervisor that gives up must not look like one that finished. The pause file
  // records why for the next tick; this makes the PROCESS say so, so a wrapper, a
  // scheduler or a person reading an exit code sees a failure rather than a clean stop.
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
console.log(`supervisor stopped after ${results.length} tick(s)`);
