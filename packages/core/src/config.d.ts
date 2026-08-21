/**
 * @kese/core — environment & network resolution.
 *
 * One job: turn process.env into a typed, validated config, and report precisely
 * what is missing instead of throwing a stack trace with half a private key in it.
 *
 * Two hard rules from CLAUDE.md are enforced here:
 *  1. Key isolation — `ACCOUNT_PRIVATE_KEY` / `VIEWING_KEY` never leave this module
 *     except as the `SignerConfig` handed to the SDK. `createRedactor()` scrubs them
 *     from anything on its way to a log, an error message, or an MCP tool result.
 *  4. Fail closed — a missing prerequisite produces a `missing[]` entry, never a guess.
 */
import { constants } from "starknet";
/**
 * Valid viewing keys live in [1, MAX_VIEWING_KEY] — HALF the curve order, not the full range.
 * Mirrors the SDK's own `MAX_VIEWING_KEY`; duplicated here so config validation does not depend
 * on the SDK being importable. A key above this is accepted by BigInt() but rejected deep inside
 * the SDK, so catching it here turns a confusing runtime failure into a clear config error.
 */
export declare const MAX_VIEWING_KEY: bigint;
export type Network = "sepolia" | "mainnet";
/** Everything needed to talk to a chain + pool, with no signing authority. */
export interface NetworkConfig {
    network: Network;
    chainId: constants.StarknetChainId;
    rpcUrl: string;
    poolAddress: string;
    /** null until strk20-hackathon#147 is answered (see docs/decisions.md D-004). */
    provingServiceUrl: string | null;
    /** null ⇒ use ContractDiscoveryProvider (RPC-based, no external dependency). */
    indexerUrl: string | null;
    /** null until contracts/escrow-claim is deployed on this network. */
    escrowAddress: string | null;
}
/** Signing authority. Never log, never serialise, never return from an MCP tool. */
export interface SignerConfig {
    address: string;
    privateKey: string;
    /** MUST be a bigint at runtime — a hex *string* silently misbehaves (notes §2). */
    viewingKey: bigint;
}
export interface Resolved<T> {
    value: T | null;
    /** Human-readable, env-var-named reasons `value` is null. Safe to print. */
    missing: string[];
}
/**
 * Well-known token addresses. STRK and ETH share addresses across Sepolia and
 * mainnet. NOTE: presence here says nothing about whether the STRK20 pool accepts
 * the token — verify against the pool before assuming (preflight does).
 */
export declare const TOKENS: Record<Network, Record<string, string>>;
type Env = Record<string, string | undefined>;
export declare function resolveNetwork(env?: Env): Network;
/**
 * Resolve the chain/pool half of the config. Returns `missing` rather than throwing
 * so a preflight can report every gap in one pass instead of one per run.
 */
export declare function resolveNetworkConfig(env?: Env): Resolved<NetworkConfig>;
/**
 * Resolve signing authority.
 *
 * The viewing key is parsed to bigint here and only here. `BigInt()` accepts both
 * decimal and 0x-prefixed input, so either .env format works — what must never
 * happen is the *string* reaching `createPrivateTransfers`.
 */
export declare function resolveSigner(env?: Env): Resolved<SignerConfig>;
/**
 * Build a scrubbing function for every secret currently in the environment.
 *
 * Rationale: starknet.js and the proving service echo request payloads into error
 * messages, and those payloads can carry the signer key or the viewing key. Every
 * error that reaches a log, a report file, or (later) an MCP tool result goes
 * through this first. Matching is done on the raw string *and* its bigint decimal
 * form, because the viewing key crosses that boundary inside the SDK.
 */
export declare function createRedactor(env?: Env): (input: unknown) => string;
export {};
