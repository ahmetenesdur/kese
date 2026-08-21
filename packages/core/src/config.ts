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

import { constants, ec } from "starknet";

/**
 * Valid viewing keys live in [1, MAX_VIEWING_KEY] — HALF the curve order, not the full range.
 * Mirrors the SDK's own `MAX_VIEWING_KEY`; duplicated here so config validation does not depend
 * on the SDK being importable. A key above this is accepted by BigInt() but rejected deep inside
 * the SDK, so catching it here turns a confusing runtime failure into a clear config error.
 */
export const MAX_VIEWING_KEY = ec.starkCurve.CURVE.n / 2n;

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

const CHAIN_IDS: Record<Network, constants.StarknetChainId> = {
  sepolia: constants.StarknetChainId.SN_SEPOLIA,
  mainnet: constants.StarknetChainId.SN_MAIN,
};

/**
 * Well-known token addresses. STRK and ETH share addresses across Sepolia and
 * mainnet. NOTE: presence here says nothing about whether the STRK20 pool accepts
 * the token — verify against the pool before assuming (preflight does).
 */
export const TOKENS: Record<Network, Record<string, string>> = {
  sepolia: {
    STRK: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    ETH: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
  },
  mainnet: {
    STRK: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    ETH: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
  },
};

type Env = Record<string, string | undefined>;

/** Trim and treat "" / whitespace as absent — .env files are full of empty keys. */
function read(env: Env, key: string): string | undefined {
  const raw = env[key];
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function resolveNetwork(env: Env = process.env): Network {
  const raw = read(env, "KESE_NETWORK")?.toLowerCase() ?? "sepolia";
  if (raw !== "sepolia" && raw !== "mainnet") {
    throw new Error(`KESE_NETWORK must be "sepolia" or "mainnet", got "${raw}"`);
  }
  return raw;
}

/**
 * Resolve the chain/pool half of the config. Returns `missing` rather than throwing
 * so a preflight can report every gap in one pass instead of one per run.
 */
export function resolveNetworkConfig(env: Env = process.env): Resolved<NetworkConfig> {
  const network = resolveNetwork(env);
  const suffix = network.toUpperCase();
  const missing: string[] = [];

  const rpcUrl = read(env, `RPC_URL_${suffix}`);
  if (!rpcUrl) missing.push(`RPC_URL_${suffix}`);

  const poolAddress = read(env, `POOL_ADDRESS_${suffix}`);
  if (!poolAddress) missing.push(`POOL_ADDRESS_${suffix}`);

  if (!rpcUrl || !poolAddress) return { value: null, missing };

  return {
    value: {
      network,
      chainId: CHAIN_IDS[network],
      rpcUrl,
      poolAddress,
      provingServiceUrl: read(env, `PROVING_SERVICE_URL_${suffix}`) ?? null,
      indexerUrl: read(env, "INDEXER_URL") ?? null,
      escrowAddress: read(env, "ESCROW_CONTRACT_ADDRESS") ?? null,
    },
    missing,
  };
}

/**
 * Resolve signing authority.
 *
 * The viewing key is parsed to bigint here and only here. `BigInt()` accepts both
 * decimal and 0x-prefixed input, so either .env format works — what must never
 * happen is the *string* reaching `createPrivateTransfers`.
 */
export function resolveSigner(env: Env = process.env): Resolved<SignerConfig> {
  const missing: string[] = [];

  const address = read(env, "ACCOUNT_ADDRESS");
  if (!address) missing.push("ACCOUNT_ADDRESS");

  const privateKey = read(env, "ACCOUNT_PRIVATE_KEY");
  if (!privateKey) missing.push("ACCOUNT_PRIVATE_KEY");

  const viewingKeyRaw = read(env, "VIEWING_KEY");
  if (!viewingKeyRaw) missing.push("VIEWING_KEY");

  if (!address || !privateKey || !viewingKeyRaw) return { value: null, missing };

  let viewingKey: bigint;
  try {
    viewingKey = BigInt(viewingKeyRaw);
  } catch {
    // Deliberately does not echo the value.
    missing.push("VIEWING_KEY (not parseable as an integer — expected decimal or 0x-hex)");
    return { value: null, missing };
  }
  if (viewingKey <= 0n || viewingKey > MAX_VIEWING_KEY) {
    // Range only — the value itself is never echoed.
    missing.push(`VIEWING_KEY (out of range — must be in [1, ${MAX_VIEWING_KEY}])`);
    return { value: null, missing };
  }

  return { value: { address, privateKey, viewingKey }, missing };
}

/**
 * Build a scrubbing function for every secret currently in the environment.
 *
 * Rationale: starknet.js and the proving service echo request payloads into error
 * messages, and those payloads can carry the signer key or the viewing key. Every
 * error that reaches a log, a report file, or (later) an MCP tool result goes
 * through this first. Matching is done on the raw string *and* its bigint decimal
 * form, because the viewing key crosses that boundary inside the SDK.
 */
export function createRedactor(env: Env = process.env): (input: unknown) => string {
  const secrets = new Set<string>();

  for (const key of ["ACCOUNT_PRIVATE_KEY", "VIEWING_KEY", "TELEGRAM_BOT_TOKEN"]) {
    const value = read(env, key);
    if (!value || value.length < 8) continue; // too short to match safely
    secrets.add(value);
    // Same secret, other notation — hex ⇄ decimal.
    try {
      const asBigInt = BigInt(value);
      secrets.add(asBigInt.toString(10));
      secrets.add(`0x${asBigInt.toString(16)}`);
    } catch {
      /* not numeric (e.g. a bot token) — the literal form above is enough */
    }
  }

  return (input: unknown): string => {
    let text =
      input instanceof Error
        ? `${input.name}: ${input.message}${input.stack ? `\n${input.stack}` : ""}`
        : typeof input === "string"
          ? input
          : safeStringify(input);

    for (const secret of secrets) {
      if (secret.length >= 8) text = text.split(secret).join("[REDACTED]");
    }
    return text;
  };
}

function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(input, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)) ?? String(input);
  } catch {
    return String(input);
  }
}
