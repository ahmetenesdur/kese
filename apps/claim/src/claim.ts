/**
 * Claim page logic — everything decided before a wallet is involved.
 *
 * Kept out of the DOM because the failure modes here are the ones that lose money: telling someone
 * a link is claimable when it has expired, or when it was already taken, sends them into a revert
 * having paid gas — or worse, leaves them believing they were paid when they were not.
 *
 * The page reads only. Claiming itself goes through the visitor's own wallet, which runs the
 * Privacy SDK internally and does its own proving; this page never sees a viewing key, a note, or a
 * proof. That is the rule for any dapp, and it is also why claiming does not depend on Kese having
 * a proving service of its own.
 */

import { Contract, RpcProvider } from "starknet";
// Deep imports, not the `@kese/core` barrel: the barrel re-exports factory.ts, which pulls in
// the SDK (and its /testing entry) — server-only code that has no place in a browser bundle and
// breaks it on `Buffer is not defined`.
import { claimCommitment } from "@kese/core/claimlink";

/** What the escrow stores against a commitment. Mirrors `CommitmentEntry` in escrow.cairo. */
export interface EscrowEntry {
  token: string;
  amount: bigint;
  settled: boolean;
  expiryBlock: number;
}

export type ClaimState =
  | { kind: "no-link" }
  /** The secret is not a felt — a truncated paste or a mangled link. */
  | { kind: "malformed" }
  /** The escrow has never heard of this commitment. */
  | { kind: "unknown" }
  | { kind: "claimable"; token: string; amount: bigint; blocksRemaining: number }
  /** Past expiry: only the payer can recover it now. */
  | { kind: "expired"; token: string; amount: bigint }
  /** Already claimed or refunded. */
  | { kind: "settled"; token: string; amount: bigint };

/**
 * Pull the secret out of the URL fragment.
 *
 * The fragment — everything after `#` — is never transmitted to a server: not in the request line,
 * not in a `Referer` header. So the secret stays out of access logs, proxies and analytics, which
 * is precisely why it lives there rather than in a query string. A `?secret=` link is deliberately
 * not supported, because supporting it would quietly undo that.
 */
export function secretFromUrl(url: string): string | null {
  const hashAt = url.indexOf("#");
  if (hashAt === -1) return null;

  const raw = url.slice(hashAt + 1).trim();
  if (raw === "") return null;

  // Validate before hashing: a mangled link should read as "this link is broken", not send us
  // looking up the commitment of whatever the paste happened to contain.
  if (!/^0x[0-9a-fA-F]+$/.test(raw)) return null;
  try {
    return BigInt(raw) > 0n ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Decide what the visitor is looking at.
 *
 * The expiry comparison mirrors the contract exactly (`block < expiry` for a claim). A page that
 * drew the line one block later would invite someone to sign a transaction that reverts.
 */
export function claimStateFrom(entry: EscrowEntry, currentBlock: number): ClaimState {
  // The escrow returns a zeroed struct for a commitment it has never seen — the shape of a wrong
  // secret, not of a claim worth nothing.
  if (entry.amount === 0n) return { kind: "unknown" };

  // Settled outranks expired: "someone already took this" is the more specific truth, and the more
  // useful one to show.
  if (entry.settled) return { kind: "settled", token: entry.token, amount: entry.amount };

  if (currentBlock >= entry.expiryBlock) {
    return { kind: "expired", token: entry.token, amount: entry.amount };
  }

  return {
    kind: "claimable",
    token: entry.token,
    amount: entry.amount,
    blocksRemaining: entry.expiryBlock - currentBlock,
  };
}

/** Minimal ABI: the page only ever reads. */
const ESCROW_VIEW_ABI = [
  {
    type: "function",
    name: "get_commitment",
    inputs: [{ name: "commitment_hash", type: "core::felt252" }],
    outputs: [{ type: "escrow_claim::escrow::CommitmentEntry" }],
    state_mutability: "view",
  },
  {
    type: "struct",
    name: "escrow_claim::escrow::CommitmentEntry",
    members: [
      { name: "token", type: "core::starknet::contract_address::ContractAddress" },
      { name: "amount", type: "core::integer::u128" },
      { name: "settled", type: "core::bool" },
      { name: "expiry_block", type: "core::integer::u64" },
      { name: "refund_hash", type: "core::felt252" },
    ],
  },
] as const;

export interface LookupConfig {
  rpcUrl: string;
  escrowAddress: string;
}

/** Read the escrow entry a secret unlocks, and work out the visitor's state. */
export async function lookupClaim(secret: string, config: LookupConfig): Promise<ClaimState> {
  const provider = new RpcProvider({ nodeUrl: config.rpcUrl });
  const escrow = new Contract({
    abi: ESCROW_VIEW_ABI as never,
    address: config.escrowAddress,
    providerOrAccount: provider,
  });

  const [raw, currentBlock] = await Promise.all([
    escrow.call("get_commitment", [claimCommitment(secret)]),
    provider.getBlockNumber(),
  ]);

  const entry = raw as unknown as {
    token: bigint;
    amount: bigint;
    settled: boolean;
    expiry_block: bigint;
  };

  return claimStateFrom(
    {
      token: `0x${entry.token.toString(16)}`,
      amount: BigInt(entry.amount),
      settled: Boolean(entry.settled),
      expiryBlock: Number(entry.expiry_block),
    },
    currentBlock
  );
}
