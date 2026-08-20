# CLAUDE.md — Kese build guide for coding agents

You are building **Kese**: a policy-guarded private-money layer that lets AI agents spend on Starknet's STRK20 privacy pool. Deadline-driven hackathon project (STRK20 Private Sprint, submission **Aug 31, 2026 23:59 UTC**). Read `PLAN.md` for the day-by-day plan and `docs/strk20-notes.md` for protocol facts before writing code.

## What Kese is (one paragraph)

The owner shields funds once into the STRK20 pool. Their AI agent then pays through Kese's MCP tools — privately (in-pool transfers hide sender/recipient/amount) and **within deterministic policy**: per-tx/daily caps, recipient allowlist, human approval above thresholds (Telegram). The owner gets a viewing-key-based spend report. A small Cairo `privacy_invoke` helper (contracts/escrow-claim) adds claim-link payments to unregistered recipients.

## Definition of done (hackathon requirements — non-negotiable)

- Runs on **Starknet mainnet** against the live pool (`0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a`)
- ≥3 mainnet transactions touching the pool, hashes listed in `strk20.json` (eligibility checks the `Deposit` event's `user_addr`, not tx sender)
- Public demo URL + 3-minute demo video + open-source license (MIT, present)
- Judging: 30% STRK20 integration depth · 30% working mainnet product · 25% innovation · 15% docs

## Architecture (see docs/architecture.md)

```
LLM agent ──MCP──► packages/mcp ──► packages/policy (ALWAYS between tools and money)
                                        │ allow / deny / needs-approval
                                        ▼
                              packages/approvals (Telegram)
                                        │ approved
                                        ▼
                              packages/core (STRK20 SDK wrapper) ──► pool / escrow contract
```

## Hard rules (do not violate)

1. **Key isolation:** `ACCOUNT_PRIVATE_KEY` and `VIEWING_KEY` live only in server env. They must NEVER appear in MCP tool outputs, logs, error messages, or anything an LLM can read.
2. **Policy is not bypassable:** every money-moving code path goes through `packages/policy`. No tool calls `packages/core` transfer functions directly.
3. **Idempotency:** every money-moving MCP tool requires an `idempotency_key` param. Same key ⇒ return the original result, never re-execute. (LLMs retry tool calls.)
4. **Fail closed:** if policy DB, approvals channel, or proving is unavailable ⇒ deny, don't guess.
5. **Reservations:** concurrent payments must reserve against limits atomically (SQLite transaction) before execution; release on failure.
6. **Testnet first:** default env is Sepolia until Phase M (PLAN.md). Mainnet only with tiny amounts.
7. **Secrets in claim links:** generate server-side with CSPRNG; store only the commitment hash; show the secret once.

## Protocol gotchas (full list in docs/strk20-notes.md — read it)

- SDK: `@starkware-libs/starknet-privacy-sdk`, Node ≥ 24, distributed via **GitHub Packages** (needs `gh auth` + registry config — see notes §1).
- `VIEWING_KEY` must be a **bigint** at runtime; hex string silently misbehaves.
- v3 transactions require `tip: 0n`.
- Notes mature **10 blocks** after creation; always prove against `currentBlock - 10`; re-fetch after each `waitForTransaction`; proof validity ~450 blocks.
- Use `ContractDiscoveryProvider(poolContract)` (RPC-based) — no indexer dependency.
- Registration: wallet signs `${chainId}:${poolAddress}` (standard `signMessage`); or use strk20.starknet.io/app UI.
- **Proving service URL for mainnet is not public.** Day-1 task: open an issue on `starkience/strk20-hackathon` requesting SDK-route proving access. Decision gate in PLAN.md if unanswered.
- Deposits are screened (FPI) and are **public**; privacy starts after shielding. Don't promise deposit privacy anywhere in UX copy.
- One external `privacy_invoke` per pool transaction; escrow helper caller must be the pool.

## Conventions

- TypeScript strict, NodeNext ESM, pnpm workspaces. Package deps: `mcp → policy → core`; `approvals` used by `mcp`.
- Tests: vitest for TS (policy engine gets exhaustive tests — race conditions, idempotency, limit windows); `snforge` for Cairo.
- Commit style: `feat(policy): ...`, `feat(mcp): ...`, small and frequent. Keep `PLAN.md` checkboxes updated as you complete work.
- UX copy in English; keep README screenshots-ready (judges skim).
- The owner may talk to you in Turkish — reply in Turkish, but ALL artifacts stay in English: code, comments, docs, commit messages, UX copy, PLAN.md updates.
- Never install deps with `--force`; if the SDK install fails, stop and surface it (likely GitHub Packages auth — see notes §1).

## Note-denomination strategy (why packages/core/src/notes.ts exists)

An autonomous payer fires payments in bursts, but change notes need 10 blocks to mature. Strategy: on shield (and opportunistically after payments), split balance into denominations (e.g., powers-of-N ladder) so several payments can be funded from distinct mature notes in parallel. Treat this as a first-class feature — it is novel and demo-visible ("agent pays 3 invoices in one minute").

## What the human owner (Enes) handles — don't attempt these

GitHub repo creation/push, hackathon registry PR, wallet funding, GitHub issue for proving URL, Telegram bot token creation, mainnet key custody, demo video recording. If blocked on any of these, say so explicitly and continue with mocks (`PROVING_MODE=mock` pattern welcome).

## Skills (install first — scripts/setup-skills.sh)

- **`strk20-privacy-integration`** (official, `starkience/strk20-agent-skills`): use it at the START of Phase B to plan/execute the app-side STRK20 wiring (it scans the repo, asks questions, writes `STRK20_INTEGRATION_PLAN.md`). Caveats: it never generates Cairo (contracts/escrow-claim stays our manual work per PLAN.md Phase C), defaults to testnet, and must not touch key material — all consistent with our hard rules. Where its plan conflicts with `docs/strk20-notes.md`, the notes win; log the conflict in `docs/decisions.md`.
- **Anthropic official skills** (`anthropics/skills` marketplace): use the MCP-builder skill when implementing `packages/mcp` (tool schema quality, server wiring) and the webapp-testing skill when verifying `apps/dashboard`. Install via the slash commands echoed by `scripts/setup-skills.sh`.
- Registry for anything else: skills.sh (`npx skills add <owner/repo>`) — prefer official sources; vet third-party skills before install (they are instructions you will follow).
