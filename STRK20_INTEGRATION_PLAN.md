# STRK20 Privacy Integration Plan — Kese

Generated 2026-08-21 by the strk20-privacy-integration skill. Statuses were current at generation
time; re-verify anything marked *tracked* before building against it.

This plan covers **Phase B** of `PLAN.md` (core wallet + MCP). Phase S is already done and its
findings are the ground truth here — see `docs/decisions.md` D-005..D-013.

## 1. Project snapshot

- **Stack**: TypeScript, NodeNext ESM, pnpm workspaces, Node ≥ 24. `starknet@10.5.0`,
  `@starkware-libs/starknet-privacy-sdk@0.14.3-rc.5`. Vitest. No frontend yet
  (`apps/dashboard` is a README only). Cairo in `contracts/escrow-claim` is Phase C.
- **Relevant code**:
  - `scripts/day1-sepolia-smoke.ts` — **the working reference**: real `createPrivateTransfers`
    wiring, discovery, `provingBlockId`, submission shape. Phase B lifts this into a library.
  - `packages/core/src/config.ts` — network/signer resolution + `createRedactor`. Done, tested.
  - `packages/core/src/index.ts:8` — `KeseWallet` interface, still a stub. **This is the build target.**
  - `packages/core/src/notes.ts` — denomination ladder, stub. The novel piece.
  - `packages/policy/src/engine.ts` — `decide()`, done, 44 tests. Every money path routes through it.
  - `packages/mcp/src/tools.ts` — tool names only, no server yet.
  - `packages/approvals/src/index.ts` — `ApprovalChannel` interface, no implementation.
- **Privacy goal**: hide *who the owner's AI agent pays, how much, and to whom*. The owner shields
  once; every subsequent agent payment is an in-pool transfer. Not a goal: hiding the shield itself
  (impossible — see §3) or hiding activity from the owner (viewing-key reports are a feature).
- **Environment**: Sepolia through Phase M, mainnet from Day 8 with tiny amounts. The agent's
  signer is a server-held key; the owner's own wallet (Ready) is only for onboarding.

## 2. Chosen route: Privacy SDK direct

Kese runs its own Starknet account server-side and holds the viewing key in server env, so it is
squarely the SDK route — the agent must act autonomously without a human tapping a wallet for every
payment. The Wallet API route stays in reserve as the Gate G1 fallback (`docs/decisions.md` D-002):
if SDK-route proving never materialises, the agent proposes and the owner's Ready wallet approves.

**The rule this follows:** Kese owns its accounts and keys, so it may use the SDK directly. The
inverse rule still binds us internally — the *LLM* is treated exactly as a dapp would be: it never
sees the viewing key, the signer key, notes, or proofs. `packages/core` holds those; the MCP layer
returns balances and receipts only. That is what `createRedactor` in `config.ts` enforces.

## 3. What this delivers — hidden vs visible

| Private (inside the pool) | Public (visible onchain) |
|---|---|
| Who the agent paid, and who paid them | The owner's shield: depositing address and amount |
| Payment amounts and token | Any withdrawal: recipient address and amount |
| Which notes were spent | The fact and timing of any pool interaction |
| The agent's shielded balance | Claim-link escrow amounts (open notes carry plaintext amounts) |

Honest limits, to be repeated verbatim in UX copy and the README:

- **Shielding is public by design.** Deposits name the depositor and the amount, and are screened
  on-chain (FPI). Privacy starts *after* the funds are in the pool. No Kese copy may suggest
  otherwise.
- **Never bundle a shield with the payment it funds.** One transaction carrying both publishes
  "this address deposited X" right beside the transfer it paid for, and the two correlate
  trivially. Kese shields as a separate, earlier transaction — which costs an extra fee and a
  maturity wait, and is the difference between looking private and being private. This is a
  structural argument for the denomination ladder (§5), not just a throughput one.
- **Claim links leak the amount.** The escrow credits the claimer through an `OpenNoteDeposit`, and
  open notes carry their amount in plaintext. The recipient stays hidden; the amount does not.
  Say so on the claim page.
- **Distinctive amounts weaken anonymity.** Round denominations are a privacy measure, not just
  ergonomics.

## 4. Prerequisites & versions

- `@starkware-libs/starknet-privacy-sdk@0.14.3-rc.5` — currently vendored from source
  (`./scripts/vendor-sdk.sh`) because the `gh` token lacks `read:packages` (D-005).
- `starknet@10.5.0` — pinned to match the SDK's own dependency. `10.7.0` is on `next`; do not
  chase it mid-sprint.
- `@modelcontextprotocol/sdk` — for `packages/mcp` (stdio transport).
- Telegram bot token + owner chat id — already in `.env`.
- **Blocked:** `PROVING_SERVICE_URL_SEPOLIA` (strk20-hackathon#147). Everything below is buildable
  and testable without it; only the final on-chain submission is not.

## 5. Phase B1 — `packages/core`: the SDK wrapper ✅ done 2026-08-21

Lift the proven wiring out of `scripts/day1-sepolia-smoke.ts` into `KeseWallet`:

1. `packages/core/src/wallet.ts` — `createKeseWallet(config)` implementing `KeseWallet`:
   `register`, `shield`, `payPrivate`, `withdraw`, `balances`, `activity`, `discoverNotes`.
2. Carry over the Phase S corrections rather than re-deriving them: typed pool `Contract` for
   `ContractDiscoveryProvider` (D-008.5), `provingBlockId = head − 10`, `tip: 0n`, the 10-block
   wait between chained transactions, `autoSetup: true` on any note-creating action.
3. `PROVING_MODE` stays a first-class concept (D-006), so core is testable with no prover.
4. Keep the smoke script working against the new library — it becomes the integration test.

**Delivered.** `wallet.ts` (KeseWallet), `chain.ts` (submitter + block-depth sequencing),
`factory.ts` (live wiring), `proving.ts` (proof timing). `scripts/day1-sepolia-smoke.ts` now drives
`@kese/core` rather than reproducing the setup, so the integration test exercises the shipped code.
24 new unit tests run the SDK's **real** builder/compiler/note-selection against its in-memory pool
— only the submit seam is swapped. Verified on live Sepolia: `discoverRequirement → Register (0)`,
shield compiled and executed by the node in ~770 ms.

Two design rules are baked into the API rather than left to callers:

- **No shield-and-pay convenience method, ever.** Bundling a deposit with the transfer it funds
  correlates the two publicly. If someone later adds one call that does both, that is a privacy
  regression, not a convenience.
- **Failures return receipts, not exceptions.** Every caller is on a money path that has already
  reserved budget and must release it; `Receipt.status === "failed"` makes that part of the return
  type instead of a try/catch each caller has to remember.

## 6. Phase B2 — `packages/core/src/notes.ts`: the denomination ladder ✅ done 2026-08-21

The problem: change notes mature 10 blocks after creation, so a burst-paying agent stalls behind
its own change. The strategy: keep the shielded balance split across a ladder of round
denominations so several payments can be funded from distinct mature notes in parallel.

- `planLadder(balance, denoms)` — target split for a balance.
- `selectNotes(amount, matureNotes)` — pick mature notes covering an amount, preferring exact
  change so a payment creates no new change note at all.
- `rebalanceAfter(payment)` — opportunistically re-split, never in the same transaction as a payment.

Round denominations do double duty: they are what makes parallel payments possible *and* they blunt
amount-fingerprinting (§3). Unit-testable with no chain — do it under vitest like the policy engine.

**Delivered** as `planLadder` / `selectNotes` / `ladderGaps`, 19 tests. Three decisions worth
carrying forward:

- **Ladder + reserve, not a full split.** The first draft also parked the remainder across the
  ladder largest-first — minimal change-making, and the wrong goal. The top denomination is fixed,
  so a balance far above it shreds: a million units against a ladder topping out at 100 produced
  **10,019 notes**, each carrying a pool fee, for no extra parallelism (the burst quota was already
  met). Now the surplus stays as one reserve note that rebalances draw from. Note count tracks the
  ladder's shape, never the balance. A test caught this, not review.
- **Exact change is the goal, not a nicety.** A payment whose notes sum exactly creates no change
  note, so nothing new has to mature and the rest of the ladder stays spendable. `selectNotes`
  searches for an exact subset first (bounded DFS, greedy fallback).
- **Unknown maturity fails closed.** `Note.created` is optional in the SDK; absent means "treat as
  immature". Spending a note that turns out to be immature produces an invalid proof, and
  "insufficient balance" is a far more legible failure than a proof rejection.

**Open — owner's call:** `DEFAULT_BURST = 3` is the tuning knob and it is a product decision, not a
technical one. Higher means more concurrent payments but more notes to mint up front; lower means
cheaper shielding but an agent that stalls sooner. Three matches the demo script.

## 7. Phase B3 — `packages/mcp`: tools ✅ done 2026-08-21

Tools: `get_balance`, `pay_private`, `create_claim_link`, `withdraw`, `list_activity`, `get_policy`.

Non-negotiables, enforced by the tool layer:

- **Every money-moving tool requires `idempotency_key`.** The policy engine already denies a
  reused key carrying a different request; the schema must make the parameter mandatory so an LLM
  cannot omit it.
- **No tool calls `packages/core` transfer functions directly.** The only path is
  `policy.decide()` → (approval if needed) → `core` → `commitReservation`/`releaseReservation`.
  A `releaseReservation` on every failure path is not optional — a dropped reservation silently
  holds budget until the rolling window slides past it.
- **Outputs never carry key material**, and errors pass through `createRedactor` before they reach
  a tool result.
- `list_activity` reads the pool's **`Deposit` event and filters on its first indexed key
  (`user_addr`)** — never the transaction sender. Private transactions are relayed, so every
  transaction's sender is the relayer; grouping by sender would attribute every shield in the pool
  to one address and neither query throws. This applies to the dashboard in Phase M too.

Use the Anthropic `mcp-builder` skill for schema quality and server wiring (CLAUDE.md "Skills").

**Delivered.** Six tools over stdio, 46 tests. Tool names carry a `kese_` prefix (D-018) — with
several MCP servers connected a bare `withdraw` is ambiguous, and for a money tool the model
resolving that by guessing is a safety problem. Amounts are whole-token decimal strings (D-019).
Execution idempotency is enforced separately from decision idempotency (D-020): `spend()` reads the
reservation's outcome before executing, so a replayed key returns the stored receipt instead of
paying twice. `list_activity` currently serves Kese's own decision log — which includes denials that
never reached the chain — and the on-chain view (reading the pool's `Deposit` event and filtering on
its first indexed key, never the transaction sender) is still to come with the dashboard.

## 8. Phase B4 — `packages/approvals`: Telegram ✅ done 2026-08-21

`needs_approval` ticket → message stating agent, amount, token, recipient, remaining daily budget,
and **which rule fired** (`Decision.reason` already carries this) → inline Approve/Deny → resume.

- Timeout ⇒ **deny and release the reservation** (fail closed, hard rule 4).
- Tickets persist in SQLite so a server restart mid-approval does not strand a held reservation.
- Because caps are absolute (D-011), no approval request ever asks the owner to exceed a cap — the
  only approvals that reach a human are ones policy already considers legitimate.

## 9. Testing

- Vitest for `core` (ladder, config) and `policy` (done). `snforge` for Cairo in Phase C.
- `pnpm smoke:mock` and `pnpm smoke:simulate` are the regression gate for the SDK wiring; both must
  stay green as core is refactored underneath them.
- End-to-end acceptance (`PLAN.md` Phase B): a private payment on Sepolia driven from Claude Desktop
  over MCP, plus a Telegram approval on a limit breach. **The payment half is gated on #147.**
- The MCP + policy + approval path is fully testable today with `PROVING_MODE=mock`.

## 10. Compliance & security notes

- Deposit screening is enforced on-chain by the protocol on every route. Self-hosted proving does
  not bypass it, and nothing in Kese should be described as if it could.
- Selective disclosure via viewing keys exists so the owner can answer a legitimate request without
  exposing unrelated users. It is not automatic compliance and carries no endorsement; Kese's own
  copy should present it as "privacy from the world, not from you".
- The escrow contract in `contracts/escrow-claim` is **our** code to write, review and audit. The
  reference is unofficial and unaudited. This skill never generates Cairo; Phase C is manual work.

## 11. Open items to re-verify at build time

- `PROVING_SERVICE_URL` — strk20-hackathon#147, still unanswered.
- `read:packages` scope, to drop the vendored SDK (D-005).
- **Skill drift found by `check_freshness.py` on 2026-08-21:** the monorepo's
  `packages/sub_account_anonymizer` is gone and `packages/shadow_account_anonymizer` has appeared;
  the SDK exports `ShadowAccountAnonymizerABI` and `build().shadowAccounts(dappName)`, and the
  factory takes `shadowAccountAnonymizerAddress`. The skill's reference files still say
  "sub-accounts". Kese does not use this feature, so it is a naming note only — logged per
  CLAUDE.md's instruction to record skill/notes conflicts.
- `get-starknet` pins moved (6.0.3 → 6.0.4/6.0.5). Irrelevant while we are on the SDK route; it
  matters only if Gate G1 forces the Wallet-API fallback.

## 12. Links

- Privacy SDK monorepo (Apache 2.0): https://github.com/starkware-libs/starknet-privacy — the
  `sdk/README.md` quickstart supersedes any setup prose elsewhere.
- SDK route by-example: https://strk20-by-example.org/sdk/getting-started ·
  https://strk20-by-example.org/sdk/setup-requirements · https://strk20-by-example.org/sdk/register ·
  https://strk20-by-example.org/sdk/deposit · https://strk20-by-example.org/sdk/transfer ·
  https://strk20-by-example.org/sdk/withdraw · https://strk20-by-example.org/sdk/proving-config
- Whitepaper: https://eprint.iacr.org/2026/474
- Kese's own ground truth: `docs/strk20-notes.md`, `docs/decisions.md` (D-005..D-013).
