import { readFileSync } from "node:fs";
import type { WorkUnit } from "./work-unit.js";

/** A newline; a literal one in this file has been mangled by shell edits. */
const LF = String.fromCharCode(10);

/**
 * The verdict record — what the code-judge writes and the engine validates.
 * Gate honesty is enforced HERE, in engine code, not in the judge's goodwill:
 * - `judged: false` is unrepresentable: anything but `judged === true` is malformed.
 * - every evidence claim requires an executed run block (exit code + output hash + log) —
 *   assertion is not evidence.
 * - a merge needs positive proof each required gate executed (`gates_executed`),
 *   never absence-of-failure.
 * - a "pass" with a failing entry is malformed — dishonest by construction.
 */

export interface EvidenceRun {
  command: string;
  exit_code: number;
  output_sha256: string;
  log: string;
}

export interface EvidenceResult {
  /** Must equal the unit's evidence `run` (matched by position). */
  spec: string;
  run: EvidenceRun;
  ok: boolean;
}

export interface CoherenceResult {
  criterion: string;
  ok: boolean;
  /** Quote-or-it-didn't-happen: a passing coherence criterion must quote the artifact. */
  quote?: string;
}

export interface Verdict {
  unit: string;
  verdict: "pass" | "fail" | "escalate";
  judged: true;
  coherence: CoherenceResult[];
  evidence: EvidenceResult[];
  gates_executed: string[];
  base_sha: string;
  head_sha: string;
  spend_usd: number;
  /**
   * Why the judge refused to rule, on an `escalate` verdict.
   *
   * The judge was already writing this and the engine was dropping it on the floor: it
   * lives in `verdict.json`, inside a gitignored run directory, and nothing read it. On
   * 2026-09-07 u-2026-09-07-attention-core escalated with a precise diagnosis — evidence
   * spec 0 contained two conjuncts no implementation could satisfy at once, with both
   * alternative readings closed — and all that reached the ledger was "evidence ran clean
   * but its output did not satisfy the spec". The one artifact that could tell a planner
   * WHAT to fix was the one thing thrown away.
   *
   * Free-form on purpose. It is prose written for a reader, and pinning a schema to it
   * would only give a judge new ways to be malformed about something the engine never
   * needs to branch on.
   */
  escalation?: Record<string, unknown>;
}

/**
 * What the code-judge found, as instructions a correction pass can carry out.
 *
 * **A finding is not a verdict.** The judge used to return pass/fail and a failing verdict
 * deleted the branch; now it says what is wrong and one pass fixes it on the branch that
 * has it. So what matters is no longer "did it pass" but "what, exactly, is wrong and
 * where" — and an entry that cannot answer that is not a finding at all.
 *
 * `escalate` never reaches here. That verdict says the UNIT SPEC is the defect — evidence
 * no implementation could satisfy, criteria that contradict each other — and no edit to
 * the diff can resolve it. It is the one case that still stops the unit, because the fix
 * belongs one rung up.
 */
export function verdictFindings(v: Verdict, unit: WorkUnit): { findings: string[]; unreported: string[] } {
  const findings: string[] = [];
  const unreported: string[] = [];

  for (const c of v.coherence) {
    if (c.ok) continue;
    // A failing coherence entry may legally omit `quote` — the quote-or-it-didn't-happen
    // rule binds a PASS — so the criterion is all there is, and it has to be enough. It
    // is: it is the unit's own words, which the fixer also has.
    findings.push(
      `coherence: the diff does not serve this criterion — "${c.criterion}"` +
      (typeof c.quote === "string" && c.quote.trim().length > 0 ? `${LF}The judge cites: ${c.quote.trim()}` : ""),
    );
  }

  v.evidence.forEach((e, i) => {
    if (e.ok) return;
    const spec = unit.evidence[i];
    findings.push(
      `evidence[${i}] did not satisfy the unit — \`${e.spec}\`` + LF +
      // The exit code is reported ONLY when it is the finding. An evidence command that
      // exits 0 and is still rejected is the common case — the judge ran it and the
      // OUTPUT did not satisfy the expectation — and saying "exited 0" there reads as a
      // passing check and sends the fixer looking somewhere else.
      (e.run.exit_code === 0
        ? `It exited 0, so the command ran; the judge read its output and it did not show what the unit claims.`
        : `It exited ${e.run.exit_code}.`) + LF +
      `The unit says this should mean: ${spec?.expect ?? "(the unit has no expectation at this index)"}` + LF +
      `Its full output: ${e.run.log}`,
    );
  });

  // A refusal that names nothing cannot be acted on, so it is not a finding — it is proof
  // the judge did not report, and it fails the RUN rather than the unit. The narrowing and
  // intent rungs refuse exactly this, in the same words, for the same reason: a fixer
  // handed "something is wrong" changes something arbitrary, the free re-check sees the
  // gates go green, and the original defect lands.
  //
  // `escalate` is exempt and that is not a loophole. It does not claim a fault in the
  // diff at all — it says the UNIT SPEC is unsatisfiable — so having nothing marked
  // failing is the CORRECT shape for it, and its reasons live in `escalation`. Treating
  // it as an unreported refusal turned every escalation into a judge-failure, which the
  // first test of this path caught.
  if (v.verdict === "fail" && findings.length === 0) {
    unreported.push("code-judge refused the diff without marking a single coherence criterion or evidence spec as failing");
  }
  return { findings, unreported };
}

export type VerdictValidation =
  | { ok: true; verdict: Verdict }
  | { ok: false; reason: "missing-verdict" | "malformed-verdict"; errors: string[] };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function validateVerdict(
  raw: unknown,
  unit: WorkUnit,
  requiredGates: readonly string[],
): VerdictValidation {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "malformed-verdict", errors: ["verdict is not a JSON object"] };
  }
  const v = raw as Record<string, unknown>;

  if (v["judged"] !== true) {
    errors.push("judged must be exactly true — a judge that could not run must fail the tick, not no-op");
  }
  if (v["unit"] !== unit.id) {
    errors.push(`verdict.unit is ${JSON.stringify(v["unit"])}, expected "${unit.id}"`);
  }
  if (v["verdict"] !== "pass" && v["verdict"] !== "fail" && v["verdict"] !== "escalate") {
    errors.push("verdict must be pass | fail | escalate");
  }
  if (!isNonEmptyString(v["base_sha"])) errors.push("base_sha is required");
  if (!isNonEmptyString(v["head_sha"])) errors.push("head_sha is required");
  if (typeof v["spend_usd"] !== "number" || v["spend_usd"] < 0) {
    errors.push("spend_usd must be a non-negative number");
  }

  // --- coherence: passing criteria must quote the artifact ---
  const coherence: CoherenceResult[] = [];
  if (!Array.isArray(v["coherence"])) {
    errors.push("coherence must be a list");
  } else {
    (v["coherence"] as unknown[]).forEach((entry, i) => {
      const c = entry as Record<string, unknown> | null;
      if (typeof c !== "object" || c === null || !isNonEmptyString(c["criterion"]) || typeof c["ok"] !== "boolean") {
        errors.push(`coherence[${i}] must have criterion (string) and ok (boolean)`);
        return;
      }
      if (c["ok"] === true && !isNonEmptyString(c["quote"])) {
        errors.push(`coherence[${i}] passes without quoting the artifact (quote-or-it-didn't-happen)`);
        return;
      }
      coherence.push({
        criterion: c["criterion"] as string,
        ok: c["ok"] as boolean,
        ...(isNonEmptyString(c["quote"]) ? { quote: c["quote"] as string } : {}),
      });
    });
  }

  // --- evidence: one executed entry per unit evidence spec, matched by position ---
  const evidence: EvidenceResult[] = [];
  if (!Array.isArray(v["evidence"])) {
    errors.push("evidence must be a list");
  } else {
    const list = v["evidence"] as unknown[];
    if (list.length !== unit.evidence.length) {
      errors.push(
        `evidence has ${list.length} entries but the unit demands ${unit.evidence.length} — every spec must be discharged`,
      );
    }
    list.forEach((entry, i) => {
      const e = entry as Record<string, unknown> | null;
      if (typeof e !== "object" || e === null) {
        errors.push(`evidence[${i}] must be a mapping`);
        return;
      }
      const spec = unit.evidence[i];
      if (spec !== undefined && e["spec"] !== spec.run) {
        errors.push(`evidence[${i}].spec must equal the unit's evidence run: "${spec.run}"`);
      }
      const run = e["run"] as Record<string, unknown> | null;
      if (
        typeof run !== "object" ||
        run === null ||
        !isNonEmptyString(run["command"]) ||
        typeof run["exit_code"] !== "number" ||
        !isNonEmptyString(run["output_sha256"]) ||
        !isNonEmptyString(run["log"])
      ) {
        errors.push(
          `evidence[${i}] has no executed run block (command, exit_code, output_sha256, log) — assertion is not evidence`,
        );
        return;
      }
      if (typeof e["ok"] !== "boolean") {
        errors.push(`evidence[${i}].ok must be a boolean`);
        return;
      }
      evidence.push({
        spec: e["spec"] as string,
        run: {
          command: run["command"] as string,
          exit_code: run["exit_code"] as number,
          output_sha256: run["output_sha256"] as string,
          log: run["log"] as string,
        },
        ok: e["ok"] as boolean,
      });
    });
  }

  // --- gate liveness: positive proof every required gate executed ---
  const gates = Array.isArray(v["gates_executed"])
    ? (v["gates_executed"] as unknown[]).filter(isNonEmptyString)
    : null;
  if (gates === null) {
    errors.push("gates_executed must be a list");
  } else {
    for (const gate of requiredGates) {
      if (!gates.includes(gate)) {
        errors.push(`gate "${gate}" has no execution proof — green-by-absence is banned`);
      }
    }
  }

  // --- honesty: a pass may not coexist with failing entries ---
  if (v["verdict"] === "pass") {
    if (coherence.some((c) => !c.ok) || evidence.some((e) => !e.ok)) {
      errors.push("verdict is pass but entries fail — a pass with failing entries is dishonest by construction");
    }
  }

  // --- and the same rule read the other way: a rejection has to name what it rejected.
  // Only the pass direction was checked, so a `fail` whose every entry passed was a
  // legal verdict. It reaches the retry as the string "code-judge fail: " — a prefix
  // with nothing after it, which is non-blank and therefore looked like a reason to
  // everything downstream while being none. `escalate` is deliberately not held to
  // this: it means "a person should look", its row is recorded as `escalated` rather
  // than `failed`, and no retry reads it.
  if (v["verdict"] === "fail" || v["verdict"] === "escalate") {
    if (!coherence.some((c) => !c.ok) && !evidence.some((e) => !e.ok)) {
      // Escalate is held to the same rule as fail, and for a sharper reason. Its
      // consequence is heavier — the unit is parked permanently, and the intent may grade
      // around it — so an escalate whose every check passes is a `pass` wearing a
      // different word, and it would spend that consequence on nothing. A unit whose spec
      // cannot be satisfied has something that did not pass; if it does not, the judge has
      // not shown the defect it is claiming.
      errors.push(`verdict is ${String(v["verdict"])} but every entry passes — a rejection that names nothing it rejected is not a verdict`);
    }
  }

  // An `escalate` without a usable diagnosis is malformed, not merely unhelpful.
  //
  // Nothing in the loop ever moves an escalated unit again, so this verdict permanently
  // parks it — and the ONLY thing that can turn that into progress is the judge's account
  // of what is wrong with the unit. Accepting a blank one buys a dead unit and a planner
  // told "the judge recorded no reason". Malformed instead means the judge is asked again,
  // which is an instrument failure and costs the unit nothing.
  if (v["verdict"] === "escalate") {
    const esc = v["escalation"];
    if (typeof esc !== "object" || esc === null || Array.isArray(esc)) {
      errors.push("verdict is `escalate` but `escalation` is missing or is not an object");
    } else {
      // `reason` and `detail` carry the argument; `escape_hatches_closed` is where a judge
      // shows it considered the readings that would make the unit buildable after all, and
      // a judge that skipped that step is likelier to be escalating something merely hard.
      for (const field of ["reason", "detail", "escape_hatches_closed"]) {
        const val = (esc as Record<string, unknown>)[field];
        if (typeof val !== "string" || val.trim().length === 0) {
          errors.push(`verdict is \`escalate\` but \`escalation.${field}\` is missing or blank`);
        }
      }
    }
  }
  if (errors.length > 0) return { ok: false, reason: "malformed-verdict", errors };
  return {
    ok: true,
    verdict: {
      unit: unit.id,
      verdict: v["verdict"] as Verdict["verdict"],
      judged: true,
      coherence,
      evidence,
      gates_executed: gates as string[],
      base_sha: v["base_sha"] as string,
      head_sha: v["head_sha"] as string,
      spend_usd: v["spend_usd"] as number,
      // Carried when present, never required. A judge that escalates without explaining
      // itself is unhelpful, not malformed — and failing the verdict for it would turn a
      // usable escalation into a `malformed-verdict`, which is an instrument failure and
      // reaches nobody at all.
      ...(typeof v["escalation"] === "object" && v["escalation"] !== null
        ? { escalation: v["escalation"] as Record<string, unknown> }
        : {}),
    },
  };
}

/** Load + validate a verdict file. A missing or unreadable file is `missing-verdict`. */
export function loadVerdict(
  path: string,
  unit: WorkUnit,
  requiredGates: readonly string[],
): VerdictValidation {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {
      ok: false,
      reason: "missing-verdict",
      errors: [`no verdict artifact at ${path} — the judge's claim to have run is worthless without it`],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: "malformed-verdict", errors: [`verdict is not valid JSON: ${String(e)}`] };
  }
  return validateVerdict(raw, unit, requiredGates);
}
