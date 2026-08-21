# Decisions log (ADR-lite)

- D-001 (revised, see D-007): Discovery via ContractDiscoveryProvider (no indexer dependency). Revisit if too slow.
- D-002 (planned): SDK route for agent spending; Wallet API (Ready) only for owner onboarding. Gate G1 fallback: wallet-cosigned mode.
- D-003 (planned): SQLite (better-sqlite3) for policy state — single-node, transactional, zero-ops.
- D-004 (open): mainnet proving URL — requested via starkience/strk20-hackathon#147 (Aug 21); awaiting reply. Registration applied upstream as 826bf64 (PR #146).

---

## Day 1 (Aug 21, 2026) — Phase S spike

Source of truth for everything below: the SDK monorepo at `starkware-libs/starknet-privacy`
commit `36eac4ea88cd8c59dde1493176e16501c6e90328`, package version **0.14.3-rc.5**.
Where the SDK's own types contradict `docs/strk20-notes.md` or the SDK README, the **types win**
— both prose sources carry stale examples (details in D-008).

### D-005 — SDK obtained by building the public monorepo, not from GitHub Packages

**Blocked:** `pnpm add @starkware-libs/starknet-privacy-sdk` fails with

```
npm error 403 Forbidden - GET https://npm.pkg.github.com/@starkware-libs%2fstarknet-privacy-sdk
npm error Permission permission_denied: The token provided does not match expected scopes.
```

The local `gh` token has scopes `gist, read:org, repo, workflow` — **`read:packages` is missing**.
`docs/strk20-notes.md` §1 names the fix (`gh auth refresh -h github.com -s read:packages`) but that
is an interactive device-flow, so it is an **owner action**.

**Decision:** unblock locally without weakening the install. The SDK monorepo is public (Apache 2.0),
so we cloned it, ran `npm ci && npm run build` in `sdk/`, `npm pack`ed the result, and installed the
tarball from a **gitignored** `vendor/` directory. No `--force`, no skipped integrity checks — the
artefact is the SDK's own build output.

**Reproducibility:** `./scripts/vendor-sdk.sh` rebuilds the identical tarball from the pinned
commit, so `pnpm install` works on a fresh clone without the scope. The lockfile references
`vendor/…tgz`, which is gitignored — run that script first on a clean checkout.

**Revert condition:** as soon as the `read:packages` scope exists, swap the `file:` specifier in
`package.json` and `packages/core/package.json` back to a registry version and delete `vendor/`.
The vendored tarball is deliberately **not committed** so the repo never ships a pre-release build.

### D-006 — Three proving modes, so the flow stays testable while proving is blocked

`PROVING_SERVICE_URL` is unknown (D-004), and a private transfer cannot land on-chain without a real
STARK proof. Rather than fake a proof, the smoke test uses the two mock paths the SDK **already
supports**, and keeps them as first-class modes:

| `--mode` | Chain | Proofs | Submits | Answers |
|---|---|---|---|---|
| `mock` | none (in-memory `Mocknet`) | `MockProofProvider` | applies to mock pool | Is our *flow choreography* right? |
| `simulate` | live Sepolia | SDK's internal mock prover via `.simulate({ node })` | no | Is our *wiring against the live pool* right? |
| `service` | live Sepolia | real proving service | yes | Gate G1 proper |

This is not a workaround we invented: `simulate()` is the SDK's documented fee-estimation path and
runs the full compile pipeline (discovery → note selection → calldata) against real pool state.

### D-007 — `ContractDiscoveryProvider` ships from the `/testing` subpath (revises D-001)

D-001 chose `ContractDiscoveryProvider` as our default to avoid an indexer dependency. The SDK
exports it from **`@starkware-libs/starknet-privacy-sdk/testing`**, not the package entry point, and
its README calls it "best for development and testing"; `IndexerDiscoveryProvider` is the documented
production choice. It also takes a **pool contract object**, not an address.

**Decision:** keep it for Phase S (no external dependency beats production-shaped for a spike), but
D-001 is no longer safe to carry into production unexamined. `packages/core` already prefers
`IndexerDiscoveryProvider` whenever `INDEXER_URL` is set. **Re-decide before Phase M** — shipping a
mainnet product on a provider the vendor labels "for testing" is a judging risk as well as a
technical one.

### D-008 — Corrections to docs/strk20-notes.md, verified against SDK types

Logged per CLAUDE.md ("where its plan conflicts with the notes, log the conflict"). Here the
conflict is with the notes themselves; `docs/strk20-notes.md` has been amended.

1. **`ContractDiscoveryProvider` import path and argument** — see D-007. Notes §2 implied the package
   entry point and an address.
2. **The 10-block rule also covers transparent transactions.** Notes §4 framed it as note maturity
   only. Per the SDK README, any on-chain state the proof reads must be ≥10 blocks old — including
   an account's `deploy` before `register()`, and an ERC-20 top-up before `deposit()`. This is a
   real sequencing hazard for the agent: a burst payer that shields and immediately spends will fail.
   (Reinforces why `packages/core/src/notes.ts` matters.)
3. **Submission shape.** `execute()` returns `{ callAndProof, registry, warnings }`; the caller
   submits with `account.execute(callAndProof.call, { tip: 0n, proofFacts: …proof.proofFacts,
   proof: …proof.data })`. `tip: 0n` confirmed mandatory.
4. **Stale README examples (not the notes' fault, but worth pinning).** The SDK README shows
   `simulate({ provider })` — the type is `{ node }`; and a JSDoc example shows `deposit(100n)` —
   the type is `deposit({ amount })`. Trust `dist/interfaces.d.ts`.
5. **`ContractDiscoveryProvider` needs a *typed* pool contract.** It calls the pool's view methods
   by name (`get_public_key`, `get_note`, `channel_exists`, …), so it wants
   `new Contract({ abi: PrivacyPoolABI, address, providerOrAccount }).typedv2(PrivacyPoolABI)` —
   the ABI is exported from the `/abi` subpath. A generic `{ call() }` shim typechecks through a
   cast and then dies at runtime on the first view call; that is exactly what happened on the first
   live run.
6. **`simulate()` still needs a proving provider.** It builds its own `CallMockProofProvider`
   internally and never calls `prove()` on the configured one — but `createProofInvocation()` asks
   the configured provider for `getDefaultDetails()` (pool nonce, chainId) while compiling. Pass
   `new CallMockProofProvider(node, chainId)` in simulate mode; a stub that throws on every method
   will fail at compile time, not proving time.
7. **Not a correction:** notes §2's `provingProvider: { url, chainId }` is valid. The factory accepts
   `ProofProviderInterface | ProofProviderConfig` and builds the production provider from a config.

### D-009 — Gate G1 status at end of Day 1: **PARTIAL / open — do not pivot**

Evidence (`smoke-report*.json`; reproduce with `pnpm smoke:mock` / `pnpm smoke:simulate`).

**`--mode=mock`: 7/7 steps pass.** register (both parties) → shield → discoverNotes → private
transfer → *recipient-side note verification* → withdraw. Builder chains, channel setup and note
handling are correct.

**`--mode=simulate`: runs against the live Sepolia pool with the real signer.** Preflight fully
green — RPC (spec `0.10.3-rc.0`), pool `0x0254a6…0d91`, STRK token, account
`0x76bdc7…4062` deployed and funded (2999.94 STRK), `provingBlockId = head − 10`. Then:

| Step | Result |
|---|---|
| `discoverRequirement` | `Register (0)` — the live pool correctly reports our fresh account as unregistered |
| `discoverNotes` | 0 notes — correct, nothing shielded yet |
| `shield (simulated)` | **56 felts of `apply_actions` calldata, node-simulated, ~670 ms** |
| `private transfer`, `withdraw` | *not applicable* — see below |

The shield simulation is the strongest signal available today: `CallMockProofProvider` runs the
invocation through the node's transaction simulation and captures what the pool would have emitted.
The pool contract really executed our calldata.

The two spending steps are **not applicable, not broken**. `simulate()` does not mutate state, so
the shield above created nothing on-chain, and there are no notes to spend. Landing a real deposit
needs a real STARK proof — every pool transaction goes through `apply_actions` with `proof` +
`proofFacts`, and a mock proof will not verify on-chain. So this is precisely the ceiling of what is
reachable without the proving service; the script reports it as a skip with a reason rather than a
red failure.

**Blocked, precisely:**

| What | Owner | Status |
|---|---|---|
| Sepolia signer | Enes | ✅ **cleared** — generated by `pnpm keys:gen`, deployed in `0x300f9d…4ba1` |
| `PROVING_SERVICE_URL_SEPOLIA` | upstream | ⛔ open — strk20-hackathon#147 |
| `read:packages` scope (D-005) | Enes | ⛔ open — `gh auth refresh -h github.com -s read:packages` |

**Nothing failed for a reason inside our control**, which is the distinction G1 turns on. Two real
bugs were found by running rather than by reading, and both are fixed:

1. A deposit needs `autoSetup: true` — a note cannot be created before its **token subchannel**
   exists. The mock pool's `Token <n> does not exist` is a *subchannel* assertion, not a missing
   ERC-20.
2. `ContractDiscoveryProvider` needs a typed pool `Contract`, not a `{ call() }` shim (D-008.5).
   This only surfaced against the live chain — mock mode passes either way, because `Mocknet`
   supplies its own pool object.

**Therefore G1 stays open.** PLAN.md's trigger for the Wallet-API fallback is "still red by end of
Day 3", and red means *our* code fails — not that a third party has not replied. `pnpm smoke:sepolia`
is wired and waiting; that run, not this one, decides G1.

### D-010 — Sepolia signer is generated by tooling, not by hand

The live run needs an `ACCOUNT_ADDRESS` / `ACCOUNT_PRIVATE_KEY` / `VIEWING_KEY` triple, and doing
that by hand is four fiddly steps. `scripts/gen-smoke-keys.ts` (`pnpm keys:gen`) does the two
mechanical ones and leaves the two that are genuinely the owner's.

Constraints it encodes, all of which are easy to get wrong by hand:

- **Viewing key range is `[1, MAX_VIEWING_KEY]` where `MAX_VIEWING_KEY = CURVE.n / 2`** — *half* the
  curve order. `randomPrivateKey()` overshoots roughly half the time, so the script uses rejection
  sampling (a modulus would skew the distribution, and this is key material). `resolveSigner` now
  rejects out-of-range keys too, turning a confusing failure deep inside the SDK into a config error.
- **Keys are written directly into `.env` and never printed.** Only the public account address
  reaches stdout — so the secrets never enter an agent transcript, by construction (hard rule 1).
- **Sepolia only.** Refuses to run when `KESE_NETWORK=mainnet`; mainnet key custody is the owner's.
- **Counterfactual address**, derived from the public key, so the account can be funded before it is
  deployed. The OpenZeppelin account class `0x061dac0…71b8f` is already declared on Sepolia
  (verified via `starknet_getClass`; its ABI confirms a single `public_key` constructor arg), so no
  declare step is needed.
- **Refuses to overwrite an existing signer** without `--force` — the old account may hold funds.

This account is a hot test key holding faucet funds. It is not to be reused anywhere real.
