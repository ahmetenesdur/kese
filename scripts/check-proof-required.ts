/**
 * Does the pool actually verify proofs?
 *
 * The Day-0 guide (upstream `52e7b63`) says "registering a viewing key and shielding are ordinary
 * public transactions" that "need no proof" — that a headless service can move value into the pool
 * with nothing but an RPC URL. If that were true it would close our eligibility requirement today,
 * so it is worth more than a reading of the ABI.
 *
 * This asks the chain. It builds a real `apply_actions` register call carrying a MOCK proof and
 * submits it to Sepolia. If proofs are not genuinely verified, it lands. If they are, the chain
 * says so in its own words.
 *
 * Answer as of 2026-08-21:
 *
 *     41: Transaction execution error: Invalid proof facts:
 *     Proof version 88314448135728 (PROOF0) is not allowed under this protocol version.
 *
 * So proofs are verified and the claim does not hold. Kept as a script rather than a note because
 * it is re-runnable: if the protocol ever changes, this reports the change instead of us
 * rediscovering it. Sepolia only, with test funds — a rejected transaction costs testnet gas.
 *
 * Usage: npx tsx scripts/check-proof-required.ts
 */
import { RpcProvider } from "starknet";
import {
  buildWallet,
  createRedactor,
  resolveNetworkConfig,
  resolveSigner,
  PROOF_DEPTH,
} from "../packages/core/src/index.js";
import { envSearchPath, loadDotEnv } from "../packages/core/src/env.js";

loadDotEnv({ from: envSearchPath(import.meta.url) });

const net = resolveNetworkConfig();
const signer = resolveSigner();
if (!net.value || !signer.value) throw new Error("config incomplete");
if (net.value.network !== "sepolia") throw new Error("refusing to run outside Sepolia");

const redact = createRedactor();
const { transfers, provider, account } = buildWallet({
  net: net.value,
  signer: signer.value,
  mode: "simulate",
  redact,
});

const head = await provider.getBlockNumber();
const provingBlockId = head - PROOF_DEPTH;
console.log(`network       : sepolia (head ${head}, proving block ${provingBlockId})`);
console.log(`account       : ${signer.value.address}`);

const chain = transfers.build({ provingBlockId }).register();
const result = await chain.simulate({ node: provider as never, provingBlockId });
const { call, proof } = result.callAndProof;

console.log(`\nthe call that was built:`);
console.log(`  target      : ${call.contractAddress}`);
console.log(`  entrypoint  : ${call.entrypoint}`);
console.log(`  calldata    : ${call.calldata.length} felts`);
console.log(`  last felt   : ${call.calldata[call.calldata.length - 1]}  ${
  call.calldata[call.calldata.length - 1] === "0x1" ? "(Option::None — no attestation, which is what the contract requires for a register)" : ""}`);
console.log(`  proofFacts  : ${proof.proofFacts.length}`);
console.log(`  proof data  : ${proof.data ? proof.data.length + " chars" : "EMPTY (mock)"}`);

const proofDetails = { proofFacts: proof.proofFacts, proof: proof.data };

console.log(`\n→ submitting to the chain…`);
try {
  const fee = await account.estimateInvokeFee(call, proofDetails);
  console.log(`  fee estimate passed: ${fee.overall_fee}`);
  const tx = await account.execute(call, { tip: 0n, resourceBounds: fee.resourceBounds, ...proofDetails });
  console.log(`  submitted: ${tx.transaction_hash}`);
  const receipt = await provider.waitForTransaction(tx.transaction_hash);
  console.log(`  result: ${receipt.isSuccess() ? "ACCEPTED — no proof was required after all" : "REVERTED"}`);
  if (!receipt.isSuccess()) {
    console.log(`  reason: ${(receipt as { revert_reason?: string }).revert_reason}`);
  }
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  console.log(`  THE CHAIN REFUSED IT. The part that matters:`);
  // The RPC error echoes the whole request first; the reason is at the end.
  const meaningful = msg
    .split("\n")
    .filter((l) => !/^\s*"?0x[0-9a-f]+"?,?\s*$/i.test(l))
    .filter((l) => l.trim() !== "" && !/^\s*[\[\]{},]+\s*$/.test(l));
  for (const line of meaningful.slice(-18)) console.log(`    ${line.trim()}`);
}
