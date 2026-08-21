/**
 * Generate a throwaway **Sepolia** signer for the Day-1 smoke test and write it straight to .env.
 *
 * WHY THIS EXISTS: `scripts/day1-sepolia-smoke.ts` cannot reach the live pool without a signing
 * account, and hand-rolling one is four fiddly steps. This does the two that are mechanical
 * (generate, compute the counterfactual address) and hands back the two that are the owner's
 * (fund it, deploy it).
 *
 * KEY HANDLING (CLAUDE.md hard rule 1). The generated keys are written **directly into .env** and
 * are never printed, never returned, never written to a report. The only thing this script puts on
 * stdout is the public account address. If you are reading this transcript in an agent context, the
 * secrets are not in it — by construction.
 *
 * SEPOLIA ONLY. Refuses to run against mainnet: mainnet key custody is the owner's, full stop.
 * This account is a hot test key with faucet funds on it. Do not reuse it anywhere real.
 *
 * Usage:
 *   pnpm keys:gen              # generate + write .env + print the address to fund
 *   pnpm keys:gen --deploy     # after funding: deploy the account on-chain
 *   pnpm keys:gen --force      # overwrite an existing signer in .env
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Account, CallData, RpcProvider, ec, hash, stark } from "starknet";
import { MAX_VIEWING_KEY, resolveNetwork, resolveNetworkConfig } from "../packages/core/src/config.js";
import { mainnetArmingError } from "../packages/core/src/chain.js";

/**
 * OpenZeppelin account class, already declared on Sepolia (verified Aug 21, 2026 —
 * `starknet_getClass` returns it). Constructor takes a single `public_key` felt, confirmed from
 * the on-chain ABI. Declared-ness matters: it means funding + deploy, with no declare step.
 */
const ACCOUNT_CLASS_HASH = "0x061dac032f228abef9c6626f995015233097ae253a7f72d68552db02f2971b8f";

const ENV_PATH = ".env";
const SIGNER_KEYS = ["ACCOUNT_ADDRESS", "ACCOUNT_PRIVATE_KEY", "VIEWING_KEY"] as const;

function loadEnv(): void {
  try {
    process.loadEnvFile(ENV_PATH);
  } catch {
    /* handled by the existence check below */
  }
}

/**
 * Draw a viewing key uniformly from [1, MAX_VIEWING_KEY].
 *
 * Rejection sampling, not modulo: MAX_VIEWING_KEY is *half* the curve order, so `randomPrivateKey()`
 * lands out of range about half the time. Taking a modulus instead would skew the distribution —
 * cheap to avoid, and this is key material.
 */
function generateViewingKey(): bigint {
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = BigInt(`0x${Buffer.from(ec.starkCurve.utils.randomPrivateKey()).toString("hex")}`);
    if (candidate >= 1n && candidate <= MAX_VIEWING_KEY) return candidate;
  }
  // 100 consecutive rejections at p≈0.5 each is ~1e-30 — a broken CSPRNG, not bad luck.
  throw new Error("Could not sample a viewing key in range; the RNG is not behaving.");
}

/** Rewrite `KEY=value` lines in place, preserving comments, order and everything else. */
function writeEnvValues(values: Record<string, string>): void {
  const original = readFileSync(ENV_PATH, "utf8");
  let updated = original;

  for (const [key, value] of Object.entries(values)) {
    // Keep any trailing `# comment` on the line — .env.example's comments are load-bearing docs.
    const line = new RegExp(`^(${key}=)([^\\n#]*)(#.*)?$`, "m");
    updated = line.test(updated)
      ? updated.replace(line, (_m, prefix: string, _old: string, comment = "") =>
          comment ? `${prefix}${value}${" ".repeat(Math.max(1, 48 - prefix.length - value.length))}${comment}` : `${prefix}${value}`
        )
      : `${updated.trimEnd()}\n${key}=${value}\n`;
  }

  writeFileSync(ENV_PATH, updated);
}

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.slice(2)));

  if (!existsSync(ENV_PATH)) {
    console.error(`✗ No ${ENV_PATH}. Run: cp .env.example .env`);
    process.exitCode = 1;
    return;
  }
  loadEnv();

  // --- guard: generating keys is Sepolia-only; deploying an existing one is not ---
  //
  // These are two different acts and were previously refused as one. GENERATING a hot signer for
  // mainnet stays forbidden: mainnet key custody is the owner's (CLAUDE.md). But DEPLOYING an
  // account whose key the owner has already chosen to use creates no key and reveals nothing — it
  // is the necessary first step after funding, and blocking it left no way to do that step at all.
  //
  // Mainnet deploys still have to be armed for the day, the same rule the submitter enforces, so
  // an unattended run cannot land an account on mainnet by inheriting a stale environment.
  const network = resolveNetwork();
  if (network !== "sepolia") {
    if (!flags.has("deploy")) {
      console.error(
        `✗ KESE_NETWORK is "${network}". This script generates hot test keys and refuses to do so\n` +
          `  outside Sepolia — mainnet key custody is the owner's (CLAUDE.md).\n` +
          `  Deploying an already-generated account is allowed: re-run with --deploy.`
      );
      process.exitCode = 1;
      return;
    }
    const blocked = mainnetArmingError(network, process.env, new Date());
    if (blocked) {
      console.error(`✗ ${blocked}`);
      process.exitCode = 1;
      return;
    }
  }

  const net = resolveNetworkConfig();
  if (!net.value) {
    console.error(`✗ Network config incomplete: ${net.missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const provider = new RpcProvider({ nodeUrl: net.value.rpcUrl });

  // --- deploy path: keys already exist, account just needs to land on-chain ---
  if (flags.has("deploy")) {
    await deploy(provider);
    return;
  }

  // --- guard: don't silently replace a signer that may hold funds ---
  const existing = SIGNER_KEYS.filter((key) => (process.env[key] ?? "").trim() !== "");
  if (existing.length > 0 && !flags.has("force")) {
    console.error(
      `✗ ${ENV_PATH} already has ${existing.join(", ")}.\n` +
        `  Overwriting would strand any funds on the old account. Re-run with --force if that's fine.`
    );
    process.exitCode = 1;
    return;
  }

  // --- generate ---
  const privateKey = stark.randomAddress();
  const publicKey = ec.starkCurve.getStarkKey(privateKey);
  const viewingKey = generateViewingKey();

  // Counterfactual address: derived from the public key, so it is known *before* deployment.
  // That is what makes "fund first, deploy second" possible.
  const address = hash.calculateContractAddressFromHash(
    publicKey, // salt — conventionally the public key
    ACCOUNT_CLASS_HASH,
    CallData.compile({ publicKey }),
    0
  );

  writeEnvValues({
    ACCOUNT_ADDRESS: address,
    ACCOUNT_PRIVATE_KEY: privateKey,
    VIEWING_KEY: viewingKey.toString(10), // decimal, per .env.example
  });

  console.log(`✓ Sepolia signer written to ${ENV_PATH} (secrets not printed).\n`);
  console.log(`  Account address:  ${address}`);
  console.log(`  Account class:    ${ACCOUNT_CLASS_HASH}  (OpenZeppelin, already declared)\n`);
  console.log("  Next — the two steps that are yours:\n");
  console.log("  1. Fund the address above with Sepolia STRK (needed for gas AND for the shield):");
  console.log("       https://starknet-faucet.vercel.app   or   https://faucet.starknet.io");
  console.log("     Ask for STRK, not just ETH — v3 transactions pay fees in STRK.\n");
  console.log("  2. Deploy the account (once the faucet tx has landed):");
  console.log("       pnpm keys:gen --deploy\n");
  console.log("  Then: pnpm smoke:simulate   (and pnpm smoke:sepolia once #147 gives us a prover)");
}

async function deploy(provider: RpcProvider): Promise<void> {
  const address = (process.env.ACCOUNT_ADDRESS ?? "").trim();
  const privateKey = (process.env.ACCOUNT_PRIVATE_KEY ?? "").trim();
  if (!address || !privateKey) {
    console.error("✗ ACCOUNT_ADDRESS / ACCOUNT_PRIVATE_KEY not set. Run without --deploy first.");
    process.exitCode = 1;
    return;
  }

  // Already deployed? Then this is a no-op, not an error.
  try {
    await provider.getClassHashAt(address, "latest");
    console.log(`✓ Account ${address} is already deployed. Nothing to do.`);
    console.log("  Next: pnpm smoke:simulate");
    return;
  } catch {
    /* not deployed yet — that's the expected path */
  }

  const publicKey = ec.starkCurve.getStarkKey(privateKey);
  const account = new Account({ provider, address, signer: privateKey, cairoVersion: "1" });
  const payload = {
    classHash: ACCOUNT_CLASS_HASH,
    constructorCalldata: CallData.compile({ publicKey }),
    addressSalt: publicKey,
    contractAddress: address,
  };

  console.log(`→ Deploying ${address} …`);
  try {
    const fee = await account.estimateAccountDeployFee(payload);
    const { transaction_hash } = await account.deployAccount(payload, {
      tip: 0n, // v3 requirement (notes §4)
      resourceBounds: fee.resourceBounds,
    });
    console.log(`  tx ${transaction_hash} — waiting for acceptance…`);
    const receipt = await provider.waitForTransaction(transaction_hash);
    if (!receipt.isSuccess()) throw new Error("deploy reverted");
    console.log(`✓ Account deployed.\n`);
    // The prover reads the account's viewing-key slot at its base block, and that slot only
    // exists once the deploy is ≥10 blocks deep (docs/strk20-notes.md §4).
    console.log("  Wait ~10 blocks before the first private transaction — the proof reads state");
    console.log("  that must already be settled. The smoke test handles this between its own steps.\n");
    console.log("  Next: pnpm smoke:simulate");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ Deploy failed: ${summarize(message)}`);
    if (/balance|insufficient|fee/i.test(message)) {
      console.error("  Looks like the account has no STRK yet — fund it and retry.");
    }
    process.exitCode = 1;
  }
}

/**
 * First line of an error, minus any request-payload blob.
 *
 * starknet.js appends the full RPC params to its messages, and those params carry the deploy
 * signature. Cutting at the first brace keeps the useful part and drops the payload — the same
 * instinct as `createRedactor`, applied where a redactor isn't wired.
 */
function summarize(message: string): string {
  const firstLine = message.split("\n")[0]!;
  const braceAt = firstLine.indexOf("{");
  return (braceAt === -1 ? firstLine : firstLine.slice(0, braceAt)).trim().replace(/\s*with params$/, "");
}

main().catch((error) => {
  // The redactor isn't wired here on purpose: this script never puts key material into an error
  // path. Print only the first line, so a stack trace carrying calldata can't sprawl into logs.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FATAL: ${summarize(message)}`);
  process.exitCode = 1;
});
