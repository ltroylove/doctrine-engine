import { describe, expect, it } from "vitest";
import { failureSignature, type GradeRun } from "../src/grade.js";

const run = (command: string, exit_code: number, output_sha256: string): GradeRun =>
  ({ command, exit_code, output_sha256, log: "" });

describe("failureSignature — what is still failing, and nothing else", () => {
  it("REGRESSION: a PASSING command's output is not in the key", () => {
    // The defect that made the skip never fire, measured on a target. Of an
    // intent's seven acceptance commands, `npm test` passed — and vitest prints its own
    // duration, so its output hashed differently on every grade. The other six, including
    // all five failures, were byte-identical. Hashing every run therefore moved the
    // signature every time and the paid gap decompose ran on every merge regardless, which
    // is the exact spin the signature was built to stop.
    const a = [run("npm test", 0, "duration-31s"), run("probe", 1, "cannot find module x")];
    const b = [run("npm test", 0, "duration-44s"), run("probe", 1, "cannot find module x")];
    expect(failureSignature(b)).toBe(failureSignature(a));
  });

  it("a FAILING command's output is in the key — it is the thing being asked about", () => {
    // The import error names the module. When a sibling slice lands it the error changes,
    // and that is precisely the tick where the decomposer has something new to say.
    const before = [run("probe", 1, "cannot find module ./matches.ts")];
    const after = [run("probe", 1, "matches.ts loaded, table empty")];
    expect(failureSignature(after)).not.toBe(failureSignature(before));
  });

  it("a check that flips from passing to failing moves the key, whatever it printed", () => {
    const passing = [run("npm test", 0, "same")];
    const failing = [run("npm test", 1, "same")];
    expect(failureSignature(failing)).not.toBe(failureSignature(passing));
  });

  it("the separator actually separates — two runs cannot be confused for one", () => {
    // The property a stray edit nearly removed. The separators were written as literal NUL
    // BYTES in the source, which made the file read as binary to grep and to every text
    // tool; stripping them — which I did to a sibling file by accident on 2026-09-16 —
    // silently turns them into empty strings, and then ["ab","c"] and ["a","bc"] hash the
    // same. They are `\u0000` escapes now: identical bytes into the hash, plain text in the
    // source, and this asserts the property either form is supposed to give.
    const split = [run("ab", 1, "x"), run("c", 1, "y")];
    const joined = [run("a", 1, "x"), run("bc", 1, "y")];
    expect(failureSignature(joined)).not.toBe(failureSignature(split));
  });

  it("a command being added or renamed moves the key", () => {
    const one = [run("probe", 1, "x")];
    const two = [run("probe", 1, "x"), run("probe-2", 1, "y")];
    expect(failureSignature(two)).not.toBe(failureSignature(one));
    expect(failureSignature([run("renamed", 1, "x")])).not.toBe(failureSignature(one));
  });
});
