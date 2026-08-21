import { describe, expect, it } from "vitest";
import { normalizeAddress, sameAddress, tryNormalizeAddress } from "./address.js";

/**
 * These three functions decide whether two spellings mean the same account. Everything that
 * compares an address goes through them — the policy allowlist above all — so their edge cases are
 * worth pinning down directly rather than inferring from the callers that happen to exercise them.
 */
describe("normalizeAddress", () => {
  it("strips leading zeros, because an address is a number", () => {
    expect(normalizeAddress("0x00000a11ce")).toBe("0xa11ce");
  });

  it("lower-cases hex, so notation cannot split one account into two", () => {
    expect(normalizeAddress("0xABCDEF")).toBe("0xabcdef");
  });

  it("accepts decimal input, which is how some tools print addresses", () => {
    expect(normalizeAddress("123")).toBe("0x7b");
  });

  it("keeps the zero address, which is a real value", () => {
    expect(normalizeAddress("0x0")).toBe("0x0");
  });

  it("refuses an empty string instead of calling it address zero", () => {
    // BigInt("") is 0n. Without the guard, a missing recipient would read as a real account.
    expect(() => normalizeAddress("")).toThrow();
    expect(() => normalizeAddress("   ")).toThrow();
  });

  it("refuses malformed input", () => {
    expect(() => normalizeAddress("0x")).toThrow();
    expect(() => normalizeAddress("nonsense")).toThrow();
  });
});

describe("tryNormalizeAddress", () => {
  it("returns null rather than throwing — money paths must deny, not crash", () => {
    // An LLM will hand us a truncated or hallucinated address eventually, and an exception
    // escaping a policy check is a tool crash, which is not a denial.
    expect(tryNormalizeAddress("nonsense")).toBeNull();
    expect(tryNormalizeAddress("0x")).toBeNull();
  });

  it("treats blank input as absent, not as the zero address", () => {
    expect(tryNormalizeAddress("")).toBeNull();
    expect(tryNormalizeAddress("   ")).toBeNull();
    expect(tryNormalizeAddress("\n")).toBeNull();
  });

  it("still normalises everything valid", () => {
    expect(tryNormalizeAddress("0x00ABC")).toBe("0xabc");
    expect(tryNormalizeAddress("0x0")).toBe("0x0");
  });
});

describe("sameAddress", () => {
  it("matches the same account written differently — the allowlist-bypass case", () => {
    expect(sameAddress("0x0a11ce", "0x00000A11CE")).toBe(true);
  });

  it("does not match different accounts", () => {
    expect(sameAddress("0xa11ce", "0xb0b")).toBe(false);
  });

  it("never matches when either side is invalid", () => {
    // Two unparseable values are not "equally invalid, therefore equal" — that would let a
    // malformed allowlist entry match a malformed recipient.
    expect(sameAddress("nonsense", "nonsense")).toBe(false);
    expect(sameAddress("", "")).toBe(false);
    expect(sameAddress("0xa11ce", "")).toBe(false);
  });

  it("is symmetric", () => {
    expect(sameAddress("0x00abc", "0xABC")).toBe(sameAddress("0xABC", "0x00abc"));
    expect(sameAddress("bad", "0xabc")).toBe(sameAddress("0xabc", "bad"));
  });
});
