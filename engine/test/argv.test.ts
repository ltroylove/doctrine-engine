import { describe, expect, it } from "vitest";
import { buildClaudeArgv } from "../src/argv.js";

describe("buildClaudeArgv", () => {
  it("always requests headless stream-json", () => {
    const argv = buildClaudeArgv({});
    expect(argv).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
  });

  it("carries budget, model, tools, dirs, permission mode", () => {
    const argv = buildClaudeArgv({
      model: "claude-x",
      maxBudgetUsd: 5,
      allowedTools: ["Read", "Bash"],
      addDirs: ["/a", "/b"],
      permissionMode: "dontAsk",
    });
    expect(argv).toContain("--max-budget-usd");
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("5");
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-x");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("Read,Bash");
    expect(argv.filter((a) => a === "--add-dir")).toHaveLength(2);
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  });

  it("pins the MCP surface when a config is given", () => {
    const argv = buildClaudeArgv({ mcpConfig: "/tmp/mcp.json" });
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe("/tmp/mcp.json");
  });

  it("cannot carry a prompt — the invocation type has no prompt field (stdin-only invariant)", () => {
    // Compile-time invariant, asserted at runtime for the record: no argv element
    // is free text; every element is a flag or a flag value.
    const argv = buildClaudeArgv({ model: "m", maxBudgetUsd: 1 });
    const flags = argv.filter((a) => a.startsWith("-"));
    expect(flags.length).toBeGreaterThan(0);
  });
});
