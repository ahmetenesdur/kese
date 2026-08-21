/**
 * Move plain STRK out of the agent account.
 *
 * Written because Ready refuses to import this account — it checks the account class and ours is
 * OpenZeppelin, not Ready's ("This account is not a Ready account"). So the funds already sitting
 * in the agent account cannot be reached from that wallet, and the owner needs some of them in a
 * wallet that can do the STRK20 flow.
 *
 * This is an ordinary ERC-20 transfer. It touches no pool, needs no proof, and is nothing to do
 * with the privacy layer.
 *
 * It does NOT send unless you pass --send. A dry run is the default because the interesting
 * failure here is a mistyped address, and an address that is one character wrong is a valid
 * address that nobody controls.
 *
 * Usage:
 *   npx tsx scripts/send-strk.ts --to 0x… --amount 25              # dry run
 *   KESE_MAINNET_ARMED=$(date -u +%F) \
 *     npx tsx scripts/send-strk.ts --to 0x… --amount 25 --send     # actually send
 */

import { Account, Contract, RpcProvider } from "starknet";
import {
  createRedactor,
  mainnetArmingError,
  resolveNetwork,
  resolveNetworkConfig,
  resolveSigner,
  tryNormalizeAddress,
} from "../packages/core/src/index.js";
import { envSearchPath, loadDotEnv } from "../packages/core/src/env.js";

loadDotEnv({ from: envSearchPath(import.meta.url) });

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const DECIMALS = 18n;

const ERC20_ABI = [
  {
    type: "function",
    name: "balance_of",
    inputs: [{ name: "account", type: "core::starknet::contract_address::ContractAddress" }],
    outputs: [{ type: "core::integer::u256" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "recipient", type: "core::starknet::contract_address::ContractAddress" },
      { name: "amount", type: "core::integer::u256" },
    ],
    outputs: [{ type: "core::bool" }],
    state_mutability: "external",
  },
] as const;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function die(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const to = tryNormalizeAddress(arg("to") ?? "");
if (to === null) die("--to <address> is required, and must be a valid Starknet address");

const amountArg = arg("amount");
if (!amountArg || !/^\d+(\.\d+)?$/.test(amountArg)) die("--amount <whole STRK> is required, e.g. 25");
const [whole, fraction = ""] = amountArg!.split(".");
const amount = BigInt(whole!) * 10n ** DECIMALS + BigInt(fraction.padEnd(Number(DECIMALS), "0") || "0");

const send = process.argv.includes("--send");
const redact = createRedactor();
const net = resolveNetworkConfig();
const signer = resolveSigner();
if (!net.value || !signer.value) die("configuration incomplete — check .env");

const network = resolveNetwork();
const provider = new RpcProvider({ nodeUrl: net.value!.rpcUrl });
const account = new Account({
  provider,
  address: signer.value!.address,
  signer: signer.value!.privateKey,
  cairoVersion: "1",
});
const strk = new Contract({ abi: ERC20_ABI as never, address: STRK, providerOrAccount: provider });

const fmt = (raw: bigint): string => {
  const units = raw / 10n ** DECIMALS;
  const rest = (raw % 10n ** DECIMALS).toString().padStart(Number(DECIMALS), "0").slice(0, 4);
  return `${units}.${rest}`;
};

const balanceRaw = (await strk.call("balance_of", [signer.value!.address])) as bigint | { low: bigint; high: bigint };
const balance =
  typeof balanceRaw === "bigint" ? balanceRaw : BigInt(balanceRaw.low) + (BigInt(balanceRaw.high) << 128n);

console.log(`\nnetwork  : ${network}`);
console.log(`from     : ${signer.value!.address}`);
console.log(`to       : ${to}`);
console.log(`amount   : ${fmt(amount)} STRK`);
console.log(`balance  : ${fmt(balance)} STRK  →  ${fmt(balance - amount)} after`);

if (to === tryNormalizeAddress(signer.value!.address)) {
  die("--to is this same account. Nothing to do.");
}
if (amount >= balance) {
  die(`not enough STRK, and gas still has to come out of what is left`);
}

if (!send) {
  console.log(`\n(dry run — nothing sent. Add --send when the address above is right.)\n`);
  process.exit(0);
}

const blocked = mainnetArmingError(network, process.env, new Date());
if (blocked) die(blocked);

console.log(`\n→ sending…`);
try {
  const call = strk.populate("transfer", [to, { low: amount & ((1n << 128n) - 1n), high: amount >> 128n }]);
  const fee = await account.estimateInvokeFee(call);
  const tx = await account.execute(call, { tip: 0n, resourceBounds: fee.resourceBounds });
  console.log(`  tx ${tx.transaction_hash}`);
  const receipt = await provider.waitForTransaction(tx.transaction_hash);
  console.log(`  ${receipt.isSuccess() ? "✓ sent" : "✗ reverted"}\n`);
} catch (error) {
  die(redact(error).split("\n")[0]!);
}
