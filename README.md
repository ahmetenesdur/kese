# Kese 👛

**Private money for AI agents.** Kese gives any LLM agent a policy-guarded spending account on Starknet's STRK20 privacy pool — pay privately, within hard limits, with human approval above thresholds, and a full audit trail for the owner.

> *Kese* (Turkish): a money pouch. Your agent gets the pouch, never the vault.

## Why

Every agent-payment rail today (x402, agentic wallets, card rails) is fully transparent: anyone can watch what your agent pays, to whom, and when. And giving an LLM your keys is how wallets get drained. Kese solves both at once:

- **Private**: in-pool STRK20 transfers hide sender, recipient, and amount.
- **Safe**: deterministic policy engine between the LLM and the money — per-tx & daily caps, recipient allowlist, human approval over Telegram, idempotency so a retrying model can never double-pay. Keys never enter the LLM's context.
- **Accountable**: viewing-key-based spend reports for the owner (privacy from the world, not from you). *Privacy, not secrecy.*
- **Pays anyone**: claim-link escrow contract lets the agent pay even unregistered recipients — one link, they claim when they join. Unclaimed funds refund after expiry (our extension to the reference escrow).

## How it works

```
Claude / any MCP agent
        │  MCP tools: get_balance · pay_private · create_claim_link · withdraw · list_activity
        ▼
┌───────────────────────── Kese server ─────────────────────────┐
│  Policy engine (allow / deny / needs-approval)  → Telegram ✅ │
│  Idempotency + reservation locks (burst-safe)                 │
│  STRK20 SDK: register · shield · private transfer · notes     │
│  Note denomination ladder (parallel payments vs 10-block wait)│
└──────────────┬────────────────────────────────┬───────────────┘
               ▼                                ▼
     STRK20 privacy pool (mainnet)     escrow-claim contract (Cairo)
```

Owner-side: shield once from Ready wallet, set policies, watch the dashboard, export the auditor report.

## Judging-criteria map (STRK20 Private Sprint)

| Criterion | Where Kese scores |
|---|---|
| STRK20 depth (30%) | register + shield + private transfers + note discovery + denomination management + custom `privacy_invoke` escrow contract (deployed) + viewing-key reporting |
| Mainnet product (30%) | live pool integration, ≥3 mainnet txs in `strk20.json`, public demo |
| Innovation (25%) | first agent-native wallet on the pool: policy guardrails, LLM-safe tool design (idempotency), claim links with refund |
| Docs (15%) | this README, `docs/`, `llms.txt`, honest privacy-limitations section |

## Quickstart

```sh
# Node >= 24, pnpm. The SDK ships via GitHub Packages, so npm needs a token with read:packages:
gh auth refresh -h github.com -s read:packages          # once
npm config set '//npm.pkg.github.com/:_authToken' "$(gh auth token)"
pnpm install

bash scripts/setup-skills.sh   # STRK20 + Anthropic agent skills (see CLAUDE.md "Skills")
cp .env.example .env           # fill: RPC, account, viewing key, proving URL
```

On Sepolia you can generate the agent's signer in one step — it writes the keys straight into
`.env` and never prints them:

```sh
pnpm keys:gen            # generate + write .env, print the address to fund
# ...fund that address with Sepolia STRK from a faucet, then:
pnpm keys:gen --deploy   # deploy the account on-chain
```

Verify the STRK20 integration end to end. The smoke test runs at three levels of reality, so
you can validate the flow before you have credentials or a proving service:

```sh
pnpm smoke:mock       # in-memory pool — no chain, no keys, no proving service
pnpm smoke:simulate   # live Sepolia pool + real discovery, SDK mock prover, nothing submitted
pnpm smoke:sepolia    # the real thing: real proofs, real transactions
pnpm test             # unit tests
```

Every run prints a preflight, says exactly what is blocked and who can unblock it, and writes
`smoke-report.json`.

## Connect it to an agent

Build once, then point any MCP client at the server. It talks stdio, because it holds the signing
key and should not be reachable over a network at all.

```sh
pnpm build
```

```json
{
  "mcpServers": {
    "kese": {
      "command": "node",
      "args": ["/absolute/path/to/kese/packages/mcp/dist/index.js"],
      "env": { "KESE_NETWORK": "sepolia" }
    }
  }
}
```

The server **refuses to start without a spending policy** — a wallet server that came up with no
limits would be worse than one that failed, because the agent would find it working. Six tools:
`kese_get_balance`, `kese_get_policy`, `kese_list_activity`, `kese_pay_private`, `kese_withdraw`,
`kese_create_claim_link`. Every money tool requires an `idempotency_key`, and amounts are whole
tokens (`"1.5"`), never base units.

## Honest privacy limitations

Deposits/withdrawals are public by design (privacy starts in-pool). Distinctive amounts and tight timing weaken anonymity — Kese uses round denominations and randomized batching to help. Deposits are compliance-screened (FPI). See `docs/strk20-notes.md` §8.

## Repo map

`CLAUDE.md` build guide for coding agents · `PLAN.md` build plan · `docs/` protocol notes + architecture · `packages/` core / policy / mcp / approvals · `contracts/escrow-claim` Cairo helper · `SUBMISSION.md` hackathon checklist.

MIT © 2026 Ahmet Enes Dur
