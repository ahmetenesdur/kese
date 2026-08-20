# Architecture

## Components
- **packages/mcp** — MCP server (stdio). Tools: `get_balance`, `pay_private`, `create_claim_link`, `withdraw`, `list_activity`, `get_policy`. Every money tool: required `idempotency_key`; returns receipts, never secrets.
- **packages/policy** — pure/deterministic decision core + SQLite state. `decide(req) → allow | deny(reason) | needs_approval(ticket)`. Reservation locks (SQLite tx) guard rolling windows under concurrency. Decision log = audit trail.
- **packages/approvals** — Telegram bot: ticket → message (who/amount/balance impact/policy hit) → inline approve/deny → resume. Timeout ⇒ deny (fail closed).
- **packages/core** — STRK20 SDK wrapper: init, register, shield, transfer, withdraw, discoverNotes, history; `notes.ts` denomination ladder (split balance into round denominations so burst payments don't block on the 10-block maturity).
- **contracts/escrow-claim** — Cairo `privacy_invoke` helper: Deposit(commitment) / Claim(secret) / **Refund(after expiry)** ← our extension over the reference.
- **apps/dashboard** — Next.js owner panel: balances, activity, policy editor, viewing-key spend report export.

## Payment flow (happy path)
1. Agent calls `pay_private{recipient, token, amount, memo, idempotency_key}`
2. Idempotency check → policy `decide` → (reservation held)
3. If `needs_approval`: Telegram ticket; on approve continue, else release+deny
4. core: select mature notes (ladder) → build transfer → prove (`provingBlockId = head-10`) → submit (`tip: 0n`) → waitForTransaction
5. Commit reservation, log decision+receipt, return receipt `{status, txHash?, private: true}`

## Security model (summary)
LLM never sees: private key, viewing key, raw secrets. Claim-link secrets: CSPRNG server-side, shown once, only hash persisted. Fail-closed everywhere. Policy state is the source of truth; MCP is untrusted input.

## Failure modes
Proving down → queue + surface status; approvals down → deny; RPC flaky → retry w/ backoff, idempotency prevents double-send; note immature → ladder fallback or explicit "come back in N blocks" receipt.
