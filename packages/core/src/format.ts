/**
 * Rendering amounts for people.
 *
 * Kese speaks whole tokens at every boundary that faces a human or a model — the MCP tool schemas,
 * the policy config file, and the approval message. Base units exist only inside the wallet.
 *
 * The approval message is the boundary that matters most: the owner is deciding on a phone, in
 * seconds, and a line reading `60000000000000000000` asks them to count twenty digits to tell
 * 60 STRK from 600 STRK. That is not a decision, it is a coin flip.
 */

import { tryNormalizeAddress, type Address } from "./address.js";
import { TOKENS, type Network } from "./config.js";

const DEFAULT_DECIMALS = 18;

/** Base units to a plain decimal string: `60000000000000000000` -> `"60"`. */
export function formatTokenAmount(amount: bigint, decimals = DEFAULT_DECIMALS): string {
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  // Padded first, then trimmed: dropping leading zeros would turn 0.000…1 into 0.1.
  const fraction = (amount % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? `${whole}` : `${whole}.${fraction}`;
}

/** A token's symbol, or a shortened address when we do not know it. */
export function tokenSymbol(token: Address, network: Network): string {
  const wanted = tryNormalizeAddress(token);
  for (const [symbol, address] of Object.entries(TOKENS[network])) {
    if (wanted !== null && tryNormalizeAddress(address) === wanted) return symbol;
  }
  // A phone notification has no room for 66 characters, and the middle of an address carries the
  // least information — the ends are what a person recognises.
  return token.length > 14 ? `${token.slice(0, 8)}…${token.slice(-4)}` : token;
}

/** `"60 STRK"` — the way a person would say it. */
export function describeAmount(amount: bigint, token: Address, network: Network): string {
  return `${formatTokenAmount(amount)} ${tokenSymbol(token, network)}`;
}
