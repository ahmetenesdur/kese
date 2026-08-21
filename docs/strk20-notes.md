# STRK20 — distilled protocol notes for Kese

Compiled Aug 20, 2026 from primary sources: [strk20-by-example.org](https://strk20-by-example.org/) (full archive: `/llms-full.txt`), the hackathon [Day-0 mainnet guide](https://github.com/starkience/strk20-hackathon/blob/main/docs/MAINNET-DAY-0.md), and the SDK docs. Treat this file as ground truth until a linked doc contradicts it.

## 0. Mental model

Note-based shielded pool (encrypted UTXOs), not a mixer. Shield turns public ERC-20 into encrypted **notes**; private transfers spend notes and create new ones — sender, recipient, amount, token all hidden in-pool. **Edges are public**: deposits/withdrawals show address+amount. Every private tx carries a Stwo STARK proof verified on-chain. Compliance: FPI screens every deposit (signature verified on-chain); per-user **viewing keys** enable selective disclosure (auditor can trace, cannot spend).

Key objects: Notes · Nullifiers (double-spend prevention) · Viewing keys (registration required for BOTH sender and recipient) · Channels (directional sender→recipient lanes) · Open notes (deferred-amount outputs for DeFi) · Anonymizer contracts (`privacy_invoke` helpers).

## 1. SDK install (gotcha-laden)

Package: `@starkware-libs/starknet-privacy-sdk` · Node **≥ 24** (WebCrypto). Distributed via **GitHub Packages**, so:

> **Verified Aug 21, 2026 — resolved.** The `read:packages` scope is the whole ball game: without
> it the registry returns `403 permission_denied` even though the package is published, and refreshing
> it needs an interactive device-flow (owner action). **Two gotchas beyond the scope itself:** the
> refresh prompt breaks in terminals that inject escape sequences — run it from a normal desktop
> terminal — and npm keeps using the OLD token afterwards, so
> `npm config set '//npm.pkg.github.com/:_authToken' "$(gh auth token)"` has to follow.
>
> Current pin: **0.14.3-rc.5** from the registry. If the scope is ever unavailable,
> `./scripts/vendor-sdk.sh` builds the same artefact from the **release commit `66e3caa`** — *not*
> main HEAD, which carries post-release changes (including a changed `PrivacyPoolABI`) while
> `package.json` still reads rc.5 (D-015). That build was diffed against the published tarball and
> is byte-identical.

```sh
gh auth refresh -h github.com -s read:packages
npm config set @starkware-libs:registry https://npm.pkg.github.com
npm config set '//npm.pkg.github.com/:_authToken' "$(gh auth token)"
pnpm add @starkware-libs/starknet-privacy-sdk
# fallback: pnpm add "starkware-libs/starknet-privacy#<commit-sha>"
```

## 2. Initialization (verbatim-adapted)

```ts
import { Account, RpcProvider, constants } from "starknet" // starknet.js >= 10.4.0
import { createPrivateTransfers } from "@starkware-libs/starknet-privacy-sdk"

const provider = new RpcProvider({ nodeUrl: process.env.RPC_URL! })
const account = new Account({
  provider,
  address: process.env.ACCOUNT_ADDRESS!,
  signer: process.env.ACCOUNT_PRIVATE_KEY!,
  cairoVersion: "1",
})

const transfers = createPrivateTransfers({
  account,
  viewingKeyProvider: { getViewingKey: async () => BigInt(process.env.VIEWING_KEY!) }, // MUST be bigint
  provingProvider: { url: process.env.PROVING_SERVICE_URL!, chainId: constants.StarknetChainId.SN_MAIN },
  // NOTE (corrected Aug 21): ContractDiscoveryProvider is exported from the
  // `@starkware-libs/starknet-privacy-sdk/testing` subpath — NOT the package entry — and takes a
  // pool *contract object*, not an address. The vendor labels it "for development and testing";
  // IndexerDiscoveryProvider is the production one. See docs/decisions.md D-007.
  discoveryProvider: { url: process.env.INDEXER_URL! },   // or new ContractDiscoveryProvider(poolContract)
  poolContractAddress: process.env.POOL_ADDRESS!,
})
```

**`ContractDiscoveryProvider` is not on the package entry point** — it is exported from
`@starkware-libs/starknet-privacy-sdk/testing` (verified at release commit `66e3caa`). Importing it
from the root yields `undefined` and reads like "the SDK doesn't ship it"; it does (D-014).

`provingProvider` / `discoveryProvider` accept **either** a live instance or a plain config object
(`ProofProviderInterface | ProofProviderConfig`) — the factory builds the production provider from a
config, so the shape above is valid. When prose and types disagree, `dist/interfaces.d.ts` wins:
the README's `simulate({ provider })` is really `{ node }`, and a JSDoc `deposit(100n)` is really
`deposit({ amount })`.

Builder chain: `.build({ autoRegister, autoSetup, autoSelectNotes, autoDiscover })` → `.register()` (once per account) → `.with(token, t => t.deposit/transfer/withdraw/inputs)` → `.surplusTo(address)` → `.execute({ provingBlockId })` ⇒ `{ callAndProof: { call, proof } }`.
State: `transfers.discoverNotes({ tokens: [BigInt(...)] })` ⇒ `Map<token, Note[]>`; `transfers.classifyTransaction(tx)` for history. `Note`: `{ id, token, amount, created }`.

## 3. Addresses & endpoints

| Thing | Value |
|---|---|
| Mainnet pool | `0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a` |
| Sepolia pool (v2.0) | `0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91` |
| Public mainnet RPC (Day-0 guide) | `https://rpc.starknet.lava.build` (`SN_MAIN` = `0x534e5f4d41494e`) |
| Proving service (mainnet) | **NOT PUBLISHED** — "contact the team via issue if your design requires the Privacy SDK route with proving services" ⇒ Day-1: open issue on `starkience/strk20-hackathon` |
| Discovery | `ContractDiscoveryProvider(poolContract)` via RPC (slower, zero external deps) — Phase S default; **vendor labels it dev/testing-only**, re-decide before mainnet (decisions D-007). Production: `IndexerDiscoveryProvider(url, pool)` |

## 4. Proving rules

- `provingBlockId = (await provider.getBlockNumber()) - 10` — **always**. Reasons: 10-block note maturity, reorg buffer, discovery/proving state consistency.
- **The 10-block rule is not only about notes** (corrected Aug 21). *Any* on-chain state the proof
  reads must be ≥10 blocks old, transparent transactions included: you cannot `register()` within
  ~10 blocks of the account's deploy, nor `deposit()` within ~10 blocks of the ERC-20 transfer that
  funded it, nor prove a new private tx until the previous one's block is that deep. Direct hazard
  for a burst-paying agent — see `packages/core/src/notes.ts`.
- Submission shape: `execute()` ⇒ `{ callAndProof, registry, warnings }`, then
  `account.execute(callAndProof.call, { tip: 0n, resourceBounds, proofFacts: callAndProof.proof.proofFacts, proof: callAndProof.proof.data })`.
- Re-fetch block number after each `waitForTransaction` when chaining; call `transfers.invalidateProofNonceCache()` where docs indicate.
- Proof validity window ≈ 450 blocks (~15 min). Proof generation ≈ 29 s on hosted service (show progress in UX; queue jobs).
- v3 txs: `tip: 0n` mandatory.
- **Gas reserve (UNVERIFIED, upstream #121):** proving reportedly needs ~24 STRK beyond
  `estimateInvokeFee`. Not measured — we have no prover yet. Guarded by
  `assessGasHeadroom()` in `packages/core/src/fees.ts`, tunable via `PROVING_GAS_RESERVE_STRK`.
  Revise the constant once a real proof has been paid for (D-016).

## 5. Registration

Account must register (publish viewing key) before holding/receiving private balance; **both sides** must be registered for a private transfer. Wallet-route: sign `${chainId}:${poolAddress}` via standard `signMessage` (emits `ViewingKeySet`); or use the UI at strk20.starknet.io/app. Unregistered recipients ⇒ use our escrow claim-link.

## 6. Escrow helper (basis for contracts/escrow-claim)

Reference (unofficial, unaudited — we own review): commitment = `poseidon(ESCROW_COMMITMENT_TAG, secret)`; two ops through ONE `privacy_invoke` entry:

```cairo
#[starknet::interface]
pub trait IEscrow<T> {
  fn get_commitment(self: @T, commitment_hash: felt252) -> CommitmentEntry;
  fn privacy_invoke(ref self: T, operation: EscrowOperation, commitment_hash: felt252,
    token: ContractAddress, amount: u128, secret: felt252, note_id: felt252) -> Span<OpenNoteDeposit>;
}
// CommitmentEntry { token, amount, claimed } ; EscrowOperation { Deposit, Claim }
```

Deposit: pool withdraws to escrow, stores entry. Claim: recipient proves secret preimage; contract flips `claimed` once (`ALREADY_CLAIMED` guard), approves pool, returns `OpenNoteDeposit` crediting claimer's note. Caller must be pool ("nobody can drive the escrow directly"). Constructor takes pool address. **Reference has NO refund/timeout — our extension adds `expiry` + `refund()` back to payer** (that's our Cairo contribution; spec in contracts/escrow-claim/README.md).

`privacy_invoke` general rules: return exactly `Span<OpenNoteDeposit>`; approve-don't-transfer (pool pulls); measure outputs via balance delta; one invoke per pool tx; assert non-zero output where applicable.

## 7. Wallet API route (fallback/complement)

`starknet.js ≥ 10.4.0`: `account.strk20InvokeTransaction(actions)`, `strk20PrepareInvoke(actions, simulate?)`, `strk20Balances([...tokens])`. Actions: `{type:"transfer", token, amount:"OPEN"|number, recipient}` | `{type:"invoke", contract, calldata}` with placeholders `${openNoteIds[N]}`, `${poolAddress}`. Wallet holds keys & proofs. Wallet support: **Ready** works on mainnet (Braavos per Day-0 guide; Xverse in progress). Use this route for the OWNER's shield/registration UX; SDK route for the agent's server-side spending.

## 8. Privacy limitations (be honest in UX + README)

Deposits/withdrawals public by design · channel-open timing can correlate · distinctive amounts weaken anonymity (use round denominations) · swaps: "amounts and timing visible; anonymity comes from shared address and mixing set" · private tx senders appear as rotating relayers in explorers. Eligibility counts the `Deposit` event's `user_addr`, not tx sender.

## 9. Hackathon submission mechanics

Fork `starkience/strk20-hackathon` → add entry to `registry.json` (repo_url + telegram; name/description/category/inspired_by optional) → PR merged = accepted. Final: `strk20.json` in OUR repo root (≥3 mainnet tx hashes touching pool, contracts[], demo_video, demo_url). "Ideas are not exclusive." "If other sprint projects end up depending on yours, that counts in your favour." Support via GitHub issues.
