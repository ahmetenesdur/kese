/**
 * Starknet address handling.
 *
 * Addresses are NUMBERS, not strings: `0x0a11ce` and `0x00000a11ce` are the same account. Every
 * comparison in Kese — allowlists, config lookups, token identity — must go through here, because
 * string equality silently treats the two forms as different accounts. That is a correctness bug
 * in an allowlist and a confusing denial in a config lookup.
 */

export type Address = string;

/** Canonical lower-case hex form. Throws on malformed input — prefer `tryNormalizeAddress`. */
export function normalizeAddress(address: Address): string {
  // `BigInt("")` and `BigInt("  ")` are both 0n, so an absent value would silently become the ZERO
  // ADDRESS rather than an error. That is the wrong kind of answer: a missing recipient must read
  // as missing, not as a real account that happens to be address zero.
  if (typeof address !== "string" || address.trim() === "") {
    throw new TypeError("address is empty");
  }
  return `0x${BigInt(address).toString(16)}`;
}

/**
 * normalizeAddress, but null instead of throwing.
 *
 * Callers on a money path must fail closed, not crash: an LLM will hand us a truncated or
 * hallucinated address eventually, and an exception escaping a policy check is a tool crash —
 * which is not a denial.
 */
export function tryNormalizeAddress(address: Address): string | null {
  try {
    const normalized = normalizeAddress(address);
    return BigInt(normalized) >= 0n ? normalized : null;
  } catch {
    return null;
  }
}

/** True when two addresses denote the same account, whatever their notation. */
export function sameAddress(a: Address, b: Address): boolean {
  const left = tryNormalizeAddress(a);
  return left !== null && left === tryNormalizeAddress(b);
}
