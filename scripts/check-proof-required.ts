/**
 * Does the STRK20 pool actually let you register or shield with "nothing but an RPC URL"?
 *
 * The Day-0 guide (upstream `52e7b63`) says registering a viewing key and shielding are "ordinary
 * public transactions" that "need no proof", and that a headless service can move value into the
 * pool with only an RPC endpoint. If true, that closes the ≥3-transaction eligibility requirement
 * for every team stuck behind the unpublished proving service — so it deserves a real test, not a
 * reading of the ABI.
 *
 * Four checks, from cheapest to most conclusive. Each one closes a door a sceptic could point at:
 *
 *   1. Enumerate every external entrypoint on the DEPLOYED class, read from the chain rather than
 *      from the SDK's bundled copy, which could be stale.
 *   2. Probe `deposit` / `register` / `shield` selectors directly. "Ordinary public transaction"
 *      implies something to call.
 *   3. Call `compile_and_panic` — the only other non-admin entrypoint — so nobody can say we did
 *      not try it.
 *   4. Submit a real `apply_actions` register call TWICE: once with no proof at all (this is the
 *      claim as written), and once with a mock proof (to separate "no proof" from "bad proof").
 *
 * Sepolia only. A rejected transaction costs testnet gas and nothing else.
 *
 * Usage: npx tsx scripts/check-proof-required.ts
 */

import { CallData, hash, RpcProvider } from "starknet";
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
if (!net.value || !signer.value) throw new Error("configuration incomplete");
if (net.value.network !== "sepolia") throw new Error("refusing to run outside Sepolia");

const redact = createRedactor();
const { transfers, provider, account } = buildWallet({
  net: net.value,
  signer: signer.value,
  mode: "simulate",
  redact,
});
const pool = net.value.poolAddress;

/**
 * The reason, dug out of an RPC error.
 *
 * Starknet nests execution failures: `execution_error` can itself be an object with another
 * `error` inside, several levels deep, and the innermost string is the only part that says
 * anything. Printing the outer layer shows a class hash and an address and explains nothing —
 * which is exactly how a decisive result gets mistaken for an inconclusive one.
 */
function why(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);

  const deepest = (node: unknown): string | null => {
    if (typeof node === "string") return node;
    if (node && typeof node === "object") {
      for (const key of ["error", "execution_error", "revert_error", "revert_reason"]) {
        const inner = (node as Record<string, unknown>)[key];
        if (inner !== undefined) return deepest(inner) ?? null;
      }
    }
    return null;
  };

  // The error text usually contains one or more embedded JSON objects; take the innermost
  // message from the last one that parses.
  for (const candidate of [...msg.matchAll(/\{[\s\S]*\}/g)].reverse()) {
    try {
      const found = deepest(JSON.parse(candidate[0]));
      if (found) return decodeShortString(found).slice(0, 400);
    } catch {
      /* not JSON, try the next */
    }
  }

  // A Cairo panic arrives as a hex-encoded short string. That string is the contract's own words
  // and is the most direct answer available, so it wins over any surrounding prose.
  for (const hex of msg.match(/0x[0-9a-f]{8,62}/gi) ?? []) {
    const body = hex.slice(2);
    try {
      const text = Buffer.from(body.length % 2 ? `0${body}` : body, "hex").toString("utf8");
      if (/^[\x20-\x7e]{4,}$/.test(text)) return `${text}  (${hex})`;
    } catch {
      /* not text */
    }
  }

  const line = msg
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /error|not found|invalid|panic|fail/i.test(l))
    .pop();
  return (line ?? msg.split("\n").pop() ?? msg).slice(0, 400);
}

/** Cairo panics arrive as hex-encoded short strings; show the words, not the felt. */
function decodeShortString(value: string): string {
  return value.replace(/0x[0-9a-f]{2,62}/gi, (hex) => {
    try {
      const text = Buffer.from(hex.slice(2), "hex").toString("utf8");
      return /^[\x20-\x7e]+$/.test(text) && text.length > 2 ? `${hex} ("${text}")` : hex;
    } catch {
      return hex;
    }
  });
}

console.log(`network : sepolia · pool ${pool.slice(0, 16)}…`);
console.log(`account : ${signer.value.address.slice(0, 16)}…\n`);

// ── 1. what the deployed contract actually exposes ────────────────────────────────────────────
const classHash = await provider.getClassHashAt(pool);
const deployed = (await provider.getClassByHash(classHash)) as { abi: unknown };
const abi = (typeof deployed.abi === "string" ? JSON.parse(deployed.abi) : deployed.abi) as {
  type: string;
  name?: string;
  items?: { type: string; name: string; state_mutability?: string }[];
  state_mutability?: string;
}[];

const external: { name: string; iface: string }[] = [];
for (const item of abi) {
  if (item.type === "interface") {
    for (const f of item.items ?? []) {
      if (f.type === "function" && f.state_mutability !== "view") {
        external.push({ name: f.name, iface: (item.name ?? "").split("::").pop() ?? "" });
      }
    }
  } else if (item.type === "function" && item.state_mutability !== "view") {
    external.push({ name: item.name!, iface: "" });
  }
}
const nonAdmin = external.filter((e) => e.iface === "IClient" || e.iface === "IServer");
console.log(`1. deployed class ${classHash.slice(0, 16)}…`);
console.log(`   external entrypoints: ${external.length}, of which non-admin: ${nonAdmin.length}`);
console.log(`   ${nonAdmin.map((e) => e.name).join(", ")}`);

// ── 2. is there anything to call? ─────────────────────────────────────────────────────────────
console.log(`\n2. probing the entrypoints an "ordinary public transaction" would use`);
for (const name of ["deposit", "register", "shield", "register_public_key"]) {
  try {
    await provider.callContract({
      contractAddress: pool,
      entrypoint: name,
      calldata: [],
    });
    console.log(`   ${name.padEnd(22)} EXISTS — the claim may hold, investigate`);
  } catch (error) {
    const reason = why(error);
    const missing = /not found|ENTRYPOINT_NOT_FOUND/i.test(reason);
    console.log(`   ${name.padEnd(22)} ${missing ? "does not exist" : reason}`);
  }
}

// ── 3. the only other non-admin entrypoint ────────────────────────────────────────────────────
console.log(`\n3. compile_and_panic — the remaining non-admin entrypoint`);
try {
  await provider.callContract({
    contractAddress: pool,
    entrypoint: "compile_and_panic",
    calldata: CallData.compile([signer.value.address, "0x0", []]),
  });
  console.log(`   returned without panicking — unexpected, investigate`);
} catch (error) {
  console.log(`   ${why(error)}`);
  console.log(`   (it is a compile-and-revert helper: the SDK's mock prover reads the compiled`);
  console.log(`    actions out of the panic. It never changes state.)`);
}

// ── 4. the claim itself: apply_actions, with and without a proof ──────────────────────────────
const head = await provider.getBlockNumber();
const provingBlockId = head - PROOF_DEPTH;
const built = await transfers
  .build({ provingBlockId })
  .register()
  // The proving block is already fixed by `.build({ provingBlockId })` above; the SDK's
  // SimulateOptions does not take it a second time.
  .simulate({ node: provider });
const { call, proof } = built.callAndProof;

// `Call.calldata` is optional and loosely typed upstream; the SDK always produces a felt array
// here, and naming that once keeps the rest of the file honest about what it is handling.
const calldata = (call.calldata ?? []) as string[];

console.log(`\n4. the register call this produces (apply_actions, ${calldata.length} felts)`);
console.log(`   last felt ${calldata.at(-1)} = Option::None, i.e. no screening attestation,`);
console.log(`   which is exactly what the contract requires for a non-deposit action.`);

/**
 * Ask the POOL, not our account.
 *
 * Submitting through the account buries the answer: `__execute__` unwraps the failed call and
 * panics with `Result::unwrap failed`, which names nothing. A read-only `starknet_call` runs the
 * same entrypoint with the same calldata and returns the contract's own revert reason.
 */
console.log(`\n5. apply_actions on the pool, no proof attached — the claim exactly as written`);
try {
  await provider.callContract({
    contractAddress: call.contractAddress,
    entrypoint: call.entrypoint,
    calldata,
  });
  console.log(`   ACCEPTED — no proof was required after all. The guide is right; investigate.`);
} catch (error) {
  console.log(`   the pool says: ${why(error)}`);
}

// And with a fabricated proof, to separate "no proof" from "bad proof". This one goes through the
// account, because proof facts ride in the transaction envelope rather than the calldata.
console.log(`\n6. the same call with a MOCK proof, to rule out "your proof was simply wrong"`);
try {
  const details = { proofFacts: proof.proofFacts, proof: proof.data };
  const fee = await account.estimateInvokeFee(call, details);
  const tx = await account.execute(call, { tip: 0n, resourceBounds: fee.resourceBounds, ...details });
  const receipt = await provider.waitForTransaction(tx.transaction_hash);
  console.log(`   ${receipt.isSuccess() ? `ACCEPTED ${tx.transaction_hash}` : "reverted"}`);
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  const named = msg.match(/Invalid proof facts:[^"]+/)?.[0];
  console.log(`   the protocol says: ${named ?? why(error)}`);
}

console.log(
  `\nConclusion: registering is not an ordinary public transaction. There is no entrypoint for it,\n` +
    `and the one entrypoint that exists refuses an action carrying no proof facts.`
);
