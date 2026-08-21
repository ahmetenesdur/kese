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
export declare function normalizeAddress(address: Address): string;
/**
 * normalizeAddress, but null instead of throwing.
 *
 * Callers on a money path must fail closed, not crash: an LLM will hand us a truncated or
 * hallucinated address eventually, and an exception escaping a policy check is a tool crash —
 * which is not a denial.
 */
export declare function tryNormalizeAddress(address: Address): string | null;
/** True when two addresses denote the same account, whatever their notation. */
export declare function sameAddress(a: Address, b: Address): boolean;
