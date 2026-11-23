/**
 * Parsing of `claude -p --output-format stream-json` output.
 * Tolerant of malformed/partial lines: only well-formed JSON lines are considered,
 * and the LAST message with type "result" wins.
 */

export interface ResultMessage {
  type: "result";
  subtype: string;
  is_error?: boolean;
  total_cost_usd?: number;
  /** Set by the CLI when the run died on an API error (e.g. 529 Overloaded). */
  api_error_status?: number;
  result?: string;
  /** Tool calls the permission layer refused during the run. Set by the CLI. */
  permission_denials?: Array<{ tool_name?: string; tool_input?: { file_path?: string; command?: string } }>;
}

/**
 * What the permission layer refused, one line each. A run that wrote nothing because its
 * writes were DENIED has not answered "nothing to add"; it has not answered at all. Reading
 * its silence as an empty answer is how the scaffold-gap ratchet recorded seven correct
 * diagnoses as "nothing more to slice" and retired itself on each.
 */
export function deniedTools(msg: ResultMessage | null): string[] {
  return (msg?.permission_denials ?? []).map((d) =>
    `${d.tool_name ?? "tool"} denied${d.tool_input?.file_path !== undefined ? `: ${d.tool_input.file_path}` : d.tool_input?.command !== undefined ? `: ${d.tool_input.command}` : ""}`);
}

/** Subtypes that mean the run was cut off by a limit. Truncation is failure — never
 *  trust output by artifact-presence alone. */
export const TRUNCATION_SUBTYPES: readonly string[] = [
  "error_max_budget_usd",
  "error_max_turns",
  "error_max_tokens",
];

export function parseResultMessage(stdout: string): ResultMessage | null {
  let last: ResultMessage | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // partial or malformed line — skip, never throw
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === "result" &&
      typeof (parsed as { subtype?: unknown }).subtype === "string"
    ) {
      last = parsed as ResultMessage;
    }
  }
  return last;
}

export function isTruncated(msg: ResultMessage): boolean {
  return TRUNCATION_SUBTYPES.includes(msg.subtype);
}

/**
 * An OUTAGE: the model never ran — the run died on an API-side error having spent
 * nothing. Distinct from a real failure: it must not burn a unit attempt, must not
 * trip the consecutive-failures halt, and warrants backoff-and-retry (the
 * spend gate refuses to charge a budget for a $0 API outage).
 */
export function isOutage(msg: ResultMessage): boolean {
  return msg.api_error_status !== undefined && (msg.total_cost_usd ?? 0) === 0;
}
