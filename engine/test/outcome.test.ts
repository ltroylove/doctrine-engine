import { describe, expect, it } from "vitest";
import { FAILURE_REASONS, isFailureReason } from "../src/outcome.js";

describe("RunFailureReason closed set", () => {
  it("is exactly the agreed terminal set — adding a member must force this test to change", () => {
    expect([...FAILURE_REASONS].sort()).toEqual(
      [
        "spawn-failed",
        "nonzero-exit",
        "timed-out",
        "budget-truncated",
        "missing-verdict",
        "malformed-verdict",
        "no-commit", // an implementer that ran but committed nothing
      ].sort(),
    );
  });

  it("guards membership", () => {
    expect(isFailureReason("timed-out")).toBe(true);
    expect(isFailureReason("looks-fine-to-me")).toBe(false);
  });
});
