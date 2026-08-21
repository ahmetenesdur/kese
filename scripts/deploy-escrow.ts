/**
 * Declare and deploy the escrow-claim contract.
 *
 * Uses starknet.js rather than sncast because the account this repo already owns was created and
 * deployed with starknet.js (`pnpm keys:gen`), so there is no second account configuration to keep
 * in step. Build the Cairo first:
 *
 *   export PATH="$HOME/.asdf/installs/scarb/2.16.0/bin:$PATH" && (cd contracts/escrow-claim && scarb build)
 *
 * Usage:  pnpm escrow:deploy              # declare if needed, then deploy
 *         pnpm escrow:deploy -- --dry-run # report what it would do, send nothing
 *
 * SEPOLIA ONLY unless KESE_NETWORK says otherwise, and mainnet asks for confirmation — a deploy is
 * irreversible and costs real funds.
 */

import { readFileSync, existsSync } from "node:fs";
import { Account, RpcProvider, hash } from "starknet";
import { createRedactor, resolveNetwork, resolveNetworkConfig, resolveSigner } from "../packages/core/src/index.js";

const ARTIFACT_DIR = "contracts/escrow-claim/target/dev";
const SIERRA = `${ARTIFACT_DIR}/escrow_claim_EscrowClaim.contract_class.json`;
const CASM = `${ARTIFACT_DIR}/escrow_claim_EscrowClaim.compiled_contract_class.json`;

async function main(): Promise<void> {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* env may already be set */
  }
  const redact = createRedactor();
  const dryRun = process.argv.includes("--dry-run");

  if (!existsSync(SIERRA) || !existsSync(CASM)) {
    console.error(
      `✗ No build artifacts. Run:\n` +
        `    export PATH="$HOME/.asdf/installs/scarb/2.16.0/bin:$PATH"\n` +
        `    (cd contracts/escrow-claim && scarb build)`
    );
    process.exitCode = 1;
    return;
  }

  const net = resolveNetworkConfig();
  const signer = resolveSigner();
  if (!net.value || !signer.value) {
    console.error(
      `✗ Not configured: ${[...net.missing, ...signer.missing].join(", ")}`
    );
    process.exitCode = 1;
    return;
  }

  // A deploy is irreversible and spends real funds. Testnet is the default everywhere else in this
  // repo; mainnet has to be asked for explicitly, at the moment it happens.
  if (resolveNetwork() === "mainnet" && !process.argv.includes("--i-mean-mainnet")) {
    console.error(
      "✗ KESE_NETWORK is mainnet. Re-run with --i-mean-mainnet if that is deliberate."
    );
    process.exitCode = 1;
    return;
  }

  const provider = new RpcProvider({ nodeUrl: net.value.rpcUrl });
  const account = new Account({
    provider,
    address: signer.value.address,
    signer: signer.value.privateKey,
    cairoVersion: "1",
  });

  const sierra = JSON.parse(readFileSync(SIERRA, "utf8")) as Parameters<
    typeof hash.computeContractClassHash
  >[0];
  const casm = JSON.parse(readFileSync(CASM, "utf8")) as Parameters<
    typeof hash.computeCompiledClassHash
  >[0];
  const classHash = hash.computeContractClassHash(sierra);

  console.log(`\nNetwork:     ${resolveNetwork()}`);
  console.log(`Deployer:    ${signer.value.address}`);
  console.log(`Pool:        ${net.value.poolAddress}   ← constructor argument`);
  console.log(`Class hash:  ${classHash}`);

  // The pool address is the ONLY constructor argument, and it is the contract's entire access
  // control: whatever goes in here becomes the sole address allowed to move escrowed funds.
  const constructorCalldata = [net.value.poolAddress];

  if (dryRun) {
    console.log("\n(dry run — nothing sent)\n");
    return;
  }

  let alreadyDeclared = false;
  try {
    await provider.getClass(classHash, "latest");
    alreadyDeclared = true;
    console.log("\n→ class already declared, skipping declare");
  } catch {
    console.log("\n→ declaring class…");
  }

  try {
    const result = alreadyDeclared
      ? await account.deployContract({ classHash, constructorCalldata })
      : await account
          .declareAndDeploy({ contract: sierra, casm, constructorCalldata })
          .then((r) => ({
            transaction_hash: r.deploy.transaction_hash,
            contract_address: r.deploy.contract_address,
          }));

    console.log(`   tx ${result.transaction_hash} — waiting…`);
    const receipt = await provider.waitForTransaction(result.transaction_hash);
    if (!receipt.isSuccess()) throw new Error("deploy reverted");

    console.log(`\n✓ Escrow deployed at ${result.contract_address}\n`);
    console.log("  Next:");
    console.log(`    1. Put it in .env:  ESCROW_CONTRACT_ADDRESS=${result.contract_address}`);
    console.log(`    2. On mainnet, add the address to strk20.json "contracts"\n`);
  } catch (error) {
    const message = redact(error);
    console.error(`✗ Deploy failed: ${message.split("\n")[0].split("{")[0].trim()}`);
    if (/balance|insufficient|fee/i.test(message)) {
      console.error("  The deployer looks short on STRK — fund it and retry.");
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`FATAL: ${createRedactor()(error)}`.split("\n")[0]);
  process.exitCode = 1;
});
