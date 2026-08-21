# Kese 👛

**Private money for AI agents.** Kese gives any LLM agent a policy-guarded spending account on
Starknet's STRK20 privacy pool — it pays privately, within hard limits, asks a human above a
threshold, and leaves the owner a complete audit trail.

> *Kese* (Turkish): a money pouch. Your agent gets the pouch, never the vault.

MIT · Node ≥ 24 · TypeScript + Cairo · 301 TS tests, 19 Cairo tests

---

## Why

Every agent-payment rail today — x402, agentic wallets, card rails — is fully transparent: anyone
can watch what your agent pays, to whom, and when. And handing an LLM a private key is how wallets
get drained. Those are usually treated as two problems. Kese treats them as one, because the fix
for each makes the other worse if you do it naively: privacy removes the audit trail you needed to
constrain the agent, and constraint usually means a custodian who can see everything.

- **Private** — in-pool STRK20 transfers hide sender, recipient and amount.
- **Bounded** — a deterministic policy engine sits between the model and the money: per-tx and
  daily caps, recipient allowlist, Telegram approval above a threshold, and idempotency so a
  retrying model can never double-pay. The keys are never in the model's context.
- **Accountable** — viewing-key spend reports for the owner. *Privacy from the world, not from you.*
- **Pays anyone** — a claim-link escrow contract lets the agent pay recipients who have never
  touched the pool. Unclaimed funds refund after expiry.

## See it work in 60 seconds

No keys, no chain, no proving service, no `.env` — the SDK ships an in-memory pool, and the smoke
test drives the real STRK20 flow against it:

```bash
pnpm install && pnpm smoke:mock
```

```
✅ Node >= 24                     v24.19.0
✅ Privacy SDK importable         @starkware-libs/starknet-privacy-sdk@0.14.3-rc.5
✅ Mode                           mock — in-memory pool, no chain/keys/proving needed

✅ register (alice)               viewing key published — 2ms
✅ register (bob)                 recipient registered — 1ms
✅ shield (deposit)               100 shielded — 19ms
✅ discoverNotes                  1 note(s), total 100 — 13ms
✅ private transfer               50 → bob — 41ms
✅ recipient sees note            1 note(s), total 50 — 13ms
✅ withdraw                       25 → public balance — 23ms
```

The same script runs at three levels of reality, so you can raise the stakes one at a time:

| | chain | keys | proofs | submits |
|---|---|---|---|---|
| `pnpm smoke:mock` | in-memory | — | — | — |
| `pnpm smoke:simulate` | **live pool** | ✅ | SDK mock prover | — |
| `pnpm smoke:sepolia` | **live pool** | ✅ | **real** | ✅ |

Every run prints a preflight, says exactly what is blocked and who can unblock it, and writes
`smoke-report.json`.

## How it works

```
Claude / any MCP agent
        │  6 tools: get_balance · get_policy · list_activity · pay_private · withdraw · create_claim_link
        ▼
┌───────────────────────────── Kese server (stdio, holds the key) ─────────────────────────────┐
│  Policy engine — allow / deny / needs-approval, atomic reservation, idempotency ──► Telegram  │
│  STRK20 wallet — register · shield · discover notes · private transfer · withdraw             │
│  Note ladder — split balance into denominations so bursts of payments don't queue             │
└──────────────────────┬─────────────────────────────────────────┬─────────────────────────────┘
                       ▼                                         ▼
            STRK20 privacy pool                    escrow-claim contract (Cairo)
                                                   one privacy_invoke per pool tx
```

Owner-side: shield once, set the policy, watch the local dashboard, export the CSV for an
accountant.

## STRK20 integration

Where the depth actually is — the protocol facts that cost us time, and what we do about them.
Long form in [`docs/strk20-notes.md`](docs/strk20-notes.md).

| Protocol reality | What Kese does |
|---|---|
| Notes mature **10 blocks** after creation; proofs are valid ~450 | Always prove against `head − 10`, re-fetch after every `waitForTransaction`, and refuse rather than guess when a note is not yet provable ([`chain.ts`](packages/core/src/chain.ts)) |
| Change notes also need those 10 blocks, so a burst of payments serialises | The **note ladder**: shield splits the balance into denominations so several payments draw on distinct mature notes at once ([`notes.ts`](packages/core/src/notes.ts)) |
| Private txs are **relayed** — `transaction.sender` is the relayer, identical for everyone | Attribution reads the pool's `Deposit` event `user_addr` key, never the tx sender. Verified against mainnet: 16 deposits, 10 distinct depositors ([`activity.ts`](packages/core/src/activity.ts)) |
| `Withdrawal` encrypts the initiator and indexes only the recipient | Unshields are **not** recoverable from the chain, so the dashboard sources them from Kese's own log and says so, instead of quietly under-reporting |
| `VIEWING_KEY` must be a bigint; a hex string silently misbehaves | Parsed and range-checked at load (`[1, n/2]`, with rejection sampling on generation) ([`config.ts`](packages/core/src/config.ts)) |
| v3 transactions require `tip: 0n` | Set at the submitter, not per call site ([`chain.ts`](packages/core/src/chain.ts)) |
| No indexer dependency wanted | `ContractDiscoveryProvider` over plain RPC, built from a typed pool `Contract` |
| Proving costs gas the pool does not quote you | Headroom check before every operation; `get_fee_amount` read from the chain (mainnet **6**, Sepolia **2** per private op) ([`fees.ts`](packages/core/src/fees.ts)) |
| One external `privacy_invoke` per pool transaction | The escrow is designed around that budget, and asserts its caller is the pool |

## The policy engine

The rule that shapes the whole codebase: **no tool calls a transfer function directly.** Every
money-moving path goes through [`packages/policy`](packages/policy), which decides in a fixed
order — validate, allowlist, token configured, per-tx cap, approval threshold, daily cap — and
returns `allow`, `deny(code)` or `needs_approval`.

Three properties it has to hold under an agent that retries:

- **Idempotency.** Every money tool takes an `idempotency_key`. The same key returns the original
  result and never re-executes. LLMs retry tool calls; this is not optional.
- **Atomic reservations.** Concurrent payments reserve against the daily cap inside a SQLite
  `BEGIN IMMEDIATE` before execution, and release on failure — so two payments that each fit the
  cap cannot both pass when only one fits.
- **Fail closed.** If the policy DB, the approvals channel, or proving is unavailable, the answer
  is deny. A wallet server that came up with no limits would be worse than one that failed,
  because the agent would find it working — so the MCP server refuses to start without a policy.

54 of the 301 tests are on this engine alone, including the race conditions.

## Claim links

The pool can only pay a registered recipient. Real payees are not registered. So Kese ships a small
Cairo helper ([`contracts/escrow-claim`](contracts/escrow-claim)) that the pool calls through
`privacy_invoke`: the agent pays the escrow against a commitment hash, and the recipient claims with
a secret handed to them in a link — registering only when they actually want the money.

The secret is generated server-side with a CSPRNG, only its hash is stored, and it is shown once.
Claim and refund hash under **separate domain tags**, so a link cannot be replayed down the other
path. Unclaimed funds refund to the payer after an expiry block — our extension to the reference
escrow, because an agent that pays a wrong address should not simply lose the money.

`apps/claim` is the recipient-facing page: it reads the secret from the URL **fragment**, so the
secret never reaches a server in a request line or a referrer header.

## Connect it to an agent

```bash
pnpm build
```

```json
{
  "mcpServers": {
    "kese": {
      "command": "node",
      "args": ["/absolute/path/to/kese/packages/mcp/dist/main.js"],
      "env": { "KESE_NETWORK": "sepolia" }
    }
  }
}
```

It reads the rest of its configuration from the repo's `.env`, which it locates by climbing from
its own directory — your MCP client can spawn it from anywhere. Anything already in the
environment (like `KESE_NETWORK` above) wins over the file.

On startup it writes a summary to **stderr**, where MCP clients collect server logs:

```
kese-mcp ready · sepolia · account 0x76bdc7…14062
  policy      /path/to/kese/kese-policy.sqlite
  approvals   telegram
  proving     NONE — payments compile and check, but cannot settle
```

stderr and not stdout, because on a stdio server stdout *is* the JSON-RPC channel — one stray
`console.log` is framed as a protocol message and breaks the client's parser.

It speaks **stdio**, deliberately: the process holds the signing key and should not be reachable
over a network at all. Amounts are whole tokens (`"1.5"`), never base units — a unit confusion
between a model and a wallet is a 10¹⁸× mistake. If configuration is incomplete it prints what is
missing and exits, rather than starting with tools an agent would find working.

## Security model

| | |
|---|---|
| **Keys** | `ACCOUNT_PRIVATE_KEY` and `VIEWING_KEY` live only in server env. A redactor scrubs them from every error before it can reach a log, a tool result, or a screenshot. They never enter the model's context. |
| **Transport** | stdio only. The owner dashboard binds to `127.0.0.1` and has no auth *because* it has no network path — it shows private balances, so exposing it would need auth first. |
| **Untrusted input** | The payment memo is written by an LLM repeating whatever it was told. The CSV export neutralises `=`, `+`, `-`, `@` — otherwise a refused payment is enough to run a formula in the owner's spreadsheet. |
| **Public demo** | The public demo is the *claim* page. The dashboard is never deployed. |

## Honest limits

The pool is not a cloak, and overstating it would be the easiest way to get someone hurt:

- **Deposits and withdrawals are public.** Privacy starts *inside* the pool. Kese has no
  shield-and-pay convenience call, ever — bundling a deposit with the transfer it funds publishes
  "this address deposited exactly X" right next to the payment.
- **Deposits are compliance-screened** (FPI). We do not promise deposit privacy anywhere in the UX.
- **Claim links reveal the amount.** The escrow pays through an *open* note, which carries a
  plaintext value. The recipient is hidden; the amount is not. The dashboard labels this
  `amount shown` rather than calling it private.
- **Distinctive amounts and tight timing weaken anonymity.** The note ladder helps by paying in
  round denominations, but a 137.42 STRK payment is still a 137.42 STRK payment.

## Status

| | |
|---|---|
| Sepolia | register / shield / discover / transfer / withdraw exercised end to end; escrow deployed at [`0x1ff4c7…3108`](https://sepolia.starkscan.co/contract/0x1ff4c7f216a9e1452e4533e03f926e2b10c7868a085b52c6034bcaa3cf3108) |
| Mainnet | pool reads verified against the live contract; the full flow compiles and node-executes in simulate mode. **No submitted mainnet transactions yet.** |
| Blocker | the mainnet **proving service URL is not public**. Everything up to proof submission runs; that one call cannot. Tracked upstream, with a self-hosted prover as the fallback — see [`docs/decisions.md`](docs/decisions.md) D-037/D-040. |
| `strk20.json` | still carries placeholders. It will list real hashes or none — not aspirational ones. |

## Build and test

```bash
pnpm test          # 301 TypeScript tests
pnpm typecheck     # builds every package, then checks the scripts
pnpm escrow:test   # 19 Cairo tests (needs scarb + snforge; everything else does not)
pnpm dashboard     # owner view on 127.0.0.1:5184
```

The Cairo tests were written *after* the contract, so they were graded by mutation testing —
deliberately breaking the contract to confirm each test fails. One did not, and was replaced.

`pnpm test` runs a shadow-artifact check first: compiled `.js` next to a `.ts` source once masked
new code for an hour while the suite stayed green, so the suite now refuses to run if that
recurs (`scripts/check-no-shadow.mjs`).

### Install

The SDK is published to **GitHub Packages**, so `pnpm install` needs a token with `read:packages`:

```bash
gh auth refresh -h github.com -s read:packages
npm config set '//npm.pkg.github.com/:_authToken' "$(gh auth token)"
pnpm install
```

The scope registry is already in this repo's `.npmrc`; the token is yours and is never committed.
Without a GitHub account, `scripts/vendor-sdk.sh` builds the identical artefact from the SDK's
public Apache-2.0 monorepo at its pinned release commit (verified byte-identical to the published
tarball).

## Repo map

| | |
|---|---|
| [`packages/core`](packages/core) | STRK20 SDK wrapper — wallet, notes, fees, claim links, escrow calldata |
| [`packages/policy`](packages/policy) | the guardrails: limits, allowlist, reservations, idempotency |
| [`packages/mcp`](packages/mcp) | the MCP server and its six tools |
| [`packages/approvals`](packages/approvals) | Telegram human-in-the-loop |
| [`contracts/escrow-claim`](contracts/escrow-claim) | Cairo `privacy_invoke` helper + refund extension |
| [`apps/claim`](apps/claim) | recipient claim page (static, the public demo) |
| [`apps/dashboard`](apps/dashboard) | owner view + CSV spend report (loopback only) |
| [`docs/`](docs) | [protocol notes](docs/strk20-notes.md) · [architecture](docs/architecture.md) · [decision log](docs/decisions.md) |
| [`CLAUDE.md`](CLAUDE.md) · [`PLAN.md`](PLAN.md) | build guide for coding agents · the 10-day plan |

MIT © 2026 Ahmet Enes Dur
