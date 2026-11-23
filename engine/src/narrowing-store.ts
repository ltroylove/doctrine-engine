import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { engineCommit, stagePaths } from "./git-commit.js";
import { parseNarrowing, type Narrowing, type NarrowingLevel } from "./narrowing.js";

/**
 * Where narrowings live — and the ONLY thing that knows.
 *
 * `narrowing.ts` is pure: it parses a string and does arithmetic over objects.
 * `parseEnvelope` takes a string and a label it only ever puts in messages, and there is
 * a test asserting a file path and an issue URL produce identical results. So everything
 * above this file is already storage-agnostic; this is the seam, and the stated next step
 * is a GitHub-issue implementation of it.
 *
 * **Three operations, and the smallness is the point.** An earlier sketch of this
 * interface had six, including a snapshot/revert pair to undo a refused ACT — which on
 * issues meant compensating closes and a partial-write reconciliation pass. That
 * machinery evaporated once the ACT stopped writing into the store at all: it writes its
 * document into a scratch directory, the engine parses and gates it there, and only an
 * ACCEPTED document is ever published. A refused one is discarded, because it was never
 * anywhere to begin with.
 *
 * That is worth stating plainly, because the revert was the strongest argument against
 * issues as a store and it turned out to be an argument against the ACT's *cwd*.
 *
 * Nothing in an implementation may make a decision. If a method is choosing WHICH
 * narrowing matters rather than fetching or persisting one, the rule is broken and the
 * logic belongs upstairs where it is testable without a filesystem or a network.
 */
export interface NarrowingStore {
  /** Every narrowing at one level. Malformed documents are reported, never dropped. */
  load(level: NarrowingLevel): LoadResult;
  /** Persist an accepted narrowing. Returns the reference a human can follow. */
  publish(doc: Narrowing): string;
  /** Flip `active` to `done`. */
  markDone(doc: Narrowing): void;
}

export interface LoadResult {
  narrowings: Narrowing[];
  /**
   * Documents that did not parse — RETURNED rather than skipped.
   *
   * A narrowing the parser cannot read is invisible to the coverage arithmetic, so
   * dropping it makes its criteria look uncovered and the loop mints a rival to a
   * document that already exists and merely has a typo. Two different problems, two
   * different fixes, and the caller has to be able to tell them apart.
   */
  malformed: string[];
}

const DIRS: Record<NarrowingLevel, string[]> = {
  epic: ["docs", "program", "epics"],
  feature: ["docs", "program", "features"],
};

export function narrowingDir(arenaDir: string, level: NarrowingLevel): string {
  return join(arenaDir, ...DIRS[level]);
}

/** Repo-relative, for pathspecs and messages. Forward slashes: git wants them on Windows too. */
export function narrowingDirRel(level: NarrowingLevel): string {
  return DIRS[level].join("/");
}

/** The store that keeps narrowings as committed files in the target repo. */
export class FileNarrowingStore implements NarrowingStore {
  constructor(private readonly arenaDir: string) {}

  load(level: NarrowingLevel): LoadResult {
    const dir = narrowingDir(this.arenaDir, level);
    if (!existsSync(dir)) return { narrowings: [], malformed: [] };
    const narrowings: Narrowing[] = [];
    const malformed: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
      const rel = `${narrowingDirRel(level)}/${file}`;
      let text: string;
      try {
        text = readFileSync(join(dir, file), "utf8");
      } catch {
        malformed.push(`${rel}: unreadable`);
        continue;
      }
      const res = parseNarrowing(text, rel);
      if (res.ok) narrowings.push(res.narrowing);
      else malformed.push(res.errors.join("; "));
    }
    return { narrowings, malformed };
  }

  publish(doc: Narrowing): string {
    const dirRel = narrowingDirRel(doc.level);
    const rel = `${dirRel}/${doc.id}.md`;
    mkdirSync(narrowingDir(this.arenaDir, doc.level), { recursive: true });
    writeFileSync(join(this.arenaDir, rel), doc.source);
    stagePaths(this.arenaDir, [dirRel]);
    engineCommit(this.arenaDir, `doctrine: ${doc.level} ${doc.id} — ${doc.title}`);
    return rel;
  }

  markDone(doc: Narrowing): void {
    const abs = join(this.arenaDir, doc.path);
    writeFileSync(abs, readFileSync(abs, "utf8").replace(/^status:\s*active/m, "status: done"));
    stagePaths(this.arenaDir, [doc.path]);
    engineCommit(this.arenaDir, `doctrine: ${doc.level} complete — ${doc.id} (${doc.title})`);
  }
}

/**
 * An in-memory store, for tests and for proving the interface is honest.
 *
 * It exists so the 380 offline tests keep running with no filesystem and no network, and
 * so a second implementation exists BEFORE the GitHub one — an interface with exactly one
 * implementation is a shape, not a seam, and the leaks only show up when something else
 * has to fit through it.
 */
export class MemoryNarrowingStore implements NarrowingStore {
  private readonly docs = new Map<string, Narrowing>();
  /** Raw bodies that do not parse, so `malformed` can be exercised. */
  readonly broken: Array<{ level: NarrowingLevel; text: string; ref: string }> = [];

  constructor(seed: readonly Narrowing[] = []) {
    for (const d of seed) this.docs.set(d.id, d);
  }

  load(level: NarrowingLevel): LoadResult {
    const narrowings = [...this.docs.values()].filter((d) => d.level === level).sort((a, b) => a.id.localeCompare(b.id));
    const malformed: string[] = [];
    for (const b of this.broken.filter((x) => x.level === level)) {
      const res = parseNarrowing(b.text, b.ref);
      malformed.push(res.ok ? `${b.ref}: expected malformed` : res.errors.join("; "));
    }
    return { narrowings, malformed };
  }

  publish(doc: Narrowing): string {
    this.docs.set(doc.id, doc);
    return `memory:${doc.level}/${doc.id}`;
  }

  markDone(doc: Narrowing): void {
    const cur = this.docs.get(doc.id);
    if (cur !== undefined) this.docs.set(doc.id, { ...cur, status: "done" });
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * The tripwire, not the mechanism.
 *
 * The ACT writes into a scratch directory outside the repository, so in the normal case
 * it touches nothing here and this returns empty. It stays because `Write` accepts an
 * absolute path: an ACT that reaches into the repo anyway is a containment failure, and
 * one that is silent is worse than one that is loud. `.doctrine/` is skipped because the
 * scheduler writes there around the ACT.
 */
export function repoTouchedBy(arenaDir: string): string[] {
  const touched: string[] = [];
  for (const line of git(arenaDir, ["status", "--porcelain", "-uall"]).split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const m = /^[ MADRCU?!]{1,2}\s+(.+)$/.exec(line);
    if (!m) continue;
    const file = m[1]!.trim().replace(/^"|"$/g, "");
    if (file.startsWith(".doctrine/")) continue;
    touched.push(file);
  }
  return touched;
}

/**
 * Undo an ACT that reached into the repository despite writing to a scratch directory.
 *
 * Only reachable from the tripwire above. `.doctrine/` is excluded from the checkout
 * because `checkout -- .` was silently reverting uncommitted ledger appends, which let
 * the consecutive-failure halt never trip; and the clean is given the exact paths
 * because a clean scoped to one directory once left a stray `src/app.ts` on disk after a
 * run reported as reverted wholesale — a lie the next tick inherits.
 */
export function revertRepo(arenaDir: string, paths: readonly string[]): void {
  git(arenaDir, ["checkout", "--", ".", ":(exclude).doctrine"]);
  const targets = paths.filter((p) => !p.startsWith(".doctrine/"));
  if (targets.length === 0) return;
  try {
    git(arenaDir, ["clean", "-fd", "--", ...targets]);
  } catch {
    git(arenaDir, ["clean", "-fd", "--", "docs"]); // a path git will not accept must not block the revert
  }
}
