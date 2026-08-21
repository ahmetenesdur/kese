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
import { tryNormalizeAddress } from "./address.js";
/**
 * Default STRK held back for proving, in wei. Unverified — see the file header. Override with
 * `PROVING_GAS_RESERVE_STRK` and revise once a real proof has actually been paid for.
 */
export const DEFAULT_PROVING_GAS_RESERVE_STRK = 24n * 10n ** 18n;
export function assessGasHeadroom(input) {
    // When the payment token IS the gas token, the reserve and the amount compete for the same
    // balance. Checking them separately is what silently under-funds a burst of payments.
    const spendingStrk = tryNormalizeAddress(input.spendToken) === tryNormalizeAddress(input.strkAddress);
    const required = spendingStrk ? input.reserve + input.spendAmount : input.reserve;
    const shortfall = required > input.strkBalance ? required - input.strkBalance : 0n;
    return { ok: shortfall === 0n, required, shortfall };
}
