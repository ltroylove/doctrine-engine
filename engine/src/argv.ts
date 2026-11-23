/**
 * Builds the argv for a `claude -p` invocation.
 * The prompt is deliberately NOT representable here — it travels over stdin only
 * (no argv injection, no shell). This function not accepting a prompt is the seam's invariant.
 */

export interface AgentInvocation {
  model?: string;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  addDirs?: string[];
  permissionMode?: string;
  /** Path to an MCP config; when set, --strict-mcp-config pins the tool surface to it. */
  mcpConfig?: string;
  /** Settings file carrying permission deny rules (the mechanical one-way-door gate). */
  settingsPath?: string;
}

export function buildClaudeArgv(inv: AgentInvocation): string[] {
  const argv = ["-p", "--output-format", "stream-json", "--verbose"];
  if (inv.model !== undefined) argv.push("--model", inv.model);
  if (inv.maxBudgetUsd !== undefined) argv.push("--max-budget-usd", String(inv.maxBudgetUsd));
  if (inv.allowedTools !== undefined && inv.allowedTools.length > 0) {
    argv.push("--allowedTools", inv.allowedTools.join(","));
  }
  for (const dir of inv.addDirs ?? []) argv.push("--add-dir", dir);
  if (inv.permissionMode !== undefined) argv.push("--permission-mode", inv.permissionMode);
  if (inv.mcpConfig !== undefined) argv.push("--strict-mcp-config", "--mcp-config", inv.mcpConfig);
  if (inv.settingsPath !== undefined) argv.push("--settings", inv.settingsPath);
  return argv;
}
