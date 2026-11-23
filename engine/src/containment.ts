import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Containment. Two mechanical walls, no approvals:
 *
 * 1. **Credential absence** — the strongest wall. The manifest names env-var
 *    patterns that belong to one-way doors (prod DBs, deploy keys, payment
 *    secrets). The supervisor REFUSES TO START while any are present in its
 *    environment: irreversible actions become impossible, not gated.
 * 2. **Deny rules** — the manifest's door path globs become Claude Code
 *    permission deny rules passed to every agent invocation via --settings.
 */

export interface DoorsManifest {
  /** Path globs that are one-way doors for this target (e.g. "supabase/migrations/**"). */
  doors?: string[];
  /** Env-var name patterns ("*" wildcard) whose presence must abort startup. */
  door_credentials?: string[];
}

export function matchesPattern(name: string, pattern: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return re.test(name);
}

export type ContainmentCheck = { ok: true } | { ok: false; violations: string[] };

/** Refuse-to-start check: no door credential may exist in the loop's environment. */
export function assertContainment(
  manifest: DoorsManifest,
  env: Record<string, string | undefined> = process.env,
): ContainmentCheck {
  const patterns = manifest.door_credentials ?? [];
  const violations: string[] = [];
  for (const name of Object.keys(env)) {
    for (const pattern of patterns) {
      if (matchesPattern(name, pattern)) {
        violations.push(`${name} matches door-credential pattern "${pattern}" — the loop must never hold door credentials; unset it or run the loop in a scrubbed environment`);
      }
    }
  }
  return violations.length > 0 ? { ok: false, violations } : { ok: true };
}

/**
 * The unconditional floor (added 2026-08-13): denied for every agent
 * invocation on every target. Per-target doors EXTEND this; nothing removes it.
 * These are all engine-owned responsibilities or unrecoverable operations — an
 * agent never has a legitimate reason for any of them.
 */
/**
 * Files the loop must never edit: engine-owned steering and ledgers (the manifest-hold
 * rule, restored 2026-08-20). `.doctrine/runs` stays writable —
 * the judge writes verdicts there.
 */
const GUARDED_FILES: readonly string[] = [
  "manifest.json",
  "claude-deny-settings.json",
  "claude-deny-review-fix.json",
  "directives.md",
  "pause",
  "ticks.jsonl",
  "metrics.jsonl",
];

/**
 * Deny a path to the Edit and Write TOOLS, and to a shell that would reach it anyway.
 *
 * Edit/Write denies alone are a wall with a door beside it: every agent that has Bash
 * also has `sed -i`, `> file`, `tee`, `cp` and `rm`. Review caught this on the
 * review-fix profile and it was equally true of the baseline floor,
 * where the manifest — the target's actual containment — was tool-protected only.
 *
 * The Bash forms carry the path-component boundary the door rules learned in
 * doctrine#5: `*work/*` alone would also deny every command naming `framework/` or
 * `network/`, because both contain the substring. Requiring a `/`, a space, or the
 * start of the command in front of it keeps those out.
 */
export function denyPath(path: string): string[] {
  const rules = [
    `Edit(${path})`,
    `Write(${path})`,
    `Bash(${path}*)`,
    `Bash(* ${path}*)`,
    `Bash(*/${path}*)`,
  ];
  // A directory needs its own name denied as well as its contents. Every pattern
  // above requires the trailing slash, so `rm -rf work` and `mv docs/program /tmp/x`
  // name the directory itself and match none of them — the same distinction the door
  // roots already draw, so the same rules.
  if (path.endsWith("/")) {
    const root = path.slice(0, -1);
    rules.push(`Edit(${root})`, `Write(${root})`);
    for (const verb of DIRECTORY_VERBS) rules.push(...rootRules(verb, root));
  }
  return rules;
}

export const BASELINE_DENY: readonly string[] = [
  "Bash(*git push*)", // landing/publishing is the engine's job, never an agent's
  "Bash(*git merge*)", // merging is the engine's job
  "Bash(*git branch -D*)", // branch lifecycle is the engine's job
  "Bash(*rm -rf /*)", // no absolute-path recursive deletes
  "Bash(*DROP DATABASE*)",
  "Bash(*DROP TABLE*)",
  "Bash(*TRUNCATE TABLE*)",
  ...GUARDED_FILES.flatMap((f) => [
    `Edit(**/.doctrine/${f})`,
    `Write(**/.doctrine/${f})`,
    // The shell reaches the same file; the tool denies alone never stopped `sed -i`.
    `Bash(*.doctrine/${f}*)`,
  ]),
];

/**
 * Whole-directory commands a door root must survive. A door declared as `data/**`
 * expands to `Bash(*data/**)`, which matches anything *inside* the directory and
 * nothing that names the directory itself — `rm -rf data` and `mv private-docs
 * /tmp/leak` both slip through (found by external review).
 *
 * A deny glob has only `*`, so there is no word boundary to lean on, and every
 * looser shape refuses ordinary work: `Bash(*data*)` denies "database" and
 * "metadata"; `Bash(*rm *data*)` denies `node transform data/x` (a word ENDING in
 * the verb) and `rm metadata.json` (a word STARTING with the root). A wall that
 * halts legitimate work is a wall that gets removed, so the root is matched only
 * as a **complete path component**, which the four shapes below spell out: the
 * character before it is a space or a `/`, and the character after it is a space
 * or the end of the command.
 *
 * Two verbs, not seven. `rm` and `mv` are what destroy or relocate a directory in
 * place. Copy and archive verbs read a path that is absent from the loop's clone
 * by construction, and copying is not the irreversible act; adding them multiplies
 * the rule count for a threat the first wall already covers.
 */
const DIRECTORY_VERBS: readonly string[] = ["rm", "mv"];

/** `data/**` → `data`; a glob with no `/**` suffix has no separable root. */
function doorRoot(glob: string): string | null {
  if (!glob.endsWith("/**")) return null;
  const root = glob.slice(0, -3);
  return root.length > 0 && !root.includes("*") ? root : null;
}

/**
 * `rm -rf data`, `rm -rf ./data`, `mv data /tmp/x`, `sudo rm -rf data` — and none of
 * `rm metadata.json`, `rm src/database.ts`, `rm -rf test-data`.
 *
 * `${verb}*` (no space) rather than `${verb} *` so a bare `rm data` matches too; the
 * verb is anchored at the start of the command or after a space, never bare, because
 * `*rm` would also match the tail of "transform".
 */
function rootRules(verb: string, root: string): string[] {
  const rules: string[] = [];
  for (const head of [verb, `* ${verb}`]) {
    for (const boundary of [` ${root}`, `/${root}`]) {
      rules.push(`Bash(${head}*${boundary})`, `Bash(${head}*${boundary} *)`);
    }
  }
  return rules;
}

/**
 * Generate the deny-rules settings file for agent invocations: the baseline floor
 * always, plus Edit/Write/Bash denies for each declared door — the mechanical
 * reversibility gate of design principle 5, never prompt wording.
 */
export function writeDenySettings(
  arenaDir: string,
  manifest: DoorsManifest,
  opts?: {
    /** Extra denies for one kind of ACT (e.g. REVIEW_FIX_DENY). Never removes any. */
    extraDeny?: readonly string[];
    /** Distinct file name so a narrower settings file does not clobber the general one. */
    fileName?: string;
  },
): string {
  const deny: string[] = [...BASELINE_DENY];
  for (const glob of manifest.doors ?? []) {
    deny.push(`Edit(${glob})`, `Write(${glob})`, `Bash(*${glob}*)`);
    const root = doorRoot(glob);
    if (root === null) continue;
    // The directory itself: writable as a path, and removable or movable as a whole.
    deny.push(`Edit(${root})`, `Write(${root})`);
    for (const verb of DIRECTORY_VERBS) deny.push(...rootRules(verb, root));
  }
  for (const extra of opts?.extraDeny ?? []) deny.push(extra);
  const dir = join(arenaDir, ".doctrine");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, opts?.fileName ?? "claude-deny-settings.json");
  writeFileSync(path, JSON.stringify({ permissions: { deny } }, null, 2));
  return path;
}
