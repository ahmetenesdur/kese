/**
 * @kese/core — STRK20 SDK wrapper and shared primitives.
 * See docs/strk20-notes.md §1-§7 for exact APIs & gotchas:
 * - viewing key MUST be bigint; tip: 0n; provingBlockId = head - 10; typed pool Contract for discovery
 * Wallet (wallet.ts), chain submitter (chain.ts), live wiring (factory.ts) and the note
 * denomination ladder (notes.ts) are all in place.
 */
export * from "./address.js";
export * from "./config.js";
export * from "./env.js";
export * from "./statepath.js";
export * from "./fees.js";
export * from "./format.js";
export * from "./claimlink.js";
export * from "./escrow.js";
export * from "./activity.js";
export { DEFAULT_DENOMS } from "./notes.js";
export * from "./wallet.js";
export { PROOF_DEPTH, blocksUntilProvable, createChainSubmitter } from "./chain.js";
export * from "./factory.js";
export { TimedProofProvider } from "./proving.js";
