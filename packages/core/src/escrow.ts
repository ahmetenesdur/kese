/**
 * Calldata for the escrow-claim contract.
 *
 * The pool forwards these arrays to `privacy_invoke` verbatim, and Cairo deserialises
 * **positionally**. A field out of order therefore does not fail loudly — it lands in the wrong
 * parameter. Swap `amount` and `expiry_block` and the contract accepts a deposit of one wei
 * expiring in the year 3000, with nothing to indicate anything went wrong.
 *
 * Parameter order, from contracts/escrow-claim/src/escrow.cairo:
 *   operation, commitment_hash, refund_hash, token, amount, secret, note_id, expiry_block
 *
 * Every builder emits all eight slots, filling the ones an operation does not use with zero, so the
 * positions never shift.
 */

/** Serde encodes a Cairo enum variant as its index. */
export const ESCROW_OPERATION = {
  Deposit: "0x0",
  Claim: "0x1",
  Refund: "0x2",
} as const;

const UNUSED = "0x0";

export interface EscrowDepositParams {
  commitmentHash: string;
  refundHash: string;
  token: string;
  amount: bigint;
  expiryBlock: number;
}

/** Lock funds the pool has just withdrawn to the escrow. */
export function escrowDepositCalldata(params: EscrowDepositParams): string[] {
  return [
    ESCROW_OPERATION.Deposit,
    params.commitmentHash,
    params.refundHash,
    params.token,
    params.amount.toString(),
    UNUSED, // secret
    UNUSED, // note_id
    params.expiryBlock.toString(),
  ];
}

export interface EscrowClaimParams {
  secret: string;
  noteId: string;
  token: string;
}

/**
 * Claim with the preimage.
 *
 * The commitment slot stays empty on purpose: the contract recomputes the key from the secret and
 * ignores anything passed here, so sending a hash would only suggest it mattered.
 */
export function escrowClaimCalldata(params: EscrowClaimParams): string[] {
  return [
    ESCROW_OPERATION.Claim,
    UNUSED, // commitment_hash — recomputed from the preimage
    UNUSED, // refund_hash
    params.token,
    UNUSED, // amount — taken from the stored entry
    params.secret,
    params.noteId,
    UNUSED, // expiry_block
  ];
}

export interface EscrowRefundParams {
  commitmentHash: string;
  secret: string;
  noteId: string;
  token: string;
}

/**
 * Refund after expiry.
 *
 * Needs both: the commitment names the entry, the refund secret proves the right to it. The hash is
 * public — it is on-chain — so naming an entry you cannot open gets you nothing.
 */
export function escrowRefundCalldata(params: EscrowRefundParams): string[] {
  return [
    ESCROW_OPERATION.Refund,
    params.commitmentHash,
    UNUSED, // refund_hash — only set on deposit
    params.token,
    UNUSED, // amount
    params.secret,
    params.noteId,
    UNUSED, // expiry_block
  ];
}
