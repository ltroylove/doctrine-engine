/**
 * The closed set of terminal failure reasons for an agent run.
 * Closed-set-asserted-by-test: adding a member forces a test edit (see test/outcome.test.ts).
 */
export const FAILURE_REASONS = [
  "spawn-failed",
  "nonzero-exit",
  "timed-out",
  "budget-truncated",
  "missing-verdict",
  "malformed-verdict",
  "no-commit",
] as const;

export type RunFailureReason = (typeof FAILURE_REASONS)[number];

export function isFailureReason(value: string): value is RunFailureReason {
  return (FAILURE_REASONS as readonly string[]).includes(value);
}
