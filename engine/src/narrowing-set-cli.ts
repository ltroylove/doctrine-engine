import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCriteria } from "./coverage.js";
import { engineCommit, stagePaths } from "./git-commit.js";
import { FileNarrowingStore, narrowingDirRel } from "./narrowing-store.js";
import { crossEpicCandidates, reviewableSets } from "./narrowing-set.js";
import { reviewedHash, runSetJudge, writeSetReport, type SetJudgeRun } from "./narrowing-set-act.js";

// usage:
//   pnpm coherence <arena-dir>            free arithmetic AND the paid set judge
//   pnpm coherence <arena-dir> --free     arithmetic only, no spawn, no spend
//
// The sweep the loop runs as a gate, exposed so the operator can run it on demand — one
// implementation, two callers. Exit code 1 when anything BLOCKS; the advisory half never
// changes it, because an advisory finding that fails a command is a gate wearing a
// different hat.
const HERE = dirname(fileURLToPath(import.meta.url));
const DOCTRINE_ROOT = resolve(HERE, "..", "..");

const args = process.argv.slice(2);
const arenaArg = args.find((a) => !a.startsWith("--"));
const freeOnly = args.includes("--free");
if (arenaArg === undefined) {
  console.error("usage: pnpm coherence <arena-dir> [--free]");
  process.exit(2);
}
const arenaDir = resolve(arenaArg);
const manifest = JSON.parse(readFileSync(join(arenaDir, ".doctrine", "manifest.json"), "utf8")) as {
  program: { prd: string; arch: string };
};

const store = new FileNarrowingStore(arenaDir);
const epicsLoaded = store.load("epic");
const featuresLoaded = store.load("feature");
const malformed = [...epicsLoaded.malformed, ...featuresLoaded.malformed];
if (malformed.length > 0) {
  // A document that does not parse is invisible to the arithmetic, so a set containing one
  // would be reviewed as though it were not there — and reported clean.
  console.error("REFUSING — these do not parse, so no set containing them can be reviewed:");
  for (const m of malformed) console.error(`  - ${m}`);
  process.exit(2);
}

const criteria = parseCriteria(readFileSync(join(arenaDir, manifest.program.prd), "utf8"));
const epics = epicsLoaded.narrowings;
const features = featuresLoaded.narrowings;

// Which sets are reviewable — the SAME rule the dispatch hook runs, read from one place.
// Deciding it here as well is how this command came to review "every feature in the
// program" while the program still had criteria no epic claimed.
const reviews = reviewableSets(criteria, epics, features).map((r) => ({
  review: r.review,
  docs: r.docs,
  parent: r.parentIsProgram
    ? { label: "the PRD and the ARCH", paths: [join(arenaDir, manifest.program.prd), join(arenaDir, manifest.program.arch)] }
    : {
      label: r.parents.length === 1 ? `epic ${r.parents[0]!.id}` : `all ${r.parents.length} epics`,
      paths: r.parents.map((e) => join(arenaDir, e.path)),
    },
}));

for (const e of epics) {
  const mine = features.filter((f) => f.parent === e.id);
  if (mine.length > 0 && !reviews.some((r) => r.review.epicId === e.id)) {
    const taken = new Set(mine.flatMap((f) => f.delivers));
    console.log(`${e.id}: feature set incomplete (${taken.size}/${e.delivers.length}) — not reviewable yet`);
  }
}
if (!reviews.some((r) => r.review.scope === "epics")) {
  const claimed = new Set(epics.flatMap((e) => e.delivers));
  console.log(`epic set: incomplete (${claimed.size}/${criteria.criteria.length} criteria claimed) — not reviewable yet`);
}

let blocked = false;
for (const { review, docs, parent } of reviews) {
  const name = review.scope === "epics" ? "epic set" : review.scope === "all-features" ? "every feature" : `features of ${review.epicId}`;
  const already = reviewedHash(arenaDir, review);
  const fresh = already === review.hash;

  for (const p of review.problems) console.log(`  BLOCKING  ${p}`);
  if (review.problems.length > 0) blocked = true;

  let judge: SetJudgeRun | null = null;
  if (freeOnly) {
    console.log(`${name}: ${review.problems.length} blocking, arithmetic only (--free)`);
  } else if (fresh) {
    // Already reviewed at this exact prose. Re-spawning would buy a second opinion on an
    // unchanged set, which is the unbounded-re-judge shape every other rung removed.
    //
    // And the report is LEFT ALONE. Rewriting it here with `judge = null` stamped
    // `hash: none` over a good report and threw away its findings — so the next run
    // called the unchanged set stale and bought the judge again, every time. A cache
    // that destroys itself on read, and the skip is what it was protecting. External
    // review, PR #81.
    console.log(`${name}: unchanged since the last review (hash ${review.hash}) — judge not re-run, report left as it is`);
    continue;
  } else {
    const runDir = join(arenaDir, ".doctrine", "runs", `set-${review.level}-${Date.now()}`);
    judge = await runSetJudge(
      {
        arenaDir,
        agentDefinitionPath: join(DOCTRINE_ROOT, ".claude", "agents", "narrowing-set-judge.md"),
        documentPaths: docs.map((d) => join(arenaDir, d.path)),
        totalChars: docs.reduce((n, d) => n + d.source.length, 0),
        ...(review.scope === "all-features" ? { candidates: crossEpicCandidates(epics, features) } : {}),
        parent,
        verdictPath: join(runDir, "verdict.json"),
        logPath: join(runDir, "set-judge.log"),
        budgetUsd: 15,
      },
      review,
    );
    const spend = judge.spendUsd.toFixed(2);
    if (judge.ok) {
      console.log(`${name}: ${review.problems.length} blocking, ${judge.findings.length} advisory ($${spend})`);
      for (const f of judge.findings) console.log(`  advisory  ${f.documents.join(" / ")}${f.documents.length > 0 ? " — " : ""}${f.text.split("\n")[0]}`);
    } else {
      console.log(`${name}: ${review.problems.length} blocking, judge could not report ($${spend})`);
      for (const p of judge.problems) console.log(`  !  ${p}`);
    }
  }

  // Committed, not merely written. The report IS the idempotence key, so a report that
  // is only a working-tree file disappears on a fresh clone or a `git clean` and the paid
  // judge is bought again — the artifact-derived claim undone by the one artifact it
  // rests on. The dispatch hook commits it for the same reason; this is the same rule
  // reaching its other caller. External review, PR #81.
  const rel = writeSetReport(arenaDir, review, judge);
  stagePaths(arenaDir, [rel]);
  engineCommit(arenaDir, `doctrine: set-coherence report for ${name}`);
  console.log(`  report: ${rel} (committed)`);
}

if (reviews.length === 0) console.log("no complete set to review");
console.log(`\n${blocked ? "BLOCKED — a complete set is wrong in a way no further planning fixes" : "clean"}`);
console.log(`narrowings read from ${narrowingDirRel("epic")} and ${narrowingDirRel("feature")}`);
process.exit(blocked ? 1 : 0);
