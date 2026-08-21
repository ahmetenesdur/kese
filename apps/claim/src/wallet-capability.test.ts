import { describe, expect, it } from "vitest";
import { describeError, isPrivacyCapable } from "./wallet-capability.js";

describe("isPrivacyCapable", () => {
  it("accepts the version that introduced the STRK20 methods", () => {
    expect(isPrivacyCapable(["0.10.3"])).toBe(true);
  });

  it("accepts anything later", () => {
    expect(isPrivacyCapable(["0.11.0"])).toBe(true);
    expect(isPrivacyCapable(["1.0.0"])).toBe(true);
  });

  it("refuses anything earlier", () => {
    expect(isPrivacyCapable(["0.9.4"])).toBe(false);
    expect(isPrivacyCapable(["0.7.1", "0.8.0"])).toBe(false);
  });

  it("accepts when any one entry qualifies — wallets report a list", () => {
    expect(isPrivacyCapable(["0.7.1", "0.10.3"])).toBe(true);
  });

  it("refuses an empty list, which is what a wallet that answered nothing gives us", () => {
    expect(isPrivacyCapable([])).toBe(false);
  });

  it("refuses garbage rather than reading NaN as a version", () => {
    // `"latest".split(".")` maps to [NaN]; without the finite check, NaN >= 10 is false but
    // NaN > 0 is also false, so it only fails safe by accident. Pin it deliberately.
    expect(isPrivacyCapable(["latest"])).toBe(false);
    expect(isPrivacyCapable([""])).toBe(false);
    expect(isPrivacyCapable(["0.x"])).toBe(false);
  });
});

describe("describeError", () => {
  it("takes an Error's first line", () => {
    expect(describeError(new Error("Not implemented\n  at wallet.ts:1"))).toBe("Not implemented");
  });

  it("takes a bare string", () => {
    expect(describeError("User rejected")).toBe("User rejected");
  });

  it("takes an RPC object's message", () => {
    expect(describeError({ code: -32601, message: "Method not found" })).toBe("Method not found");
  });

  it("falls back to the whole object when there is no message", () => {
    expect(describeError({ code: 4001 })).toContain("4001");
  });

  it("never returns an empty string — a blank line is not evidence", () => {
    for (const value of [undefined, null, {}, "", new Error(""), Symbol("x")]) {
      expect(describeError(value).length).toBeGreaterThan(0);
    }
  });

  it("survives something unserialisable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeError(circular).length).toBeGreaterThan(0);
  });
});
