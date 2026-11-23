import { describe, expect, it } from "vitest";
import { isOutage, isTruncated, parseResultMessage, TRUNCATION_SUBTYPES } from "../src/result.js";

describe("parseResultMessage", () => {
  it("finds the final result message among noise and malformed lines", () => {
    const stdout = [
      '{"type":"system","subtype":"init"}',
      "plain text noise",
      '{"type":"assistant","message":"partial',
      '{"type":"result","subtype":"success","total_cost_usd":0.1,"result":"first"}',
      '{"type":"result","subtype":"success","total_cost_usd":0.2,"result":"last wins"}',
    ].join("\n");
    const msg = parseResultMessage(stdout);
    expect(msg?.result).toBe("last wins");
    expect(msg?.total_cost_usd).toBe(0.2);
  });

  it("returns null when no result message exists — absence is representable, never invented", () => {
    expect(parseResultMessage("no json here\n{\"type\":\"system\"}")).toBeNull();
    expect(parseResultMessage("")).toBeNull();
  });

  it("never throws on garbage", () => {
    expect(() => parseResultMessage('{"type":"result"')).not.toThrow();
    expect(parseResultMessage('{"type":"result"')).toBeNull();
  });
});

describe("isOutage", () => {
  it("flags an API-error run that spent nothing", () => {
    expect(isOutage({ type: "result", subtype: "success", api_error_status: 529, total_cost_usd: 0 })).toBe(true);
  });

  it("a run that spent money is not an outage, whatever its error status", () => {
    expect(isOutage({ type: "result", subtype: "success", api_error_status: 529, total_cost_usd: 0.4 })).toBe(false);
  });

  it("a clean run is not an outage", () => {
    expect(isOutage({ type: "result", subtype: "success", total_cost_usd: 0.4 })).toBe(false);
  });
});

describe("isTruncated", () => {
  it("classifies every known truncation subtype as failure", () => {
    for (const subtype of TRUNCATION_SUBTYPES) {
      expect(isTruncated({ type: "result", subtype })).toBe(true);
    }
  });

  it("does not flag success", () => {
    expect(isTruncated({ type: "result", subtype: "success" })).toBe(false);
  });
});
