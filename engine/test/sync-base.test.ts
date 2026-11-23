import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { tick, type TickDeps } from "../src/dispatch.js";
import type { RunGhFn } from "../src/merge.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-sync-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function commit(cwd: string, msg: string): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg], { cwd });
}

/** A clone with a bare origin and one seed commit on `development`. */
function makeClone(name: string): { clone: string; bare: string } {
  const bare = join(tmp, `${name}-origin`);
  mkdirSync(bare, { recursive: true });
  git(bare, ["init", "-q", "--bare", "-b", "development"]);

  const seed = join(tmp, `${name}-seed`);
  mkdirSync(join(seed, ".doctrine"), { recursive: true });
  git(seed, ["init", "-q", "-b", "development"]);
  writeFileSync(join(seed, ".doctrine", "manifest.json"), JSON.stringify({
    name: "t", base_branch: "development", landing: "pr", doors: [],
  }));
  writeFileSync(join(seed, ".gitignore"), ".doctrine/lease/\n.doctrine/runs/\n");
  mkdirSync(join(seed, "work", "intents"), { recursive: true });
  writeFileSync(join(seed, "app.txt"), "v1\n");
  git(seed, ["add", "-A"]);
  commit(seed, "seed");
  git(seed, ["remote", "add", "origin", bare]);
  git(seed, ["push", "-q", "-u", "origin", "development"]);

  const clone = join(tmp, name);
  execFileSync("git", ["clone", "-q", bare, clone], { encoding: "utf8" });
  return { clone, bare };
}

/** Land a commit on origin from somewhere else, as another actor would. */
function advanceOrigin(bare: string, name: string, file: string, body: string): void {
  const other = join(tmp, `${name}-other-${Date.now()}`);
  execFileSync("git", ["clone", "-q", bare, other], { encoding: "utf8" });
  mkdirSync(join(other, file, ".."), { recursive: true });
  writeFileSync(join(other, file), body);
  git(other, ["add", "-A"]);
  commit(other, `other actor: ${file}`);
  git(other, ["push", "-q", "origin", "development"]);
}

const gh: RunGhFn = (args) => (args[0] === "auth" ? "ok" : "");

const deps = (clone: string): TickDeps => ({
  arenaDir: clone,
  agentDefs: { implementer: "i", judge: "j", decomposer: "d", planJudge: "p" },
  runGh: gh,
});

/**
 * The tick's opening order is lease → sync base → steering → budgets. Getting it wrong
 * either wedges the loop on someone else's merge, or lets it spend a tick after an
 * observer has said stop.
 */
describe("the tick syncs the base before it does anything else", () => {
  it("fast-forwards a clone that fell behind, instead of failing the landing probe", async () => {
    const { clone, bare } = makeClone("behind");
    advanceOrigin(bare, "behind", "app.txt", "v2\n");
    // Before: the clone cannot push, which is what reported "push access probe failed".
    expect(() => git(clone, ["push", "--dry-run", "origin", "development"])).toThrow();

    const res = await tick(deps(clone));

    expect(res.decision).not.toBe("no-op-landing-probe");
    expect(git(clone, ["rev-parse", "HEAD"])).toBe(git(clone, ["rev-parse", "origin/development"]));
  }, 60_000);

  it("obeys a pause that arrived in the fetch — steering is read AFTER the sync", async () => {
    // An observer merging `.doctrine/pause` has said stop. Reading steering before the
    // fetch means this tick holds the previous state and spends anyway, which is the
    // one instruction that must never be a tick late.
    const { clone, bare } = makeClone("paused-remotely");
    advanceOrigin(bare, "paused-remotely", ".doctrine/pause", "observer: stop everything\n");

    const res = await tick(deps(clone));

    expect(res.decision).toBe("no-op-paused");
    expect(res.detail).toContain("stop everything");
  }, 60_000);

  it("rebases local bookkeeping onto a moved origin rather than wedging", async () => {
    // A bookkeeping commit whose push failed, plus an origin that has since advanced,
    // is a divergence: --ff-only aborts, and swallowing that leaves every later push
    // and probe failing non-fast-forward forever.
    const { clone, bare } = makeClone("diverged");
    writeFileSync(join(clone, "context-note.md"), "engine bookkeeping\n");
    git(clone, ["add", "-A"]);
    commit(clone, "doctrine: bookkeeping that never reached origin");
    advanceOrigin(bare, "diverged", "other.txt", "elsewhere\n");

    const res = await tick(deps(clone));

    expect(res.decision).not.toBe("no-op-diverged");
    // Ours survived, theirs arrived, and origin has both.
    expect(git(clone, ["log", "--oneline", "-3"])).toContain("bookkeeping that never reached origin");
    expect(git(clone, ["cat-file", "-e", "HEAD:other.txt"])).toBe("");
    expect(git(clone, ["rev-list", "--count", "origin/development..development"])).toBe("0");
  }, 60_000);
});
