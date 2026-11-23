import { denyPath } from "./containment.js";
import type { RunGhFn } from "./merge.js";

/**
 * External review as a landing STEP.
 *
 * One question was left deliberately open: whether to wait for bot review before
 * machine-merging. The observation that decided it — machine-merge closed unit PRs
 * in seconds, before the bots fired, so at unit cadence the instrument harvested
 * nothing. The operator's model: the loop opens the PR, waits for the review, fixes
 * what it finds, and merges. The human gate is `development` → `main`, nowhere else.
 *
 * **The law that survives, and the failure it is guarding against.** Review findings
 * go to the IMPLEMENTER, on the unit's own branch, and nowhere else. They never reach
 * the decomposer, the intent, `work/`, or `context/contracts.md`. The failure it
 * guards against: an earlier loop that took PR comments, rewrote its planning documents from
 * them, and then built against the rewritten documents — review feedback became
 * re-planning churn and the original unit was never finished. A finding is a defect in
 * one diff; it is not new scope, and it is not a reason to re-plan. That boundary is
 * enforced by deny rules on the review-fix ACT (`REVIEW_FIX_DENY`), not by asking.
 *
 * Review still never becomes a gate: after `maxRounds` the unit merges regardless,
 * with the unaddressed threads recorded. A reviewer that can block the loop forever
 * is an approver, and Doctrine has none.
 */

export interface ReviewThread {
  /** GraphQL node id — the handle `resolveReviewThread` needs. */
  threadId: string;
  /** REST id of the thread's first comment — the handle a reply needs. */
  commentId: number;
  path: string;
  line: number | null;
  author: string;
  body: string;
  resolved: boolean;
}

export interface OpenPr {
  number: number;
  url: string;
  /** Epoch ms the PR was opened — the review window is measured from here. */
  createdAtMs: number;
}

/**
 * Denied for the review-fix ACT, on top of the baseline floor and the target's doors.
 * This is the mechanical half of "a finding is a defect, never a re-plan": the ACT
 * physically cannot edit the unit that is being reviewed, its intent, or the shared
 * contracts, so it has nowhere to put scope creep except the diff under review.
 *
 * Through the shell as well as through the tools. The first version denied `Edit` and
 * `Write` only, and the review-fix ACT has Bash — so `sed -i work/<unit>.md` walked
 * straight around the entire boundary, which is to say the boundary did not exist.
 * Review caught it on the tracked copy of the very file that was
 * supposed to be the wall.
 */
export const REVIEW_FIX_DENY: readonly string[] = [
  ...denyPath("work/"),
  ...denyPath("context/contracts.md"),
  ...denyPath("docs/program/"),
];

/**
 * A lookup either answered or it did not. Collapsing the two is how "gh timed out"
 * becomes "there is no PR, so it must have merged" — which then deletes the branch and
 * marks the unit settled. Every lookup below is explicit about which happened, and the
 * review rung retries on `looked: false` rather than acting on it.
 */
export type Lookup<T> = { looked: true; value: T } | { looked: false; error: string };

function ghJson<T>(gh: RunGhFn, args: string[], cwd: string, emptyValue: T): Lookup<T> {
  let out: string;
  try {
    out = gh(args, cwd);
  } catch (e) {
    return { looked: false, error: e instanceof Error ? e.message.split(/\r?\n/)[0]! : String(e) };
  }
  if (out.trim().length === 0) return { looked: true, value: emptyValue };
  try {
    return { looked: true, value: JSON.parse(out) as T };
  } catch {
    return { looked: false, error: `gh returned unparseable output for ${args.slice(0, 2).join(" ")}` };
  }
}

/** The open PR for a unit branch. `value: null` means authoritatively none. */
export function findOpenPr(gh: RunGhFn, branch: string, cwd: string): Lookup<OpenPr | null> {
  const rows = ghJson<Array<{ number: number; url: string; createdAt: string }>>(
    gh,
    ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url,createdAt", "--limit", "1"],
    cwd,
    [],
  );
  if (!rows.looked) return rows;
  const row = rows.value[0];
  if (row === undefined) return { looked: true, value: null };
  const ms = Date.parse(row.createdAt);
  return { looked: true, value: { number: row.number, url: row.url, createdAtMs: Number.isNaN(ms) ? 0 : ms } };
}

/** True once a PR has been open long enough that a bot review would have arrived. */
export function reviewWindowElapsed(pr: OpenPr, nowMs: number, windowMs: number): boolean {
  return nowMs - pr.createdAtMs >= windowMs;
}

const THREADS_QUERY = `
query($owner:String!,$repo:String!,$num:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$num){
      reviewThreads(first:100){
        nodes{
          id
          isResolved
          comments(first:1){ nodes { databaseId path line author { login } body } }
        }
      }
    }
  }
}`;

interface ThreadsResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: Array<{
            id: string;
            isResolved: boolean;
            comments?: { nodes?: Array<{ databaseId: number; path: string; line: number | null; author?: { login?: string }; body: string }> };
          }>;
        };
      };
    };
  };
}

/** `owner/name` for the arena's origin. */
export function repoSlug(gh: RunGhFn, cwd: string): { owner: string; repo: string } | null {
  try {
    const slug = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], cwd).trim();
    const [owner, repo] = slug.split("/");
    return owner !== undefined && repo !== undefined && owner.length > 0 && repo.length > 0 ? { owner, repo } : null;
  } catch {
    return null;
  }
}

/**
 * Every review thread on a PR. Threads the loop itself authored are excluded by
 * `selfLogin` — the engine's own replies are not findings to address, and counting
 * them would make the loop chase its own tail forever.
 */
export function fetchThreads(
  gh: RunGhFn,
  slug: { owner: string; repo: string },
  prNumber: number,
  cwd: string,
  selfLogin?: string,
): Lookup<ReviewThread[]> {
  const res = ghJson<ThreadsResponse>(
    gh,
    ["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-F", `owner=${slug.owner}`, "-F", `repo=${slug.repo}`, "-F", `num=${prNumber}`],
    cwd,
    {},
  );
  if (!res.looked) return res;
  const nodes = res.value.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const out: ReviewThread[] = [];
  for (const node of nodes) {
    const first = node.comments?.nodes?.[0];
    if (first === undefined) continue;
    const author = first.author?.login ?? "";
    if (selfLogin !== undefined && author === selfLogin) continue;
    out.push({
      threadId: node.id,
      commentId: first.databaseId,
      path: first.path,
      line: first.line ?? null,
      author,
      body: first.body,
      resolved: node.isResolved,
    });
  }
  return { looked: true, value: out };
}

export function unresolved(threads: readonly ReviewThread[]): ReviewThread[] {
  return threads.filter((t) => !t.resolved);
}

/** Post a reply into one thread. Best-effort: a failed reply never blocks a merge. */
export function replyToThread(
  gh: RunGhFn,
  slug: { owner: string; repo: string },
  prNumber: number,
  commentId: number,
  body: string,
  cwd: string,
): boolean {
  try {
    gh(["api", `repos/${slug.owner}/${slug.repo}/pulls/${prNumber}/comments/${commentId}/replies`, "-f", `body=${body}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/** Mark one thread resolved. Best-effort, same reason. */
export function resolveThread(gh: RunGhFn, threadId: string, cwd: string): boolean {
  try {
    gh(
      ["api", "graphql", "-f", "query=mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread { isResolved } } }", "-F", `id=${threadId}`],
      cwd,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The findings block handed to the review-fix ACT. Deliberately plain: the finding
 * text, where it points, and the boundary. No plan context, no intent, no contracts —
 * the ACT is fixing a diff, not reconsidering a design.
 */
export function assembleFindings(threads: readonly ReviewThread[]): string {
  return formatThreads(threads)
    .map((f, i) => `${i + 1}. ${f}`)
    .join(String.fromCharCode(10) + String.fromCharCode(10));
}

/**
 * Each thread as ONE finding string, anchored — `path:line — by author`, then the body.
 *
 * The fix pass takes strings rather than threads, because the code-judge's findings go
 * through the same pass and are not threads. Formatting here keeps the anchor a reviewer
 * gave it and keeps `review-fix.ts` from knowing anything about GitHub.
 */
export function formatThreads(threads: readonly ReviewThread[]): string[] {
  return threads.map((t) => `${t.path}${t.line === null ? "" : `:${t.line}`} — by ${t.author}${String.fromCharCode(10)}${t.body.trim()}`);
}
