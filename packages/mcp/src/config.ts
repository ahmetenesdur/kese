/**
 * Policy config from the environment.
 *
 * These are the caps an agent runs under, edited by a human in a .env file — possibly at speed,
 * possibly at 2am before a demo. So every failure here is loud and specific: the loader collects
 * *all* problems and names the entry at fault, rather than throwing on the first one and hiding the
 * other three. And it never falls back to a default: a missing cap is not an unlimited one
 * (CLAUDE.md hard rule 4).
 *
 * Format, chosen to be readable in a .env rather than compact:
 *
 *   POLICY_PER_TX_CAP=STRK:100,ETH:1
 *   POLICY_DAILY_CAP=STRK:250
 *   POLICY_APPROVAL_THRESHOLD=STRK:50
 *   POLICY_ALLOWLIST=0x0a11ce,0x0b0b     # or the literal "any"
 *
 * Amounts are in WHOLE TOKENS, not the smallest unit. A human writing "100" means 100 STRK; making
 * them write 100000000000000000000 is how you get an off-by-10^18 in a spending limit.
 */

import { TOKENS, resolveNetwork, tryNormalizeAddress } from "@kese/core";
import type { PolicyConfig } from "@kese/policy";

type Env = Record<string, string | undefined>;

export type LoadResult =
  | { ok: true; config: PolicyConfig }
  | { ok: false; errors: string[] };

/** Both tokens Kese knows use 18 decimals; anything else must be added deliberately. */
const DECIMALS: Record<string, number> = { STRK: 18, ETH: 18 };
const DEFAULT_DECIMALS = 18;

export function loadPolicyConfig(env: Env = process.env): LoadResult {
  const errors: string[] = [];
  const network = resolveNetwork(env);
  const known = TOKENS[network];

  const perTxCap = parseAmountMap(env, "POLICY_PER_TX_CAP", known, errors);
  const dailyCap = parseAmountMap(env, "POLICY_DAILY_CAP", known, errors);
  const approvalThreshold = parseAmountMap(env, "POLICY_APPROVAL_THRESHOLD", known, errors);
  const allowlist = parseAllowlist(env.POLICY_ALLOWLIST, errors);

  // A token needs all three or the engine denies it as unconfigured. Catching that here turns a
  // baffling runtime denial into a startup error naming the token.
  const everyToken = new Set([
    ...Object.keys(perTxCap),
    ...Object.keys(dailyCap),
    ...Object.keys(approvalThreshold),
  ]);
  for (const token of everyToken) {
    const missing = [
      perTxCap[token] === undefined && "POLICY_PER_TX_CAP",
      dailyCap[token] === undefined && "POLICY_DAILY_CAP",
      approvalThreshold[token] === undefined && "POLICY_APPROVAL_THRESHOLD",
    ].filter(Boolean);
    if (missing.length > 0) {
      errors.push(`token ${labelFor(token, known)} is missing from ${missing.join(" and ")}`);
      continue;
    }
    // Caps are absolute and cannot be approved past (docs/decisions.md D-011), so a threshold above
    // the cap would define a band where every payment is denied outright and no approval is ever
    // possible. That is a configuration mistake, not a policy.
    if (approvalThreshold[token]! > perTxCap[token]!) {
      errors.push(
        `token ${labelFor(token, known)}: approval threshold (${approvalThreshold[token]}) is above the per-tx cap (${perTxCap[token]}), which makes the approval band unreachable`
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    config: {
      perTxCap,
      dailyCap,
      approvalThreshold,
      allowlist: allowlist!,
      claimLinkDefaultExpiryBlocks: Number(env.CLAIM_LINK_EXPIRY_BLOCKS ?? 1000),
    },
  };
}

function parseAmountMap(
  env: Env,
  key: string,
  known: Record<string, string>,
  errors: string[]
): Record<string, bigint> {
  const raw = env[key]?.trim();
  if (!raw) {
    errors.push(`${key} is not set — a missing cap is not an unlimited one`);
    return {};
  }

  const result: Record<string, bigint> = {};
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;

    const separator = trimmed.lastIndexOf(":");
    if (separator === -1) {
      errors.push(`${key}: "${trimmed}" is not in TOKEN:AMOUNT form`);
      continue;
    }

    const symbol = trimmed.slice(0, separator).trim();
    const amountText = trimmed.slice(separator + 1).trim();

    const address = resolveToken(symbol, known);
    if (!address) {
      errors.push(`${key}: unknown token "${symbol}" — use a known symbol or a 0x address`);
      continue;
    }

    const amount = parseWholeTokens(amountText, DECIMALS[symbol.toUpperCase()] ?? DEFAULT_DECIMALS);
    if (amount === null) {
      errors.push(`${key}: "${amountText}" is not a positive amount for ${symbol}`);
      continue;
    }

    result[address] = amount;
  }
  return result;
}

function resolveToken(symbol: string, known: Record<string, string>): string | null {
  if (symbol.startsWith("0x")) return tryNormalizeAddress(symbol) === null ? null : symbol;
  return known[symbol.toUpperCase()] ?? null;
}

/**
 * "1.5" with 18 decimals -> 1500000000000000000n.
 *
 * Parsed as text rather than through Number, because `Number("0.1") * 1e18` is not 10^17 and a
 * float rounding error inside a spending limit is not something you want to debug later.
 */
function parseWholeTokens(text: string, decimals: number): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(text)) return null;

  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) return null; // more precision than the token has

  const padded = fraction.padEnd(decimals, "0");
  const value = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(padded === "" ? "0" : padded);
  return value > 0n ? value : null;
}

function parseAllowlist(raw: string | undefined, errors: string[]): string[] | "any" | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    errors.push('POLICY_ALLOWLIST is not set — use a comma-separated list or the literal "any"');
    return null;
  }
  if (trimmed.toLowerCase() === "any") return "any";

  const entries = trimmed.split(",").map((e) => e.trim()).filter((e) => e !== "");
  const bad = entries.filter((e) => tryNormalizeAddress(e) === null);
  if (bad.length > 0) {
    errors.push(`POLICY_ALLOWLIST: not valid addresses: ${bad.join(", ")}`);
    return null;
  }
  return entries;
}

/** Prefer the symbol in error text — an operator recognises "ETH" faster than an address. */
function labelFor(address: string, known: Record<string, string>): string {
  for (const [symbol, addr] of Object.entries(known)) {
    if (addr === address) return symbol;
  }
  return address;
}
