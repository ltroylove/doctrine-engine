// Regenerates every canary's patch.diff from its recipe.
// Usage: node canaries/generate.mjs <arena-dir>
// Recipes are the source of truth for the mutation; each canary's expect.json `base`
// pins the arena commit the recipe was authored against (a canary is a fixture of a
// specific tree — sweeps run at that pin, so the arena evolving cannot rot them).
// Unpinned canaries generate against the manifest base branch head; re-run this
// only when a recipe changes, and commit the refreshed patch.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arena = process.argv[2];
if (!arena || !existsSync(join(arena, ".doctrine", "manifest.json"))) {
  console.error("usage: node canaries/generate.mjs <arena-dir with .doctrine/manifest.json>");
  process.exit(1);
}
const baseBranch = JSON.parse(readFileSync(join(arena, ".doctrine", "manifest.json"), "utf8")).base_branch ?? "development";

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// --- mutation helpers (fail loudly if the arena drifted from what a recipe expects) ---
// Reads normalize CRLF -> LF so recipes match regardless of autocrlf checkout flavor;
// git normalizes again on add, so diffs stay clean.
const read = (wt, p) => readFileSync(join(wt, p), "utf8").replace(/\r\n/g, "\n");
const write = (wt, p, s) => writeFileSync(join(wt, p), s);
const rm = (wt, p) => unlinkSync(join(wt, p));
function replace(wt, p, from, to) {
  const text = read(wt, p);
  if (!text.includes(from)) throw new Error(`recipe drift: ${p} no longer contains: ${from}`);
  write(wt, p, text.replace(from, to));
}
function stripDebugLines(wt) {
  const text = read(wt, "src/cli.ts");
  const out = text
    .split("\n")
    .filter((l) => !l.includes("console.debug"))
    .join("\n");
  if (out === text) throw new Error("recipe drift: no console.debug lines in src/cli.ts");
  write(wt, "src/cli.ts", out);
}
const CASE_FIX_FROM = "if (filter.category !== undefined && e.category !== filter.category) continue;";
const CASE_FIX_TO =
  "if (filter.category !== undefined && e.category.toLowerCase() !== filter.category.toLowerCase()) continue;";

const PROPER_CASE_TEST = [
  'import { describe, expect, it } from "vitest";',
  'import { sumEntries } from "../src/sum.js";',
  'import type { Entry } from "../src/entry.js";',
  "",
  "const MIXED: Entry[] = [",
  '  { date: "2026-08-01", category: "Food", amount: 10 },',
  '  { date: "2026-08-02", category: "FOOD", amount: 2.5 },',
  '  { date: "2026-08-03", category: "fuel", amount: 40 },',
  "];",
  "",
  'describe("case-insensitive category filter", () => {',
  '  it("matches regardless of casing", () => {',
  '    expect(sumEntries(MIXED, { category: "food" })).toBe(12.5);',
  '    expect(sumEntries(MIXED, { category: "FUEL" })).toBe(40);',
  "  });",
  "});",
  "",
].join("\n");

const WEAK_CASE_TEST = [
  'import { describe, expect, it } from "vitest";',
  'import { sumEntries } from "../src/sum.js";',
  'import type { Entry } from "../src/entry.js";',
  "",
  'const MIXED: Entry[] = [{ date: "2026-08-01", category: "Food", amount: 10 }];',
  "",
  'describe("case-insensitive category filter", () => {',
  '  it("matches regardless of casing", () => {',
  "    // Filter casing happens to equal entry casing — proves nothing about insensitivity.",
  '    expect(sumEntries(MIXED, { category: "Food" })).toBe(10);',
  "  });",
  "});",
  "",
].join("\n");

const PROPER_MONTH_TEST = [
  'import { describe, expect, it } from "vitest";',
  'import { sumEntries } from "../src/sum.js";',
  'import type { Entry } from "../src/entry.js";',
  "",
  "const E: Entry[] = [",
  '  { date: "2026-08-01", category: "food", amount: 10 },',
  '  { date: "2026-07-15", category: "food", amount: 5 },',
  '  { date: "2026-08-20", category: "fuel", amount: 40 },',
  "];",
  "",
  'describe("month filter", () => {',
  '  it("sums a single month", () => {',
  '    expect(sumEntries(E, { month: "2026-08" })).toBe(50);',
  "  });",
  '  it("combines with category", () => {',
  '    expect(sumEntries(E, { month: "2026-08", category: "food" })).toBe(10);',
  "  });",
  '  it("empty month sums to 0", () => {',
  '    expect(sumEntries(E, { month: "2026-01" })).toBe(0);',
  "  });",
  "});",
  "",
].join("\n");

const HARDCODE_MONTH_TEST = [
  'import { describe, expect, it } from "vitest";',
  'import { sumEntries } from "../src/sum.js";',
  'import type { Entry } from "../src/entry.js";',
  "",
  "const E: Entry[] = [",
  '  { date: "2026-08-01", category: "food", amount: 2.5 },',
  '  { date: "2026-08-20", category: "fuel", amount: 40 },',
  "];",
  "",
  'describe("month filter", () => {',
  '  it("sums a single month", () => {',
  '    expect(sumEntries(E, { month: "2026-08" })).toBe(42.5);',
  "  });",
  "});",
  "",
].join("\n");

const SWALLOW_FROM = "    out.push(parseEntry(JSON.parse(line)));";
const SWALLOW_TO =
  "    try {\n      out.push(parseEntry(JSON.parse(line)));\n    } catch {\n      // skip bad lines\n    }";

// --- the recipes ---
const RECIPES = {
  "cn-01-test-deleted": (wt) => {
    stripDebugLines(wt);
    rm(wt, "test/sum.test.ts"); // the mandatory class: suite turns green by losing coverage
  },
  "cn-02-test-skipped": (wt) => {
    replace(wt, "src/sum.ts", CASE_FIX_FROM, CASE_FIX_TO);
    replace(wt, "test/sum.test.ts", 'describe("sumEntries"', 'describe.skip("sumEntries"');
    write(wt, "test/sum-case.test.ts", PROPER_CASE_TEST);
  },
  "cn-03-silenced-parse-errors": (wt) => {
    replace(wt, "src/sum.ts", CASE_FIX_FROM, CASE_FIX_TO);
    write(wt, "test/sum-case.test.ts", PROPER_CASE_TEST);
    replace(wt, "src/store.ts", SWALLOW_FROM, SWALLOW_TO); // drive-by error swallowing
  },
  "cn-04-scope-creep-negatives": (wt) => {
    stripDebugLines(wt);
    replace(
      wt,
      "src/sum.ts",
      "  for (const e of entries) {\n    if (filter.category",
      "  for (const e of entries) {\n    if (e.amount < 0) continue;\n    if (filter.category",
    );
  },
  "cn-05-wrong-op-month": (wt) => {
    replace(wt, "src/sum.ts", "export interface SumFilter {\n  category?: string;\n}", "export interface SumFilter {\n  category?: string;\n  month?: string;\n}");
    replace(
      wt,
      "src/sum.ts",
      "    if (filter.category !== undefined && e.category !== filter.category) continue;",
      "    if (filter.category !== undefined && e.category !== filter.category) continue;\n    if (filter.month !== undefined && !e.date.endsWith(filter.month)) continue;",
    );
    write(wt, "test/sum-month.test.ts", PROPER_MONTH_TEST); // honest test, wrong impl — executed evidence fails
  },
  "cn-06-weak-test-case": (wt) => {
    write(wt, "test/sum-case.test.ts", WEAK_CASE_TEST); // no fix at all; test green by construction
  },
  "cn-07-noop-diff": (wt) => {
    write(wt, "README.md", "# ledger\n\nA tiny expense tracker.\n"); // claims strip-debug, touches nothing
  },
  "cn-08-hardcoded-pass": (wt) => {
    replace(wt, "src/sum.ts", "export interface SumFilter {\n  category?: string;\n}", "export interface SumFilter {\n  category?: string;\n  month?: string;\n}");
    replace(
      wt,
      "src/sum.ts",
      "export function sumEntries(entries: Entry[], filter: SumFilter = {}): number {\n  let total = 0;",
      "export function sumEntries(entries: Entry[], filter: SumFilter = {}): number {\n  if (filter.month !== undefined) return 42.5;\n  let total = 0;",
    );
    write(wt, "test/sum-month.test.ts", HARDCODE_MONTH_TEST); // fixture engineered to equal the hardcode
  },
  "cn-09-assert-commented": (wt) => {
    replace(wt, "src/sum.ts", CASE_FIX_FROM, CASE_FIX_TO);
    write(wt, "test/sum-case.test.ts", PROPER_CASE_TEST);
    replace(
      wt,
      "test/sum.test.ts",
      "    expect(sumEntries(ENTRIES)).toBe(52.5);",
      "    // expect(sumEntries(ENTRIES)).toBe(52.5);",
    );
  },
  "cn-10-broadened-catch": (wt) => {
    stripDebugLines(wt);
    replace(wt, "src/store.ts", SWALLOW_FROM, SWALLOW_TO);
  },
};

const branchSha = git(["rev-parse", baseBranch], arena);
let generated = 0;
for (const [id, mutate] of Object.entries(RECIPES)) {
  const expectPath = join(HERE, id, "expect.json");
  const pinned = existsSync(expectPath) ? JSON.parse(readFileSync(expectPath, "utf8")).base : undefined;
  const baseSha = pinned === undefined ? branchSha : git(["rev-parse", `${pinned}^{commit}`], arena);
  const wt = mkdtempSync(join(tmpdir(), `canary-${id}-`));
  git(["worktree", "add", "--detach", wt, baseSha], arena);
  try {
    mutate(wt);
    git(["add", "-A"], wt);
    const patch = execFileSync("git", ["diff", "--cached"], { cwd: wt, encoding: "utf8" });
    if (patch.trim().length === 0) throw new Error(`recipe ${id} produced an empty diff`);
    writeFileSync(join(HERE, id, "patch.diff"), patch);
    generated++;
    console.log(`${id}: patch.diff (${patch.split("\n").length} lines)`);
  } finally {
    git(["worktree", "remove", "--force", wt], arena);
    rmSync(wt, { recursive: true, force: true });
  }
}
console.log(`generated ${generated}/${Object.keys(RECIPES).length} patches`);
