import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertContainment, matchesPattern, writeDenySettings } from "../src/containment.js";
import { buildClaudeArgv } from "../src/argv.js";

const tmp = mkdtempSync(join(tmpdir(), "doctrine-contain-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function denyRules(dir: string, doors: string[]): string[] {
  const path = writeDenySettings(join(tmp, dir), { doors });
  return (JSON.parse(readFileSync(path, "utf8")) as { permissions: { deny: string[] } }).permissions.deny;
}

/**
 * Claude Code matches a `Bash(<pattern>)` deny against the whole command string with `*`
 * as the only wildcard. Asserting on the emitted strings proves nothing about behaviour —
 * the previous two versions of these rules both had the strings review asked for and
 * still denied `node transform data/x` — so the tests below assert what the rules DO.
 */
function denies(rules: string[], command: string): boolean {
  return rules.some((rule) => {
    if (!rule.startsWith("Bash(") || !rule.endsWith(")")) return false;
    return matchesPattern(command, rule.slice("Bash(".length, -1));
  });
}

describe("containment — walls, not approvals", () => {
  it("matchesPattern handles wildcards case-insensitively", () => {
    expect(matchesPattern("PROD_DB_URL", "PROD_*")).toBe(true);
    expect(matchesPattern("stripe_secret_key", "STRIPE_SECRET*")).toBe(true);
    expect(matchesPattern("DEV_DB_URL", "PROD_*")).toBe(false);
  });

  it("refuses to start when a door credential is present", () => {
    const check = assertContainment(
      { door_credentials: ["PROD_*", "STRIPE_SECRET*"] },
      { PATH: "/usr/bin", PROD_DB_URL: "postgres://real" },
    );
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.violations.join("\n")).toContain("PROD_DB_URL");
    expect(check.violations.join("\n")).toContain("must never hold door credentials");
  });

  it("a scrubbed environment passes", () => {
    expect(assertContainment({ door_credentials: ["PROD_*"] }, { PATH: "/usr/bin" })).toEqual({ ok: true });
  });

  it("greenfield (no doors): the baseline floor still applies — agents never push/merge/drop", () => {
    const path = writeDenySettings(join(tmp, "a1"), { doors: [] });
    const settings = JSON.parse(readFileSync(path, "utf8")) as { permissions: { deny: string[] } };
    expect(settings.permissions.deny).toContain("Bash(*git push*)");
    expect(settings.permissions.deny).toContain("Bash(*git merge*)");
    expect(settings.permissions.deny).toContain("Bash(*DROP DATABASE*)");
    // ...and no door-shaped rules beyond the floor's own guardrail files.
    expect(settings.permissions.deny.filter((d) => d.startsWith("Edit(") && !d.includes(".doctrine/"))).toEqual([]);
  });

  it("the floor forbids agents editing the loop's own guardrails and ledgers", () => {
    const path = writeDenySettings(join(tmp, "a2"), { doors: [] });
    const settings = JSON.parse(readFileSync(path, "utf8")) as { permissions: { deny: string[] } };
    for (const guarded of ["manifest.json", "claude-deny-settings.json", "directives.md", "pause", "ticks.jsonl", "metrics.jsonl"]) {
      expect(settings.permissions.deny).toContain(`Edit(**/.doctrine/${guarded})`);
      expect(settings.permissions.deny).toContain(`Write(**/.doctrine/${guarded})`);
    }
    // Verdict paths stay writable — the judge writes .doctrine/runs/<id>/verdict.json.
    expect(settings.permissions.deny.some((d) => d.includes(".doctrine/runs"))).toBe(false);
  });

  it("doors EXTEND the floor with Edit/Write/Bash rules, carried on --settings", () => {
    const arena = join(tmp, "a3");
    const path = writeDenySettings(arena, { doors: ["supabase/migrations/**"] });
    const settings = JSON.parse(readFileSync(path, "utf8")) as { permissions: { deny: string[] } };
    expect(settings.permissions.deny).toContain("Edit(supabase/migrations/**)");
    expect(settings.permissions.deny).toContain("Write(supabase/migrations/**)");
    expect(settings.permissions.deny).toContain("Bash(*git push*)"); // floor survives doors

    const argv = buildClaudeArgv({ settingsPath: path });
    expect(argv[argv.indexOf("--settings") + 1]).toBe(path);
  });

  it("a door root is denied as a directory, not only as a path prefix", () => {
    // `data/**` alone matches what is INSIDE data/ and nothing that names data itself,
    // so `rm -rf data` walked through the wall. Found by an external review.
    const deny = denyRules("a4", ["data/**", "private-docs/**"]);
    expect(deny).toContain("Edit(data)");
    expect(deny).toContain("Write(data)");
    // The prefix rule is still there; the root rules extend it, never replace it.
    expect(deny).toContain("Bash(*data/***)");

    for (const command of [
      "rm -rf data",
      "rm data",
      "rm -rf ./data",
      "sudo rm -rf data",
      "cd repo && rm -rf data",
      "mv data /tmp/leak",
      "mv private-docs /tmp/leak",
      "mv ./private-docs /tmp/leak",
    ]) {
      expect(denies(deny, command), `must deny: ${command}`).toBe(true);
    }
  });

  it("the root rules match a complete path component, so ordinary work is untouched", () => {
    // A deny glob has no word boundary, and every looser shape refuses real commands:
    // `Bash(*data*)` denies "database", `Bash(*rm *data*)` denies `rm metadata.json`.
    // Second external review, doctrine#5.
    const deny = denyRules("a5", ["data/**"]);
    expect(deny).not.toContain("Bash(*data*)");

    for (const command of [
      "rm metadata.json",
      "rm src/database.ts",
      "rm -rf test-data",
      "cp test-data.json backup/",
      "grep -r data src/",
      "node scripts/transform.mjs data-fixtures/x.json",
      "npm run seed -- --input testdata.json",
    ]) {
      expect(denies(deny, command), `must allow: ${command}`).toBe(false);
    }
  });

  it("a glob with no directory root gains no root rules", () => {
    const path = writeDenySettings(join(tmp, "a6"), { doors: [".env*", "src/**/secrets/**"] });
    const deny = (JSON.parse(readFileSync(path, "utf8")) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).toContain("Edit(.env*)");
    expect(deny.some((d) => d === "Edit(.env)")).toBe(false);
    // "src/**/secrets" still holds a wildcard — not a root we can name, so the glob's own
    // rules are emitted and no root rule is.
    expect(deny).toContain("Edit(src/**/secrets/**)");
    expect(deny.some((d) => d === "Edit(src/**/secrets)")).toBe(false);
    expect(deny.some((d) => d.startsWith("Bash(rm *src/"))).toBe(false);
  });
});
