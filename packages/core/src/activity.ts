/**
 * The owner's on-chain activity.
 *
 * **The trap this module exists to avoid.** A private transaction reaches the chain through a
 * relayer, so `transaction.sender` is the same address for every user of the pool and never the
 * user themselves — that is the entire point. Code that asks "what did this address do" by
 * filtering on sender gets an empty list, or, when grouping, attributes every shield in the pool to
 * one account. Neither of those throws, so the usual outcome is hours spent debugging the indexer,
 * the block range and the RPC before anyone questions the field.
 *
 * The pool's `Deposit` event carries the real depositor as its **first indexed key**. That is the
 * only correct way to ask.
 *
 * **Deposits and withdrawals are not symmetric.** `Deposit` indexes `user_addr`, so a shield is
 * attributable to us. `Withdrawal` encrypts the initiator (`enc_user_addr`, readable only by the
 * auditor) and indexes only `to_addr`, so an unshield is attributable only when we withdrew to an
 * address we recognise. Anything built on top of this has to say so rather than quietly under-report.
 */

import { hash } from "starknet";
import { tryNormalizeAddress } from "./address.js";

/**
 * `starknet_getEvents` matches `keys[0]` against the event selector — the Cairo variant name,
 * not the struct name.
 */
export const DEPOSIT_EVENT_KEY = hash.getSelectorFromName("Deposit");

export interface DepositFilterInput {
  poolAddress: string;
  /** Omit to see every depositor — useful for confirming the query itself works. */
  userAddress?: string;
  fromBlock?: number;
  toBlock?: number;
}

export interface EventFilter {
  address: string;
  keys: string[][];
  from_block: { block_number: number } | "latest";
  to_block: { block_number: number } | "latest";
}

/**
 * Build the `starknet_getEvents` filter for our own shields.
 *
 * `keys` is positional: slot 0 is the selector, slot 1 is `user_addr`, slot 2 would be `token`.
 * Each slot holds the values that are acceptable there.
 */
export function depositFilter(input: DepositFilterInput): EventFilter {
  const keys: string[][] = [[DEPOSIT_EVENT_KEY]];

  if (input.userAddress) {
    // Normalize first. Felts have many valid spellings, an RPC returns one and config often holds
    // the zero-padded other — and a key filter that does not match exactly returns nothing, which
    // reads as "you have never deposited" rather than as a bug.
    keys.push([tryNormalizeAddress(input.userAddress) ?? input.userAddress]);
  }

  return {
    address: input.poolAddress,
    keys,
    from_block: input.fromBlock === undefined ? "latest" : { block_number: input.fromBlock },
    to_block: input.toBlock === undefined ? "latest" : { block_number: input.toBlock },
  };
}

export interface RawEvent {
  from_address: string;
  keys: string[];
  data: string[];
  block_number?: number;
  transaction_hash?: string;
}

export interface ShieldEntry {
  kind: "shield";
  depositor: string;
  token: string;
  amount: bigint;
  blockNumber?: number;
  transactionHash?: string;
}

/**
 * Parse one `Deposit` event, or null if it is not one.
 *
 * Returning null rather than a zeroed entry matters: `getEvents` can hand back other events when a
 * caller filters loosely, and a wrong-shape parse would report a deposit that never happened.
 */
export function parseDeposit(event: RawEvent): ShieldEntry | null {
  const [selector, depositor, token] = event.keys;
  if (selector !== DEPOSIT_EVENT_KEY) return null;
  if (!depositor || !token || event.data.length === 0) return null;

  let amount: bigint;
  try {
    amount = BigInt(event.data[0]!);
  } catch {
    return null;
  }

  return {
    kind: "shield",
    depositor: tryNormalizeAddress(depositor) ?? depositor,
    token: tryNormalizeAddress(token) ?? token,
    amount,
    blockNumber: event.block_number,
    transactionHash: event.transaction_hash,
  };
}

/** Minimal shape of the provider method this needs, so callers can pass any RPC client. */
export interface EventReader {
  getEvents(filter: EventFilter & { chunk_size: number; continuation_token?: string }): Promise<{
    events: RawEvent[];
    continuation_token?: string;
  }>;
}

/**
 * Every shield by `userAddress`, newest last.
 *
 * Paginates to the end rather than returning the first page: a partial history shown as a complete
 * one is the kind of wrong that only surfaces when someone reconciles a balance by hand.
 */
export async function readShields(
  reader: EventReader,
  input: DepositFilterInput,
  options: { chunkSize?: number; maxPages?: number } = {}
): Promise<ShieldEntry[]> {
  const chunkSize = options.chunkSize ?? 100;
  const maxPages = options.maxPages ?? 50;

  const filter = depositFilter(input);
  const found: ShieldEntry[] = [];
  let continuation: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const result = await reader.getEvents({
      ...filter,
      chunk_size: chunkSize,
      ...(continuation ? { continuation_token: continuation } : {}),
    });

    for (const event of result.events) {
      const parsed = parseDeposit(event);
      if (parsed) found.push(parsed);
    }

    continuation = result.continuation_token;
    if (!continuation) break;
  }

  return found;
}
