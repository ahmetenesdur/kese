/**
 * Wiring a KeseWallet to a real network.
 *
 * This is the Phase S smoke script's proven setup, lifted into the library so there is exactly one
 * place that knows how the SDK is assembled. Every non-obvious choice here was learned by running
 * against live Sepolia, not by reading docs — the references point at the decision that records why.
 */
import { Account, Contract, RpcProvider } from "starknet";
import { ProvingServiceProofProvider, createPrivateTransfers, } from "@starkware-libs/starknet-privacy-sdk";
import { CallMockProofProvider, ContractDiscoveryProvider, IndexerDiscoveryProvider, } from "@starkware-libs/starknet-privacy-sdk/testing";
import { PrivacyPoolABI } from "@starkware-libs/starknet-privacy-sdk/abi";
import { createChainSubmitter } from "./chain.js";
import { createKeseWallet } from "./wallet.js";
import { TimedProofProvider } from "./proving.js";
/**
 * The pool as a callable contract.
 *
 * `ContractDiscoveryProvider` invokes the pool's view methods by name (`get_public_key`,
 * `get_note`, `channel_exists`, …), so it needs a starknet.js Contract typed against the SDK's own
 * ABI. A generic `{ call() }` shim satisfies the type through a cast and then dies at runtime on
 * the first view call (docs/decisions.md D-008.5).
 */
export function poolContract(provider, poolAddress) {
    return new Contract({
        abi: PrivacyPoolABI,
        address: poolAddress,
        providerOrAccount: provider,
    }).typedv2(PrivacyPoolABI);
}
export function buildWallet(options) {
    const { net, signer, mode, redact, onWait, onProve } = options;
    const provider = new RpcProvider({ nodeUrl: net.rpcUrl });
    const account = new Account({
        provider,
        address: signer.address,
        signer: signer.privateKey,
        cairoVersion: "1",
    });
    // An indexer is optional. Without one we query the pool directly over RPC: slower, but zero
    // external dependencies. Note ContractDiscoveryProvider ships from the /testing subpath and the
    // vendor labels it dev/testing — re-decide before mainnet (D-007).
    const discoveryProvider = net.indexerUrl
        ? new IndexerDiscoveryProvider(net.indexerUrl, net.poolAddress)
        : new ContractDiscoveryProvider(poolContract(provider, net.poolAddress));
    const provingProvider = new TimedProofProvider(buildProvingProvider(mode, net, provider), onProve);
    const transfers = createPrivateTransfers({
        account,
        // MUST be a bigint. A hex *string* here is accepted and then silently misbehaves.
        viewingKeyProvider: { getViewingKey: async () => signer.viewingKey },
        provingProvider,
        discoveryProvider,
        poolContractAddress: net.poolAddress,
    });
    const wallet = createKeseWallet({
        transfers,
        address: signer.address,
        submitter: createChainSubmitter({ provider, account, onWait }),
        redact,
        // In simulate mode nothing is submitted; receipts come back as `simulated`.
        simulateNode: mode === "simulate" ? provider : undefined,
    });
    return { wallet, transfers, provider, account };
}
function buildProvingProvider(mode, net, provider) {
    if (mode === "service") {
        if (!net.provingServiceUrl) {
            // Fail closed: no prover means no payment, and saying so here beats a confusing failure
            // several layers down (strk20-hackathon#147).
            throw new Error(`PROVING_SERVICE_URL_${net.network.toUpperCase()} is not set — cannot produce real proofs`);
        }
        return new ProvingServiceProofProvider(net.provingServiceUrl, net.chainId, {
            nodeUrl: net.rpcUrl,
            poolAddress: net.poolAddress,
        });
    }
    // Simulate mode. `.simulate()` builds its own mock prover internally and never calls prove() on
    // this one — but the compiler still asks it for getDefaultDetails() (pool nonce, chainId) while
    // assembling the invocation, so a stub that throws on every method fails at compile time rather
    // than proving time (D-008.6).
    return new CallMockProofProvider(provider, net.chainId);
}
