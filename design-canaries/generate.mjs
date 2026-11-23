#!/usr/bin/env node
// Build every design canary's patch against the arena's current UI.
//
//   node design-canaries/generate.mjs [arenaDir]
//
// Each canary is one seeded design defect: a change that PASSES the conformance gate
// and the test suite, and that a person would call wrong on sight. That combination is
// the point — anything the gate already catches needs no judge, so a canary that fails
// `npm run design` is measuring the wrong instrument and is rejected here.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARENA = resolve(process.argv[2] ?? "../doctrine-arena");

const APP = "src/web/public/css/app.css";
const RENDER = "src/web/render.ts";

/**
 * `edit` receives the file's current text and returns the seeded version. Keep each one
 * to a single defect: a canary that seeds three things cannot tell you which one the
 * judge saw.
 */
const CANARIES = [
  {
    id: "dc-01-centred-everything",
    file: APP,
    must_flag: ["centred", "centered"],
    why: "Body text and table content centred because it looked balanced. Every value is on-token; nothing lines up down the column.",
    edit: (t) => t.replace(
      ".entries td {\n  padding: var(--space-3) var(--space-4);",
      ".entries td {\n  text-align: center;\n  padding: var(--space-3) var(--space-4);",
    ),
  },
  {
    id: "dc-02-emoji-headings",
    file: RENDER,
    must_flag: ["emoji"],
    why: "Emoji used as section markers in the totals labels — decorative, untranslatable, and not in the contract.",
    edit: (t) => t
      .replace('<span class="total-label">In</span>', '<span class="total-label">💰 In</span>')
      .replace('<span class="total-label">Out</span>', '<span class="total-label">💸 Out</span>')
      .replace('<span class="total-label">Net</span>', '<span class="total-label">📊 Net</span>'),
  },
  {
    id: "dc-03-off-scale-spacing",
    file: APP,
    must_flag: ["spacing-off-scale", "off-scale", "off scale", "spacing-inconsistent"],
    why: "Card padding moved off the space scale by a few pixels via a calc, so the gate's literal rule does not fire and the three cards no longer share an inset with the table.",
    edit: (t) => t.replace(
      ".total {\n  flex: 1;\n  background: var(--color-surface);\n  border: var(--line) solid var(--color-border);\n  border-radius: var(--radius-card);\n  padding: var(--space-4);",
      ".total {\n  flex: 1;\n  background: var(--color-surface);\n  border: var(--line) solid var(--color-border);\n  border-radius: var(--radius-card);\n  padding: calc(var(--space-4) + var(--space-1) / 2) calc(var(--space-4) - var(--space-1));",
    ),
  },
  {
    id: "dc-04-equal-weight-cards",
    file: APP,
    must_flag: ["equal-weight", "wall-of-equal", "equal weight"],
    why: "The entry table is restyled as a wall of identical rounded cards, so no row is more important than any other and the columns stop aligning.",
    edit: (t) => t.replace(
      ".entries td {\n  padding: var(--space-3) var(--space-4);\n  border-bottom: var(--line) solid var(--color-border);\n}",
      ".entries td {\n  padding: var(--space-3) var(--space-4);\n  border: var(--line) solid var(--color-border);\n  border-radius: var(--radius-card);\n  display: inline-block;\n  width: 45%;\n}",
    ),
  },
  {
    id: "dc-05-decorative-accent",
    file: APP,
    must_flag: ["decorative-colour", "decorative-color", "decorative"],
    why: "The accent is applied to every tag because a region looked empty — the colour that means 'money in' now means nothing at all.",
    edit: (t) => t.replace(
      ".tag {\n  display: inline-block;\n  padding: var(--space-1) var(--space-2);\n  border-radius: var(--radius-pill);\n  background: var(--color-sunken);\n  color: var(--color-ink-muted);",
      ".tag {\n  display: inline-block;\n  padding: var(--space-1) var(--space-2);\n  border-radius: var(--radius-pill);\n  background: var(--color-accent);\n  color: var(--color-on-accent);",
    ),
  },
  {
    id: "dc-06-silent-empty-state",
    file: RENDER,
    must_flag: ["empty-state", "empty state"],
    why: "The empty state stops saying what is absent or what to do about it, leaving a blank region where a screen should answer a question.",
    edit: (t) => t.replace(
      '`      <p class="empty">No entries in this period.</p>`',
      '`      <p class="empty"></p>`',
    ),
  },
  {
    id: "dc-07-inconsistent-radii",
    file: APP,
    must_flag: ["inconsistent-state", "radius-inconsistent", "inconsistent radi"],
    why: "The same kind of surface gets two different radii on one screen — cards keep the card radius, the table takes the control radius.",
    edit: (t) => t.replace(
      ".entries {\n  width: 100%;\n  border-collapse: collapse;\n  background: var(--color-surface);\n  border: var(--line) solid var(--color-border);\n  border-radius: var(--radius-card);",
      ".entries {\n  width: 100%;\n  border-collapse: collapse;\n  background: var(--color-surface);\n  border: var(--line) solid var(--color-border);\n  border-radius: var(--radius-control);",
    ),
  },
  {
    id: "dc-08-placeholder-content",
    file: RENDER,
    must_flag: ["placeholder"],
    why: "Invented placeholder content that is not in the fixture, rendered as though it were data.",
    edit: (t) => t.replace(
      '<td>${escapeHtml(e.note ?? "")}</td>',
      '<td>${escapeHtml(e.note ?? "Sample note — your data here")}</td>',
    ),
  },
  {
    id: "dc-09-figures-unaligned",
    file: APP,
    // Both halves of the defect `why` describes, because a judge may name either. Until
    // 2026-09-06 this listed only the alignment word-forms, and a judge that named the tabular
    // half — `figures-not-tabular`, "the decimal points do not line up on any vertical" — was
    // scored a miss for describing the seeded defect in this fixture's other words. Widened from
    // `why`, not from what that judge said; the difference is grading the defect versus grading
    // the grader. Keep any alias edit HERE: this file overwrites expect.json wholesale.
    must_flag: [
      "figures-unaligned", "figures-not-aligned", "not-aligned", "unaligned", "alignment",
      "tabular", "do not line up", "not line up",
    ],
    why: "Amounts lose their right alignment and tabular figures, so a column of money no longer reads as a column.",
    edit: (t) => t.replace(
      ".entries .amount {\n  font-family: var(--font-mono);\n  font-size: var(--text-figure-size);\n  text-align: right;\n  white-space: nowrap;\n}",
      ".entries .amount {\n  font-family: var(--font-sans);\n  font-size: var(--text-figure-size);\n  text-align: left;\n  white-space: nowrap;\n}",
    ),
  },
  {
    id: "dc-10-clean-control",
    file: APP,
    must_flag: null, // the control: a real, harmless change. The judge must PASS it.
    why: "A genuine improvement that breaks nothing: the totals row gains the same gap the scale already uses elsewhere. A judge that fails this is not measuring design, it is measuring change.",
    edit: (t) => t.replace(
      ".totals {\n  display: flex;\n  gap: var(--space-3);",
      ".totals {\n  display: flex;\n  gap: var(--space-4);",
    ),
  },
];

function git(args) {
  return execFileSync("git", args, { cwd: ARENA, encoding: "utf8" });
}

const base = git(["rev-parse", "HEAD"]).trim();
let built = 0;
const problems = [];

for (const c of CANARIES) {
  const path = join(ARENA, c.file);
  const original = readFileSync(path, "utf8");
  const seeded = c.edit(original);
  if (seeded === original) {
    problems.push(`${c.id}: edit changed nothing — the anchor text has drifted`);
    continue;
  }

  writeFileSync(path, seeded);
  // A design canary must survive the mechanical gate, or it is measuring that gate.
  let gateOk = true;
  try {
    execFileSync("node", ["scripts/design-conformance.mjs", "src"], { cwd: ARENA, encoding: "utf8", stdio: "pipe" });
  } catch {
    gateOk = false;
  }
  const patch = git(["diff", "--", c.file]);
  writeFileSync(path, original);

  if (!gateOk) {
    problems.push(`${c.id}: the conformance gate catches this — it needs no judge, so it is not a design canary`);
    continue;
  }

  const dir = join(HERE, c.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "patch.diff"), patch);
  writeFileSync(join(dir, "expect.json"), `${JSON.stringify({
    verdict: c.must_flag === null ? "pass" : "fail",
    ...(c.must_flag === null ? {} : { must_flag: c.must_flag }),
    base,
    why: c.why,
  }, null, 2)}\n`);
  built++;
}

for (const p of problems) console.error(p);
console.log(`design-canaries: built ${built}/${CANARIES.length} against ${base.slice(0, 8)}`);
process.exit(problems.length > 0 ? 1 : 0);
