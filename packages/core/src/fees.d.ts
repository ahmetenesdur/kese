/**
 * Gas headroom for pool transactions.
 *
 * Upstream issue #121 reports that proving a pool transaction needs a STRK reserve well beyond
 * what `estimateInvokeFee` returns — around 24 STRK. **We have not verified that number**: it
 * cannot be measured without a proving service (strk20-hackathon#147), and it is second-hand
 * intel. So it lives here as a configurable default with its provenance attached, not as a
 * constant we vouch for.
 *
 * What this buys regardless of whether 24 is the right figure: an agent that runs out of gas
 * mid-burst gets told it is short on gas, with the exact shortfall, instead of a raw RPC revert
 * that reads like a protocol failure. Set the reserve to 0 to switch the check off.
 */
/**
 * Default STRK held back for proving, in wei. Unverified — see the file header. Override with
 * `PROVING_GAS_RESERVE_STRK` and revise once a real proof has actually been paid for.
 */
export declare const DEFAULT_PROVING_GAS_RESERVE_STRK: bigint;
export interface GasHeadroomInput {
    /** Current STRK balance of the signer, in wei. */
    strkBalance: bigint;
    /** STRK to hold back for proving, in wei. */
    reserve: bigint;
    /** Token being spent by the transaction. */
    spendToken: string;
    /** Amount being spent, in that token's smallest unit. */
    spendAmount: bigint;
    /** STRK's address on this network. */
    strkAddress: string;
}
export interface GasHeadroom {
    ok: boolean;
    /** Total STRK the signer must hold for this transaction to be fundable. */
    required: bigint;
    /** How much more STRK is needed; 0 when `ok`. */
    shortfall: bigint;
}
export declare function assessGasHeadroom(input: GasHeadroomInput): GasHeadroom;
